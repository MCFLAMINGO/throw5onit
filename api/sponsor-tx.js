// Vercel serverless — co-signs an escrow TIP20 transfer as EXECUTOR feePayer
// POST body: { fromPK, to, tokenAddr, amount }
//   - fromPK    : private key of the escrow wallet (ephemeral — fresh wallet per bet)
//   - to        : recipient address
//   - tokenAddr : USDC or pathUSD TIP20 address
//   - amount    : USD amount (string or number) — converted to 6-decimal units
//
// The server uses TEMPO_EXECUTOR_PK from env to pay gas on behalf of the escrow wallet,
// which typically has no pathUSD and therefore cannot pay Tempo's state-creation fee.
//
// Returns { hash, blockNumber } on success.

const TEMPO_RPC      = process.env.TEMPO_RPC || 'https://tempo-mainnet.core.chainstack.com/b6e3587d839ae0350e2a75f3aac441b2';
const USDC_ADDR      = '0x20c000000000000000000000b9537d11c60e8b50';
const PATHUSD_ADDR   = '0x20c0000000000000000000000000000000000000';
const TEMPO_FEE_RATE = 0.000455;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  const executorPKRaw = process.env.TEMPO_EXECUTOR_PK;
  if (!executorPKRaw) return res.status(500).json({ error: 'executor not configured' });
  const executorPK = ('0x' + executorPKRaw.replace(/\s/g, '').replace(/^0x/, '')).toLowerCase();

  const { fromPK, to, amount } = req.body || {};
  let { tokenAddr } = req.body || {};
  if (!fromPK || !to || amount == null) {
    return res.status(400).json({ error: 'missing fromPK, to, or amount' });
  }

  const amtNum = Number(amount);
  if (!(amtNum > 0)) return res.status(400).json({ error: 'amount must be > 0' });

  // Normalize
  const escrowPK = ('0x' + fromPK.replace(/\s/g, '').replace(/^0x/, '')).toLowerCase();
  const toAddr   = to.toLowerCase().startsWith('0x') ? to : '0x' + to;

  // tokenAddr='auto' (or omitted): pick whichever token the sender holds —
  // USDC first, pathUSD fallback — mirrors _escrowSend in app.js
  const AUTO = !tokenAddr || tokenAddr === 'auto';
  if (!AUTO) {
    const tokenLc = tokenAddr.toLowerCase();
    if (tokenLc !== USDC_ADDR && tokenLc !== PATHUSD_ADDR) {
      return res.status(400).json({ error: 'tokenAddr must be USDC, pathUSD, or auto' });
    }
    tokenAddr = tokenLc;
  }

  let createClient, http, parseAbi, privateKeyToAccount, tempoMainnet, Actions;
  try {
    ({ createClient, http, parseAbi } = await import('viem'));
    ({ privateKeyToAccount }          = await import('viem/accounts'));
    ({ tempoMainnet }                 = await import('viem/chains'));
    ({ Actions }                      = await import('viem/tempo'));
  } catch (e) {
    return res.status(500).json({ error: 'viem import failed: ' + e.message });
  }

  try {
    const escrowAcc   = privateKeyToAccount(escrowPK);
    const executorAcc = privateKeyToAccount(executorPK);

    // feeToken = pathUSD (native fee token for Tempo — EXECUTOR holds pathUSD)
    const chain = tempoMainnet;

    const client = createClient({
      chain,
      transport: http(TEMPO_RPC),
      account: escrowAcc,
    });

    const TIP20_ABI = parseAbi([
      'function transfer(address to, uint256 amount) returns (bool)',
      'function balanceOf(address owner) view returns (uint256)',
    ]);
    const { readContract } = await import('viem/actions');

    // Helper: read one token balance
    async function readBal(tkn) {
      const raw = await readContract(client, { address: tkn, abi: TIP20_ABI, functionName: 'balanceOf', args: [escrowAcc.address] });
      return Number(raw);
    }

    // Helper: execute one leg
    async function doTransfer(tkn, amtRaw) {
      if (amtRaw <= 0n) return null;
      const result = await Actions.token.transferSync(client, {
        token: tkn,
        to: toAddr,
        amount: amtRaw,
        feePayer: executorAcc,
        feeToken: PATHUSD_ADDR,
      });
      return result?.receipt?.transactionHash || result?.receipt?.hash || null;
    }

    // Determine which token(s) to use
    let hashes = [];
    let remaining = amtNum;

    if (AUTO) {
      // USDC first, pathUSD fallback — mirrors _escrowSend in app.js
      const [usdcRaw, pathRaw] = await Promise.all([readBal(USDC_ADDR), readBal(PATHUSD_ADDR)]);
      const usdcSendable = usdcRaw / 1e6 / (1 + TEMPO_FEE_RATE);
      const pathSendable = pathRaw / 1e6 / (1 + TEMPO_FEE_RATE);

      if (usdcSendable >= 0.0001 && remaining > 0) {
        const take    = Math.min(usdcSendable, remaining);
        const takeRaw = BigInt(Math.floor(take * 1e6));
        const h = await doTransfer(USDC_ADDR, takeRaw);
        if (h) { hashes.push(h); remaining -= take; }
      }
      if (remaining >= 0.0001 && pathSendable >= 0.0001) {
        const take    = Math.min(pathSendable, remaining);
        const takeRaw = BigInt(Math.floor(take * 1e6));
        const h = await doTransfer(PATHUSD_ADDR, takeRaw);
        if (h) { hashes.push(h); remaining -= take; }
      }
      if (hashes.length === 0) {
        return res.status(400).json({ error: 'insufficient balance in both USDC and pathUSD' });
      }
    } else {
      // Explicit token — clamp to available balance
      const rawBal  = await readBal(tokenAddr);
      const sendable = rawBal / 1e6 / (1 + TEMPO_FEE_RATE);
      const take    = Math.min(sendable, amtNum);
      const takeRaw = BigInt(Math.floor(take * 1e6));
      if (takeRaw <= 0n) return res.status(400).json({ error: 'escrow balance insufficient for requested amount' });
      const h = await doTransfer(tokenAddr, takeRaw);
      if (h) hashes.push(h);
    }

    const hash  = hashes[0] || null;
    const block = null; // block not critical for response
    return res.status(200).json({ ok: true, hash, hashes, blockNumber: block });
  } catch (e) {
    console.error('[sponsor-tx] failed:', e);
    return res.status(500).json({ error: (e && (e.shortMessage || e.message)) || 'unknown' });
  }
}
