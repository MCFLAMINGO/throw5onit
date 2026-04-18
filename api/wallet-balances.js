// Vercel serverless — returns on-chain balances for THROW system wallets.
// GET /api/wallet-balances
//
// Public endpoint (balances are on-chain). Used by swarm dashboard and the
// /api/refill-agents endpoint to decide who needs a top-up.

const TEMPO_RPC    = process.env.TEMPO_RPC || 'https://tempo-mainnet.core.chainstack.com/b6e3587d839ae0350e2a75f3aac441b2';
const USDC_ADDR    = '0x20c000000000000000000000b9537d11c60e8b50';
const PATHUSD_ADDR = '0x20c0000000000000000000000000000000000000';

const WALLETS = {
  TREASURY: { address: '0x774f484192Cf3F4fB9716Af2e15f44371fD32FEA', min: 0      },
  HOST:     { address: '0x2AD9466623d48B33adc3093DDfe41247B1e8b0d5', min: 2.00   },
  PLAYER:   { address: '0x592b6eEbd4C99b49Cf23f722E4F62FAEf4cD044d', min: 2.00   },
  EXECUTOR: { address: '0xca550eDD527C353F1Bb88619fb58eb65d7c222d4', min: 8.00   },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'GET only' });

  try {
    const { createPublicClient, http, parseAbi } = await import('viem');
    const { tempoMainnet }                        = await import('viem/chains');

    const client = createPublicClient({ chain: tempoMainnet, transport: http(TEMPO_RPC) });
    const abi    = parseAbi(['function balanceOf(address owner) view returns (uint256)']);

    const entries = Object.entries(WALLETS);
    const calls = entries.flatMap(([, w]) => [
      client.readContract({ address: USDC_ADDR,    abi, functionName: 'balanceOf', args: [w.address] }),
      client.readContract({ address: PATHUSD_ADDR, abi, functionName: 'balanceOf', args: [w.address] }),
    ]);
    const results = await Promise.all(calls);

    const wallets = {};
    for (let i = 0; i < entries.length; i++) {
      const [name, w] = entries[i];
      const usdc    = Number(results[i * 2])     / 1e6;
      const pathUSD = Number(results[i * 2 + 1]) / 1e6;
      const total   = usdc + pathUSD;
      wallets[name] = {
        address: w.address,
        usdc: Number(usdc.toFixed(6)),
        pathUSD: Number(pathUSD.toFixed(6)),
        total: Number(total.toFixed(6)),
      };
      if (w.min > 0) wallets[name].needsRefill = total < w.min;
    }

    return res.status(200).json({ ok: true, wallets, timestamp: new Date().toISOString() });
  } catch (e) {
    console.error('[wallet-balances] failed:', e);
    return res.status(500).json({ error: (e && (e.shortMessage || e.message)) || 'unknown' });
  }
}
