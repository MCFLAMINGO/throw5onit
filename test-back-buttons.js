#!/usr/bin/env node
/** Ensure demo-critical screens expose a clear back / wallet escape. */
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const app = fs.readFileSync(__dirname + '/app.js', 'utf8');

const required = [
  'dock-back',
  'throw-back',
  'bet-setup-back',
  'poker-setup-back',
  'poker-table-back',
  'qr-back',
  'pot-back',
  'player-bet-back',
  'settled-back',
  'claim-back',
  'merchant-back',
  'merchant-setup-back',
  'first-scan-back',
  'setup-solo-back',
  'contact-overlay-close',
  'my-profile-close',
  'points-modal-close',
];

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } }

console.log('1) Back button elements exist in HTML');
for (const id of required) {
  assert(html.includes('id="' + id + '"'), id);
}

console.log('2) Labels say Wallet / Back (not cryptic Leave/X only)');
{
  assert(/id="poker-table-back"[^>]*>\s*← Wallet/.test(html), 'poker table → Wallet');
  assert(/id="pot-back"[^>]*>\s*← Wallet/.test(html), 'pot → Wallet');
  assert(/id="player-bet-back"[^>]*>\s*← Wallet/.test(html), 'player bet → Wallet');
  assert(/id="contact-overlay-close"[^>]*>\s*← Back/.test(html), 'contact overlay ← Back');
}

console.log('3) Handlers wired in app.js');
{
  assert(app.includes("getElementById('pot-back')"), 'pot-back wired');
  assert(app.includes("getElementById('player-bet-back')"), 'player-bet-back wired');
  assert(app.includes("getElementById('claim-back')"), 'claim-back wired');
  assert(app.includes("getElementById('setup-solo-back')"), 'setup-solo-back wired');
  assert(app.includes("getElementById('merchant-back')"), 'merchant-back wired');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
