#!/usr/bin/env node
/** Throw credit dedupe — explains/fixes $5 → $69 / $100 multi-credit */

function creditDedupeKey(data) {
  if (!data) return '';
  if (data.hash) return 'h:' + String(data.hash).toLowerCase();
  if (data.throwId) return 't:' + String(data.throwId);
  const from = (data.from || '').toLowerCase();
  const amt = Number(data.amount) || 0;
  const bucket = Math.floor((Number(data.ts) || Date.now()) / 8000);
  return 'f:' + from + ':' + amt.toFixed(4) + ':' + bucket;
}

function simulateCredits(events) {
  const seen = new Set();
  let balance = 50;
  for (const ev of events) {
    // Only demo_credit mutates balance (proximity_throw is UI-only)
    if (ev.event !== 'demo_credit') continue;
    const key = creditDedupeKey(ev);
    if (seen.has(key)) continue;
    seen.add(key);
    balance = Math.round((balance + Number(ev.amount)) * 1e6) / 1e6;
  }
  return balance;
}

function splitSendRemainder(netAmount, usdcBal) {
  // Bug was: remainder = netAmount - state.usdc AFTER transfer zeroed usdc
  const usdcPart = usdcBal;
  return Math.round((netAmount - usdcPart) * 1e6) / 1e6;
}

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } }

console.log('1) One $5 demo throw = one credit (net after 1% fee)');
{
  const hash = '0xDEMOABC';
  const throwId = 'abc123';
  const net = 4.95;
  // Old bug: proximity + demo_credit + notify proximity + relay = 4 credits
  const events = [
    { event: 'proximity_throw', amount: 5, throwId, from: '0xA', ts: 1000 },
    { event: 'demo_credit', amount: net, hash, throwId, from: '0xA', ts: 1001 },
    { event: 'proximity_throw', amount: 5, throwId, from: '0xA', ts: 1002 },
    { event: 'proximity_throw', amount: 5, throwId, from: '0xA', ts: 1003 },
  ];
  const bal = simulateCredits(events);
  assert(bal === 54.95, 'balance 50 + 4.95 = 54.95, not ~69');
}

console.log('2) Duplicate demo_credit with same hash ignored');
{
  const events = [
    { event: 'demo_credit', amount: 4.95, hash: '0xSAME', from: '0xA', ts: 1 },
    { event: 'demo_credit', amount: 4.95, hash: '0xSAME', from: '0xA', ts: 2 },
    { event: 'demo_credit', amount: 4.95, hash: '0xSAME', from: '0xA', ts: 3 },
  ];
  assert(simulateCredits(events) === 54.95, 'only one credit');
}

console.log('3) Two real distinct throws credit twice');
{
  const events = [
    { event: 'demo_credit', amount: 4.95, hash: '0x1', from: '0xA', ts: 1 },
    { event: 'demo_credit', amount: 4.95, hash: '0x2', from: '0xB', ts: 2 },
  ];
  assert(simulateCredits(events) === 59.9, '50 + 4.95 + 4.95');
}

console.log('4) Split-send remainder uses snapshot');
{
  const remainder = splitSendRemainder(4.95, 3);
  assert(remainder === 1.95, '3 USDC + 1.95 pathUSD');
  // Old bug would use usdc=0 after refresh → remainder 4.95 → overpay 7.95
  assert(3 + remainder === 4.95, 'total equals net');
}

console.log('5) Dedupe keys prefer hash then throwId');
{
  assert(creditDedupeKey({ hash: '0xAb' }) === 'h:0xab', 'hash key');
  assert(creditDedupeKey({ throwId: 'xyz' }) === 't:xyz', 'throwId key');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
