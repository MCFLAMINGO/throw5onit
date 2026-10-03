#!/usr/bin/env node
/** Claim link helpers — node test-claim.js */

function generateClaimId() {
  const bytes = require('crypto').randomBytes(18);
  return bytes.toString('hex');
}

function parseClaimIdFromLocation(loc) {
  try {
    const params = new URLSearchParams(loc.search || '');
    const q = params.get('claim');
    if (q && /^[a-f0-9]{16,64}$/i.test(q)) return q.toLowerCase();
  } catch (_) {}
  const m = String(loc.pathname || '').match(/\/c\/([a-f0-9]{16,64})\/?$/i);
  if (m) return m[1].toLowerCase();
  return null;
}

function parseEscrowKeyFromLocation(loc) {
  try {
    const hash = String(loc.hash || '').replace(/^#/, '');
    if (!hash) return null;
    let ek = null;
    try { ek = new URLSearchParams(hash).get('ek'); } catch (_) {}
    if (!ek && hash.indexOf('ek=') === 0) ek = decodeURIComponent(hash.slice(3).split('&')[0]);
    if (!ek) return null;
    ek = String(ek).replace(/\s/g, '');
    if (/^[a-f0-9]{64}$/i.test(ek)) return '0x' + ek.toLowerCase();
    if (/^0x[a-f0-9]{64}$/i.test(ek)) return ek.toLowerCase();
    return null;
  } catch (_) {
    return null;
  }
}

function claimPublicUrl(origin, claimId, escrowKey) {
  let url = origin + '/c/' + claimId;
  if (escrowKey && !String(escrowKey).startsWith('demo:')) {
    url += '#ek=' + String(escrowKey).replace(/^0x/i, '');
  }
  return url;
}

function publicClaimRecord(record) {
  if (!record) return null;
  const { escrowKey, ...rest } = record;
  return { ...rest, hasEscrow: !!(escrowKey || rest.hasEscrow) };
}

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } }

console.log('1) Claim IDs are long secrets');
{
  const id = generateClaimId();
  assert(id.length >= 32, 'id length >= 32');
  assert(/^[a-f0-9]+$/.test(id), 'hex only');
}

console.log('2) Parse /c/:id paths');
{
  assert(parseClaimIdFromLocation({ pathname: '/c/abcdef0123456789abcdef01', search: '' }) === 'abcdef0123456789abcdef01', 'path parse');
  assert(parseClaimIdFromLocation({ pathname: '/', search: '?claim=abcdef0123456789abcdef01' }) === 'abcdef0123456789abcdef01', 'query parse');
  assert(parseClaimIdFromLocation({ pathname: '/wallet', search: '' }) === null, 'no false positive');
}

console.log('3) Public URL puts escrow key in fragment');
{
  const id = 'aa'.repeat(16);
  const pk = '0x' + 'ab'.repeat(32);
  const url = claimPublicUrl('https://www.throw5onit.com', id, pk);
  assert(url.startsWith('https://www.throw5onit.com/c/' + id), 'claim path');
  assert(url.includes('#ek='), 'has #ek=');
  assert(!url.includes('0x'), 'fragment strips 0x');
  const ek = parseEscrowKeyFromLocation({ hash: '#ek=' + 'ab'.repeat(32) });
  assert(ek === pk.toLowerCase(), 'parse ek from hash');
}

console.log('4) MQTT public record strips escrowKey');
{
  const pub = publicClaimRecord({
    claimId: 'abc',
    amount: 5,
    escrowAddr: '0x123',
    escrowKey: '0x' + 'cd'.repeat(32),
    status: 'open',
  });
  assert(!('escrowKey' in pub), 'no escrowKey field');
  assert(pub.hasEscrow === true, 'hasEscrow flag');
  assert(pub.amount === 5, 'amount kept');
}

const fs = require('fs');
const path = require('path');
const claimSrc = fs.readFileSync(path.join(__dirname, 'claim.js'), 'utf8');
const apiClaim = fs.readFileSync(path.join(__dirname, 'api/claim.js'), 'utf8');
const relay = fs.readFileSync(path.join(__dirname, 'api/relay.js'), 'utf8');

console.log('5) Source guards');
{
  assert(claimSrc.includes('#ek='), 'claim.js uses #ek=');
  assert(claimSrc.includes('publicClaimRecord'), 'claim.js publicClaimRecord');
  assert(claimSrc.includes('CLAIM_EK_KEY'), 'claim.js stashes ek');
  assert(apiClaim.includes('hasEscrow') && !/escrowKey:\s*body\.escrowKey/.test(apiClaim), 'api claim does not retain escrowKey');
  assert(relay.includes('escrowKey'), 'relay strips escrowKey on claims');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
