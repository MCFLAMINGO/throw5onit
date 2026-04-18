// Vercel serverless — tops up HOST, PLAYER, and EXECUTOR agent wallets from
// TREASURY when they drop below minimum balance thresholds.
//
// POST /api/refill-agents (no body required)
//
// Treasury is a funded known wallet (nonce > 0, holds pathUSD) so it pays
// its own Tempo fees naturally. Plain viem writeContract — no Tempo Transaction
// wrapper, no feePayer, no sponsorship. This is purely internal ops funding,
// nothing to do with the THROW bet flow.
//
// Rules:
//   HOST/PLAYER: min $2, top-up to $10, prefer USDC (fall back to pathUSD)
//   EXECUTOR:    min $8, top-up to $15, pathUSD ONLY

const TEMPO_RPC    = process.env.TEMPO_RPC || 'https://tempo-mainnet.core.chainstack.com/b6e3587d839ae0350e2a75f3aac441b2';
const USDC_ADDR    = '0x20c000000000000000000000b9537d11c60e8b50';
const PATHUSD_ADDR = '0x20c0000000000000000000000000000000000000';
const TREASURY_ADDR = '0x774f484192Cf3F4fB9716Af2e15f44371fD32FEA';
const TEMPO_FEE_RATE = 0.000455;

const TARGETS = [
  { name: 'HOST',     address: '0x2AD9466623d48B33adc3093DDfe41247B1e8b0d5', min: 2.00, topUp: 10.00, token: 'USDC'    },
  { name: 'PLAYER',   address: '0x592b6eEbd4C99b49Cf23f722E4F62FAEf4cD044d', min: 2.00, topUp: 10.00, token: 'USDC'    },
  { name: 'EXECUTOR', address: '0xca550eDD527C353F1Bb88619fb58eb65d7c222d4', min: 8.00, topUp: 15.00, token: 'pathUSD' },
];

const TIP20_ABI = [
  { name: 'transfer',   type: 'function', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { name: 'balanceOf',  type: 'function', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  const rawPK = process.env.THROW_TREASURY_PK;
  if (!rawPK) return res.status(500).json({ error: 'treasury not configured' });
  const treasuryPK = ('0x' + rawPK.replace(/\s/g, '').replace(/^0x/, ''));

  let createPublicClient, createWalletClient, http, privateKeyToAccount, tempoMainnet;
  try {
    ({ createPublicClient, createWalletClient, http } = await import('viem'));
    ({ privateKeyToAccount }                          = await import('viem/accounts'));
    ({ tempoMainnet }                                 = await import('viem/chains'));
  } catch (e) {
    return res.status(500).json({ error: 'viem import failed: ' + e.message });
  }

  try {
    const account     = privateKeyToAccount(treasuryPK);
    const transport   = http(TEMPO_RPC);
    const publicClient  = createPublicClient({ chain: tempoMainnet, transport });
    const walletClient  = createWalletClient({ chain: tempoMainnet, transport, account });

    const balOf = async (addr, tokenAddr) => {
      const raw = await publicClient.readContract({ address: tokenAddr, abi: TIP20_ABI, functionName: 'balanceOf', args: [addr] });
      return { raw, usd: Number(raw) / 1e6 };
    };

    const refills = [];

    for (const t of TARGETS) {
      const [u, p] = await Promise.all([balOf(t.address, USDC_ADDR), balOf(t.address, PATHUSD_ADDR)]);
      const total = u.usd + p.usd;

      if (total >= t.min) {
        refills.push({ wallet: t.name, sent: 0, reason: 'balance sufficient', balance: +total.toFixed(6) });
        continue;
      }

      const deficit = t.topUp - total;

      // Pick token
      let tokenAddr, tokenName;
      if (t.token === 'pathUSD') {
        tokenAddr = PATHUSD_ADDR; tokenName = 'pathUSD';
      } else {
        const tUsdc = await balOf(TREASURY_ADDR, USDC_ADDR);
        const tPath = await balOf(TREASURY_ADDR, PATHUSD_ADDR);
        if (tUsdc.usd >= deficit * (1 + TEMPO_FEE_RATE)) {
          tokenAddr = USDC_ADDR;    tokenName = 'USDC';
        } else if (tPath.usd >= deficit * (1 + TEMPO_FEE_RATE)) {
          tokenAddr = PATHUSD_ADDR; tokenName = 'pathUSD';
        } else {
          refills.push({ wallet: t.name, sent: 0, reason: 'treasury insufficient' });
          continue;
        }
      }

      // Fee headroom: treasury pays Tempo's ~0.0455% on top of every transfer
      const sendUsd  = deficit / (1 + TEMPO_FEE_RATE);
      const amountRaw = BigInt(Math.round(sendUsd * 1e6));
      const tBal = await balOf(TREASURY_ADDR, tokenAddr);
      const maxSend = BigInt(Math.floor(Number(tBal.raw) / (1 + TEMPO_FEE_RATE)));
      const finalRaw = amountRaw > maxSend ? maxSend : amountRaw;

      if (finalRaw <= 0n) {
        refills.push({ wallet: t.name, sent: 0, reason: 'treasury token balance 0' });
        continue;
      }

      try {
        // Plain viem writeContract — treasury pays its own fees, no sponsorship
        const hash = await walletClient.writeContract({
          address: tokenAddr,
          abi: TIP20_ABI,
          functionName: 'transfer',
          args: [t.address, finalRaw],
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        refills.push({ wallet: t.name, sent: +(Number(finalRaw) / 1e6).toFixed(6), token: tokenName, hash: receipt.transactionHash });
      } catch (e) {
        refills.push({ wallet: t.name, sent: 0, reason: 'tx failed: ' + ((e && (e.shortMessage || e.message)) || 'unknown') });
      }
    }

    return res.status(200).json({ ok: true, refills, timestamp: new Date().toISOString() });
  } catch (e) {
    console.error('[refill-agents]', e);
    return res.status(500).json({ error: (e && (e.shortMessage || e.message)) || 'unknown' });
  }
}
