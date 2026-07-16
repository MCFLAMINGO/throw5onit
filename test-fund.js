#!/usr/bin/env node
/** Load-for-tonight / fund helpers — node test-fund.js */

const CAP_USD = 50;

function fundChipText(total, cap) {
  const t = Number(total) || 0;
  const c = Number(cap) || CAP_USD;
  const room = Math.max(0, c - t);
  if (t < 0.01) return 'Empty pocket — load up to $' + c;
  if (t >= 1) return 'Loaded $' + t.toFixed(2) + ' — ready to throw';
  return 'On you now: $' + t.toFixed(2) + ' · room for $' + room.toFixed(2);
}

function buildReceiveShareUrl(origin, name, addr) {
  return String(origin || '') + '/?addName=' + encodeURIComponent(name || '') +
    '&addAddr=' + encodeURIComponent(addr || '');
}

function shouldShowLoadTonight(total, screen) {
  return (Number(total) || 0) < 1 && screen === 'wallet';
}

function parseFundDeepLink(search) {
  try {
    return new URLSearchParams(search || '').get('fund') === '1';
  } catch (_) {
    return false;
  }
}

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } }

console.log('1) Fund chip copy');
{
  assert(fundChipText(0, 50) === 'Empty pocket — load up to $50', 'empty');
  assert(fundChipText(12.5, 50) === 'Loaded $12.50 — ready to throw', 'loaded');
  assert(fundChipText(0.5, 50) === 'On you now: $0.50 · room for $49.50', 'partial under $1');
}

console.log('2) Receive share URL');
{
  const url = buildReceiveShareUrl('https://www.throw5onit.com', 'MIKE', '0xabc');
  assert(url.includes('addName=MIKE'), 'name param');
  assert(url.includes('addAddr=0xabc'), 'addr param');
  assert(url.startsWith('https://www.throw5onit.com/?'), 'origin + query');
}

console.log('3) Load-tonight CTA visibility');
{
  assert(shouldShowLoadTonight(0, 'wallet') === true, 'empty wallet');
  assert(shouldShowLoadTonight(5, 'wallet') === false, 'funded wallet');
  assert(shouldShowLoadTonight(0, 'qr') === false, 'not on wallet screen');
}

console.log('4) ?fund=1 deep link');
{
  assert(parseFundDeepLink('?fund=1') === true, 'fund=1');
  assert(parseFundDeepLink('?foo=1') === false, 'other params');
  assert(parseFundDeepLink('') === false, 'empty');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
