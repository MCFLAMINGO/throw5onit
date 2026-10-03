#!/usr/bin/env node
/** Throw credit dedupe — $5 must stay $5, never stack to $25/$69/$100 */

function creditDedupeKey(data) {
  if (!data) return '';
  if (data.throwId) return 't:' + String(data.throwId);
  if (data.hash) return 'h:' + String(data.hash).toLowerCase();
  const from = (data.from || '').toLowerCase();
  const amt = Number(data.amount) || 0;
  const bucket = Math.floor((Number(data.ts) || Date.now()) / 8000);
  return 'f:' + from + ':' + amt.toFixed(4) + ':' + bucket;
}

function simulateCredits(events) {
  const seen = new Set();
  let balance = 50;
  for (const ev of events) {
    // ONLY demo_credit mutates balance — catch/sonic/mqtt/bc/chain never do
    if (ev.event !== 'demo_credit') continue;
    const key = creditDedupeKey(ev);
    if (seen.has(key)) continue;
    seen.add(key);
    balance = Math.round((balance + Number(ev.amount)) * 1e6) / 1e6;
  }
  return balance;
}

function demoFaceTransfer(senderBal, receiverBal, face) {
  // Demo: no fee — face in = face out, totals conserved
  return {
    sender: Math.round((senderBal - face) * 1e6) / 1e6,
    receiver: Math.round((receiverBal + face) * 1e6) / 1e6,
    sum: Math.round((senderBal + receiverBal) * 1e6) / 1e6,
  };
}

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } }

console.log('1) One $5 demo throw = one +$5 credit (face value)');
{
  const hash = '0xDEMOABC';
  const throwId = 'abc123';
  const events = [
    { event: 'proximity_throw', amount: 5, throwId, from: '0xA', ts: 1000 },
    { event: 'demo_credit', amount: 5, hash, throwId, from: '0xA', ts: 1001 },
    { event: 'proximity_throw', amount: 5, throwId, from: '0xA', ts: 1002 },
    { event: 'throw_credit', amount: 5, throwId, from: '0xA', ts: 1003 },
    // catch/sonic/chain ghosts — must NOT credit
    { event: 'catch_ui', amount: 5, from: 'nearby', ts: 1004 },
  ];
  const bal = simulateCredits(events);
  assert(bal === 55, 'balance 50 + 5 = 55, not ~69');
}

console.log('2) Duplicate demo_credit same throwId ignored even if hash differs');
{
  const events = [
    { event: 'demo_credit', amount: 5, hash: '0xAAAA', throwId: 'same1', from: '0xA', ts: 1 },
    { event: 'demo_credit', amount: 5, hash: '0xBBBB', throwId: 'same1', from: '0xA', ts: 2 },
    { event: 'demo_credit', amount: 5, hash: '0xCCCC', throwId: 'same1', from: '0xA', ts: 3 },
  ];
  assert(simulateCredits(events) === 55, 'throwId wins — only one credit');
}

console.log('3) Two real distinct throws credit twice');
{
  const events = [
    { event: 'demo_credit', amount: 5, hash: '0x1', throwId: 't1', from: '0xA', ts: 1 },
    { event: 'demo_credit', amount: 5, hash: '0x2', throwId: 't2', from: '0xB', ts: 2 },
  ];
  assert(simulateCredits(events) === 60, '50 + 5 + 5');
}

console.log('4) Father→son $5 conserves totals (no fee in demo)');
{
  const before = 50 + 50;
  const r = demoFaceTransfer(50, 50, 5);
  assert(r.sender === 45, 'father 45');
  assert(r.receiver === 55, 'son 55');
  assert(r.sender + r.receiver === before, '100 conserved');
}

console.log('5) Stacked side-channels cannot inflate');
{
  // Simulate old bug: demo_credit + catch poll + sonic each trying to add
  const events = [
    { event: 'demo_credit', amount: 5, throwId: 'x1', hash: '0xh', from: '0xA', ts: 1 },
    { event: 'demo_credit', amount: 5, throwId: 'x1', hash: '0xh2', from: 'on-chain', ts: 2 },
    { event: 'demo_credit', amount: 5, throwId: 'x1', from: 'nearby', ts: 3 },
  ];
  assert(simulateCredits(events) === 55, 'side channels with same throwId ignored');
}

console.log('6) Dedupe prefers throwId over hash');
{
  assert(creditDedupeKey({ throwId: 'xyz', hash: '0xAb' }) === 't:xyz', 'throwId first');
  assert(creditDedupeKey({ hash: '0xAb' }) === 'h:0xab', 'hash fallback');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
