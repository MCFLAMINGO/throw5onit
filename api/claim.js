// GET /api/claim?id=…  — fetch retained claim metadata (no escrowKey)
// POST /api/claim      — { action: 'create'|'redeem', … }
//
// Create: client already funded escrow; this re-publishes retained claim (backup).
// Redeem: server drains escrow → toAddr via sponsor-tx path, clears claim.

const BROKER = 'wss://broker.emqx.io:8084/mqtt';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function mqttPublish(topic, payload, opts = {}) {
  const mqtt = (await import('mqtt')).default;
  await new Promise((resolve, reject) => {
    const c = mqtt.connect(BROKER, {
      clientId: 'claim_' + Math.random().toString(36).slice(2, 8),
      clean: true, connectTimeout: 6000, reconnectPeriod: 0,
    });
    const t = setTimeout(() => { try { c.end(true); } catch (_) {} reject(new Error('timeout')); }, 8000);
    c.on('connect', () => {
      c.publish(topic, payload, { qos: 1, retain: !!opts.retain }, (err) => {
        clearTimeout(t);
        try { c.end(true); } catch (_) {}
        if (err) reject(err); else resolve();
      });
    });
    c.on('error', (e) => { clearTimeout(t); try { c.end(true); } catch (_) {} reject(e); });
  });
}

async function mqttGetRetained(topic, waitMs = 5000) {
  const mqtt = (await import('mqtt')).default;
  return await new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { c.end(true); } catch (_) {}
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), waitMs);
    const c = mqtt.connect(BROKER, {
      clientId: 'claimr_' + Math.random().toString(36).slice(2, 8),
      clean: true, connectTimeout: 5000, reconnectPeriod: 0,
    });
    c.on('connect', () => c.subscribe(topic, { qos: 1 }));
    c.on('message', (t, buf) => {
      if (t !== topic) return;
      const raw = buf.toString();
      if (!raw) return finish(null);
      try { finish(JSON.parse(raw)); } catch (_) { finish(null); }
    });
    c.on('error', () => finish(null));
  });
}

function publicClaim(rec) {
  if (!rec) return null;
  const { escrowKey, ...rest } = rec;
  return {
    ...rest,
    hasEscrow: !!escrowKey,
  };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET') {
    const id = (url.searchParams.get('id') || '').toLowerCase();
    if (!/^[a-f0-9]{16,64}$/.test(id)) return res.status(400).json({ error: 'bad id' });
    const rec = await mqttGetRetained('throw5/claims/' + id);
    if (!rec) return res.status(404).json({ error: 'not found' });
    return res.status(200).json({ ok: true, claim: publicClaim(rec) });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const body = req.body || {};
  const action = body.action || 'create';

  if (action === 'create') {
    const claimId = String(body.claimId || '').toLowerCase();
    if (!/^[a-f0-9]{16,64}$/.test(claimId)) return res.status(400).json({ error: 'bad claimId' });
    if (!body.escrowKey || !body.escrowAddr || !(Number(body.amount) > 0)) {
      return res.status(400).json({ error: 'missing escrow or amount' });
    }
    const record = {
      event: 'claim_open',
      claimId,
      amount: Number(body.amount),
      netAmount: Number(body.netAmount || body.amount),
      escrowAddr: body.escrowAddr,
      escrowKey: body.escrowKey,
      from: body.from,
      fromName: body.fromName || '',
      toHint: body.toHint || null,
      memo: body.memo || null,
      status: 'open',
      demo: !!body.demo,
      createdAt: body.createdAt || Date.now(),
      expiresAt: body.expiresAt || (Date.now() + 7 * 24 * 60 * 60 * 1000),
    };
    await mqttPublish('throw5/claims/' + claimId, JSON.stringify(record), { retain: true });
    return res.status(200).json({ ok: true, claimId, url: '/c/' + claimId });
  }

  if (action === 'redeem') {
    // Prefer client-side redeem (has sponsor-tx). Server redeem needs TEMPO_EXECUTOR_PK
    // and would duplicate sponsor-tx — keep as status helper only unless escrowKey provided
    // by authorized client. For security, redeem stays client-side via claim.js.
    return res.status(400).json({
      error: 'redeem_on_client',
      hint: 'Use in-app redeemOpenClaim(claimId, address)',
    });
  }

  return res.status(400).json({ error: 'unknown action' });
}
