// Vercel serverless — tops up HOST, PLAYER, and EXECUTOR agent wallets from
// TREASURY when they drop below their minimum balance thresholds.
//
// POST /api/refill-agents (no body required)
//
// Reads THROW_TREASURY_PK from env. Treasury holds pathUSD and USDC and can pay
// its own Tempo state-creation fee (it has tx history + pathUSD), so transfers
// are signed by treasury directly — no EXECUTOR-sponsored gas needed here.
//
// Rules:
//   HOST/PLAYER: min $2, top-up to $10, prefer USDC (fall back to pathUSD).
//   EXECUTOR:    min $8, top-up to $15, pathUSD ONLY (EXECUTOR pays Tempo fees
//                in pathUSD — sending USDC would defeat the purpose).
//
// Each send applies TEMPO_FEE_RATE = 0.000455 headroom: divide the intended
// amount by (1 + fee) so treasury doesn't over-spend accounting for the fee.

const TEMPO_RPC      = process.env.TEMPO_RPC || 'https://tempo-mainnet.core.chainstack.com/b6e3587d839ae0350e2a75f3aac441b2';
const USDC_ADDR      = '0x20c000000000000000000000b9537d11c60e8b50';
const PATHUSD_ADDR   = '0x20c0000000000000000000000000000000000000';
const TEMPO_FEE_RATE = 0.000455;

const TREASURY_ADDR = '0x774f484192Cf3F4fB9716Af2e15f44371fD32FEA';

const TARGETS = [
  { name: 'HOST',     address: '0x2AD9466623d48B33adc3093DDfe41247B1e8b0d5', min: 2.00, topUp: 10.00, token: 'USDC'    },
  { name: 'PLAYER',   address: '0x592b6eEbd4C99b49Cf23f722E4F62FAEf4cD044d', min: 2.00, topUp: 10.00, token: 'USDC'    },
  { name: 'EXECUTOR', address: '0xca550eDD527C353F1Bb88619fb58eb65d7c222d4', min: 8.00, topUp: 15.00, token: 'pathUSD' },
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  const rawPK = process.env.THROW_TREASURY_PK;
  if (!rawPK) return res.status(500).json({ error: 'treasury not configured' });
  const treasuryPK = ('0x' + rawPK.replace(/\s/g, '').replace(/^0x/, '')).toLowerCase();

  let createClient, createPublicClient, http, parseAbi, privateKeyToAccount, tempoMainnet, Actions, readContract;
  try {
    ({ createClient, createPublicClient, http, parseAbi } = await import('viem'));
    ({ privateKeyToAccount }                              = await import('viem/accounts'));
    ({ tempoMainnet }                                     = await import('viem/chains'));
    ({ Actions }                                          = await import('viem/tempo'));
    ({ readContract }                                     = await import('viem/actions'));
  } catch (e) {
    return res.status(500).json({ error: 'viem import failed: ' + e.message });
  }

  try {
    const treasuryAcc = privateKeyToAccount(treasuryPK);
    const chain       = tempoMainnet;

    const pub = createPublicClient({ chain, transport: http(TEMPO_RPC) });
    const wallet = createClient({ chain, transport: http(TEMPO_RPC), account: treasuryAcc });

    const TIP20_ABI = parseAbi([
      'function transfer(address to, uint256 amount) returns (bool)',
      'function balanceOf(address owner) view returns (uint256)',
    ]);

    const balOf = async (addr, token) => {
      const raw = await pub.readContract({ address: token, abi: TIP20_ABI, functionName: 'balanceOf', args: [addr] });
      return { raw, usd: Number(raw) / 1e6 };
    };

    const refills = [];

    for (const t of TARGETS) {
      // Fetch current totals for the target
      const [u, p] = await Promise.all([balOf(t.address, USDC_ADDR), balOf(t.address, PATHUSD_ADDR)]);
      const total = u.usd + p.usd;

      if (total >= t.min) {
        refills.push({ wallet: t.name, sent: 0, reason: 'balance sufficient', balance: Number(total.toFixed(6)) });
        continue;
      }

      const deficit = t.topUp - total;
      if (deficit <= 0) {
        refills.push({ wallet: t.name, sent: 0, reason: 'no deficit', balance: Number(total.toFixed(6)) });
        continue;
      }

      // Pick token based on policy + treasury balance
      let tokenAddr, tokenName;
      if (t.token === 'pathUSD') {
        tokenAddr = PATHUSD_ADDR;
        tokenName = 'pathUSD';
      } else {
        // Prefer USDC, fall back to pathUSD if treasury can't cover it in USDC
        const treasuryUSDC    = await balOf(TREASURY_ADDR, USDC_ADDR);
        const treasuryPathUSD = await balOf(TREASURY_ADDR, PATHUSD_ADDR);
        if (treasuryUSDC.usd >= deficit * (1 + TEMPO_FEE_RATE)) {
          tokenAddr = USDC_ADDR;
          tokenName = 'USDC';
        } else if (treasuryPathUSD.usd >= deficit * (1 + TEMPO_FEE_RATE)) {
          tokenAddr = PATHUSD_ADDR;
          tokenName = 'pathUSD';
        } else {
          refills.push({ wallet: t.name, sent: 0, reason: 'treasury insufficient', deficit: Number(deficit.toFixed(6)) });
          continue;
        }
      }

      // Apply TEMPO_FEE_RATE headroom: treasury pays fee on top of transfer
      const sendUsd = deficit / (1 + TEMPO_FEE_RATE);
      const amountRaw = BigInt(Math.round(sendUsd * 1e6));
      if (amountRaw <= 0n) {
        refills.push({ wallet: t.name, sent: 0, reason: 'amount rounded to zero' });
        continue;
      }

      // Clamp against treasury balance of the chosen token (account for fee)
      const treasBal = await balOf(TREASURY_ADDR, tokenAddr);
      const maxSend = BigInt(Math.floor(Number(treasBal.raw) / (1 + TEMPO_FEE_RATE)));
      const finalRaw = amountRaw > maxSend ? maxSend : amountRaw;
      if (finalRaw <= 0n) {
        refills.push({ wallet: t.name, sent: 0, reason: 'treasury token balance 0', token: tokenName });
        continue;
      }

      try {
        // Treasury signs + pays fee itself (feePayer = treasuryAcc, feeToken = pathUSD).
        // Treasury holds pathUSD so it can cover the Tempo state-creation fee.
        const result = await Actions.token.transferSync(wallet, {
          token: tokenAddr,
          to: t.address,
          amount: finalRaw,
          feePayer: treasuryAcc,
          feeToken: PATHUSD_ADDR,
        });
        const hash = result?.receipt?.transactionHash || result?.receipt?.hash || null;
        refills.push({
          wallet: t.name,
          sent: Number((Number(finalRaw) / 1e6).toFixed(6)),
          token: tokenName,
          hash,
        });
      } catch (e) {
        refills.push({ wallet: t.name, sent: 0, reason: 'tx failed: ' + ((e && (e.shortMessage || e.message)) || 'unknown') });
      }
    }

    return res.status(200).json({ ok: true, refills, timestamp: new Date().toISOString() });
  } catch (e) {
    console.error('[refill-agents] failed:', e);
    return res.status(500).json({ error: (e && (e.shortMessage || e.message)) || 'unknown' });
  }
}
