// Vercel serverless function — relays throw payloads to MQTT broker
// Phone POSTs here via fetch (always works), server publishes to MQTT

const mqtt = require('mqtt');

const BROKER = 'wss://broker.emqx.io:8084/mqtt';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { to, from, fromName, amount, throwId, event = 'proximity_throw', topic: explicitTopic } = req.body || {};

  // Allow explicit topic for bet_join and other room events
  const topic = explicitTopic || (to ? 'throw5/wallet/' + to.toLowerCase() + '/credit' : null);
  if (!topic) return res.status(400).json({ error: 'missing topic or to' });
  if (!explicitTopic && !amount) return res.status(400).json({ error: 'missing amount' });

  const payload = explicitTopic
    ? JSON.stringify(req.body)   // pass through as-is for room events
    : JSON.stringify({ event, to, from, fromName, amount, throwId, ts: Date.now() });

  await new Promise((resolve, reject) => {
    const c = mqtt.connect(BROKER, {
      clientId: 'relay_' + Math.random().toString(36).slice(2,8),
      clean: true, connectTimeout: 6000, reconnectPeriod: 0
    });
    const timeout = setTimeout(() => { try { c.end(true); } catch(_){} reject(new Error('timeout')); }, 8000);
    c.on('connect', () => {
      c.publish(topic, payload, { qos: 1 }, () => {
        clearTimeout(timeout);
        try { c.end(true); } catch(_) {}
        resolve();
      });
    });
    c.on('error', (e) => { clearTimeout(timeout); try { c.end(true); } catch(_){} reject(e); });
  });

  return res.status(200).json({ ok: true, topic });
}
