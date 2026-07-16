// Vercel serverless — relays payloads to MQTT (throws, claims, room events)
const mqtt = require('mqtt');

const BROKER = 'wss://broker.emqx.io:8084/mqtt';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = req.body || {};
  const {
    to, from, fromName, amount, throwId,
    event = 'proximity_throw',
    topic: explicitTopic,
    retain = false,
    clear = false,
  } = body;

  const topic = explicitTopic || (to ? 'throw5/wallet/' + String(to).toLowerCase() + '/credit' : null);
  if (!topic) return res.status(400).json({ error: 'missing topic or to' });
  if (!explicitTopic && !amount && !clear) return res.status(400).json({ error: 'missing amount' });

  let payload;
  if (clear) {
    payload = '';
  } else if (explicitTopic) {
    // Strip relay-only flags from retained claim bodies
    const { topic: _t, retain: _r, clear: _c, ...rest } = body;
    payload = JSON.stringify(rest);
  } else {
    payload = JSON.stringify({ event, to, from, fromName, amount, throwId, ts: Date.now() });
  }

  const pubOpts = { qos: 1 };
  if (retain || clear) pubOpts.retain = true;

  try {
    await new Promise((resolve, reject) => {
      const c = mqtt.connect(BROKER, {
        clientId: 'relay_' + Math.random().toString(36).slice(2, 8),
        clean: true, connectTimeout: 6000, reconnectPeriod: 0,
      });
      const timeout = setTimeout(() => {
        try { c.end(true); } catch (_) {}
        reject(new Error('timeout'));
      }, 8000);
      c.on('connect', () => {
        c.publish(topic, payload, pubOpts, (err) => {
          clearTimeout(timeout);
          try { c.end(true); } catch (_) {}
          if (err) reject(err); else resolve();
        });
      });
      c.on('error', (e) => {
        clearTimeout(timeout);
        try { c.end(true); } catch (_) {}
        reject(e);
      });
    });
    return res.status(200).json({ ok: true, topic, retained: !!(retain || clear) });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'relay failed' });
  }
}
