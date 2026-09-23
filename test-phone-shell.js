#!/usr/bin/env node
/** Phone-only shell on desktop — node test-phone-shell.js */
const fs = require('fs');
const path = require('path');
const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } }

console.log('1) Desktop phone shell');
{
  assert(/@media \(min-width:\s*520px\)/.test(css), 'min-width 520px breakpoint');
  assert(css.includes('--phone-w: 390px'), 'phone width 390px');
  assert(css.includes('PHONE VIEW') || css.includes('phone PWA'), 'phone-view framing copy/comment');
  assert(css.includes('.screen,') || /\.screen,\s*\n\s*\.my-profile-modal/.test(css), 'screens constrained');
  assert(css.includes('border-radius: 28px'), 'device rounded frame');
  assert(css.includes('position: absolute') && css.includes('.screen > .back-btn'), 'back btn absolute in frame');
}

console.log('2) SW bumped for clients');
{
  const m = sw.match(/VERSION = 'v(\d+)'/);
  assert(m && Number(m[1]) >= 159, 'SW >= v159 (got ' + (m && m[1]) + ')');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
