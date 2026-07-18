#!/usr/bin/env node
/**
 * Live MQTT 5-player hangout + throw credit smoke test against public broker.
 * Run: node test-5player-mqtt-live.js
 */
const mqtt = require('mqtt');

const BROKER = 'wss://broker.emqx.io:8084/mqtt';
const ROOM = String(1000 + Math.floor(Math.random() * 9000));
const PREFIX = 'throw5/room/' + ROOM + '/';

const NAMES = ['HOST', 'WIFE', 'LEE', 'ERIK', 'SAM'];
const PLAYERS = NAMES.map((name, i) => ({
  name,
  addr: '0x' + String(i + 10).padStart(40, 'a'),
  balance: 50,
  contacts: new Set(),
  credits: [],
}));

function connect(id) {
  return new Promise((resolve, reject) => {
    const c = mqtt.connect(BROKER, {
      clientId: 't5_' + id + '_' + Math.random().toString(36).slice(2, 8),
      clean: true,
      connectTimeout: 12000,
      reconnectPeriod: 0,
    });
    const t = setTimeout(() => reject(new Error('connect timeout ' + id)), 15000);
    c.on('connect', () => { clearTimeout(t); resolve(c); });
    c.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('\n═══ LIVE MQTT 5-PLAYER ═══');
  console.log('Room', ROOM, 'broker', BROKER);

  const clients = [];
  for (const p of PLAYERS) {
    const c = await connect(p.name);
    clients.push({ p, c });
  }
  console.log('  ✓ 5 clients connected');

  // Subscribe all to crew + each wallet credit topic
  await Promise.all(clients.map(({ p, c }) => new Promise((resolve, reject) => {
    const topics = [PREFIX + 'crew', 'throw5/wallet/' + p.addr.toLowerCase() + '/credit'];
    c.subscribe(topics, { qos: 1 }, (err) => err ? reject(err) : resolve());
    c.on('message', (topic, buf) => {
      try {
        const data = JSON.parse(buf.toString() || '{}');
        if (topic.endsWith('/crew') && data.event === 'crew_roster' && Array.isArray(data.members)) {
          data.members.forEach(m => {
            if (m.addr && m.addr.toLowerCase() !== p.addr.toLowerCase()) {
              p.contacts.add(m.addr.toLowerCase() + '|' + (m.name || ''));
            }
          });
        }
        if (topic.includes('/credit') && data.event === 'demo_credit' && data.to &&
            data.to.toLowerCase() === p.addr.toLowerCase()) {
          p.credits.push(data);
          // Only credit once per hash
          if (!p._seen) p._seen = new Set();
          const key = data.hash || data.throwId;
          if (key && !p._seen.has(key)) {
            p._seen.add(key);
            p.balance = Math.round((p.balance + Number(data.amount)) * 1e6) / 1e6;
          }
        }
      } catch (_) {}
    });
  })));
  console.log('  ✓ subscribed to crew + credit topics');

  // Host publishes growing roster as each "joins"
  const host = clients[0];
  const roster = [];
  for (let i = 0; i < clients.length; i++) {
    const { p } = clients[i];
    roster.push({ addr: p.addr, name: p.name });
    const msg = JSON.stringify({
      event: 'crew_roster',
      hostAddr: host.p.addr,
      members: roster.slice(),
      roomCode: ROOM,
      ts: Date.now(),
    });
    await new Promise((resolve, reject) => {
      host.c.publish(PREFIX + 'crew', msg, { qos: 1, retain: true }, (err) => err ? reject(err) : resolve());
    });
    // Joiner also pings crew_join
    if (i > 0) {
      const join = JSON.stringify({ event: 'crew_join', addr: p.addr, name: p.name, ts: Date.now() });
      await new Promise((resolve, reject) => {
        clients[i].c.publish(PREFIX + 'crew', join, { qos: 1 }, (err) => err ? reject(err) : resolve());
      });
    }
    await sleep(250);
  }
  await sleep(1500);

  let meshOk = true;
  for (const { p } of clients) {
    if (p.contacts.size < 4) {
      console.error('  ✗', p.name, 'contacts', p.contacts.size, '(want 4)');
      meshOk = false;
    }
  }
  if (meshOk) console.log('  ✓ hangout mesh: each of 5 has 4 contacts via MQTT roster');

  // HOST throws $5 demo_credit to WIFE (single credit message — correct path)
  const wife = clients[1];
  const net = 4.95;
  const hash = '0xLIVE' + Date.now().toString(16);
  const credit = JSON.stringify({
    event: 'demo_credit',
    to: wife.p.addr,
    from: host.p.addr,
    fromName: 'HOST',
    amount: net,
    hash,
    throwId: 'live1',
    ts: Date.now(),
  });
  // Also spam proximity_throw dupes — receiver logic in app ignores them for balance;
  // our sim only credits demo_credit
  await new Promise((resolve, reject) => {
    host.c.publish(
      'throw5/wallet/' + wife.p.addr.toLowerCase() + '/credit',
      JSON.stringify({ event: 'proximity_throw', to: wife.p.addr, amount: 5, throwId: 'live1', from: host.p.addr }),
      { qos: 1 },
      () => {}
    );
    host.c.publish(
      'throw5/wallet/' + wife.p.addr.toLowerCase() + '/credit',
      credit,
      { qos: 1 },
      (err) => err ? reject(err) : resolve()
    );
  });
  await sleep(1500);

  const wifeBalOk = Math.abs(wife.p.balance - 54.95) < 0.01;
  if (wifeBalOk) console.log('  ✓ live throw credit: WIFE balance', wife.p.balance, '(expect ~54.95)');
  else console.error('  ✗ WIFE balance', wife.p.balance, 'expected ~54.95');

  // Cleanup retained roster
  await new Promise((resolve) => {
    host.c.publish(PREFIX + 'crew', '', { qos: 1, retain: true }, () => resolve());
  });

  for (const { c } of clients) {
    try { c.end(true); } catch (_) {}
  }

  const ok = meshOk && wifeBalOk;
  console.log(ok ? '\nLIVE MQTT: PASS\n' : '\nLIVE MQTT: FAIL\n');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('LIVE MQTT error:', e.message || e);
  process.exit(1);
});
