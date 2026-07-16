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

function claimPublicUrl(origin, claimId) {
  return origin + '/c/' + claimId;
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

console.log('3) Public URL shape');
{
  const url = claimPublicUrl('https://www.throw5onit.com', 'aa'.repeat(16));
  assert(url === 'https://www.throw5onit.com/c/' + 'aa'.repeat(16), 'claim url');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
