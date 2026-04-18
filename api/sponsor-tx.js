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

  const { fromPK, to, tokenAddr, amount } = req.body || {};
  if (!fromPK || !to || !tokenAddr || amount == null) {
    return res.status(400).json({ error: 'missing fromPK, to, tokenAddr, or amount' });
  }

  const amtNum = Number(amount);
  if (!(amtNum > 0)) return res.status(400).json({ error: 'amount must be > 0' });

  // Normalize
  const escrowPK = ('0x' + fromPK.replace(/\s/g, '').replace(/^0x/, '')).toLowerCase();
  const toAddr   = to.toLowerCase().startsWith('0x') ? to : '0x' + to;
  const tokenLc  = tokenAddr.toLowerCase();
  if (tokenLc !== USDC_ADDR && tokenLc !== PATHUSD_ADDR) {
    return res.status(400).json({ error: 'tokenAddr must be USDC or pathUSD' });
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

    // Cap at sendable given Tempo's per-tx protocol fee charged on top of transfer amount
    const TIP20_ABI = parseAbi([
      'function transfer(address to, uint256 amount) returns (bool)',
      'function balanceOf(address owner) view returns (uint256)',
    ]);

    // Read current balance to clamp
    const { readContract } = await import('viem/actions');
    const rawBal = await readContract(client, {
      address: tokenLc,
      abi: TIP20_ABI,
      functionName: 'balanceOf',
      args: [escrowAcc.address],
    });

    let amountRaw = BigInt(Math.round(amtNum * 1e6));
    const maxSend = BigInt(Math.floor(Number(rawBal) / (1 + TEMPO_FEE_RATE)));
    if (amountRaw > maxSend) amountRaw = maxSend;
    if (amountRaw <= 0n) return res.status(400).json({ error: 'escrow balance insufficient for requested amount' });

    // Execute Tempo transferSync with EXECUTOR as feePayer
    const result = await Actions.token.transferSync(client, {
      token: tokenLc,
      to: toAddr,
      amount: amountRaw,
      feePayer: executorAcc,
      feeToken: PATHUSD_ADDR,
    });

    const hash = result?.receipt?.transactionHash || result?.receipt?.hash || null;
    const block = result?.receipt?.blockNumber != null
      ? String(result.receipt.blockNumber)
      : null;

    return res.status(200).json({ ok: true, hash, blockNumber: block });
  } catch (e) {
    console.error('[sponsor-tx] failed:', e);
    return res.status(500).json({ error: (e && (e.shortMessage || e.message)) || 'unknown' });
  }
}
