#!/usr/bin/env node
/** Hangout crew mesh helpers */

function hangoutShareUrl(origin, code) {
  return String(origin || '') + '/?crew=' + encodeURIComponent(code || '');
}

function parseCrewCode(raw) {
  try {
    if (/crew=/i.test(raw)) {
      const u = new URL(raw, 'https://www.throw5onit.com');
      return u.searchParams.get('crew');
    }
  } catch (_) {}
  if (/^\d{4}$/.test(String(raw || '').trim())) return String(raw).trim();
  return null;
}

function mergeCrewRoster(existing, joiner, host) {
  const map = new Map();
  if (host) map.set(host.addr.toLowerCase(), host);
  (existing || []).forEach(m => {
    if (m && m.addr) map.set(m.addr.toLowerCase(), { addr: m.addr, name: m.name });
  });
  if (joiner && joiner.addr) {
    map.set(joiner.addr.toLowerCase(), { addr: joiner.addr, name: joiner.name });
  }
  return Array.from(map.values());
}

function announcePokerStartLine(sbName, bbName, sbAmt, bbAmt) {
  return 'Starting poker. Small blind ' + sbAmt + ', big blind ' + bbAmt + '. ' +
    bbName + ", you're the big blind. " + sbName + ", you're the small blind. " +
    "Let's start. Real cards — deal them out.";
}

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } }

console.log('1) Hangout share URL');
{
  const url = hangoutShareUrl('https://www.throw5onit.com', '4821');
  assert(url === 'https://www.throw5onit.com/?crew=4821', 'crew query');
}

console.log('2) Parse hangout QR / code');
{
  assert(parseCrewCode('https://www.throw5onit.com/?crew=4821') === '4821', 'url');
  assert(parseCrewCode('4821') === '4821', 'digits');
  assert(parseCrewCode('tempo:0xabc') === null, 'not a hangout');
}

console.log('3) Roster mesh grows with each join');
{
  const host = { addr: '0xA', name: 'HOST' };
  let roster = mergeCrewRoster([], null, host);
  assert(roster.length === 1, 'host only');
  roster = mergeCrewRoster(roster, { addr: '0xB', name: 'WIFE' }, host);
  roster = mergeCrewRoster(roster, { addr: '0xC', name: 'LEE' }, host);
  assert(roster.length === 3, 'three at table');
  assert(roster.some(m => m.name === 'WIFE') && roster.some(m => m.name === 'LEE'), 'names present');
}

console.log('4) Poker start announcement');
{
  const line = announcePokerStartLine('Lee', 'Erik', 1, 2);
  assert(/Starting poker/.test(line), 'opener');
  assert(/Erik, you're the big blind/.test(line), 'BB name');
  assert(/Lee, you're the small blind/.test(line), 'SB name');
  assert(/Let's start/.test(line), 'let\'s start');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
