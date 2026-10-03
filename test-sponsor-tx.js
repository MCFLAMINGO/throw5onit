#!/usr/bin/env node
/** Sponsor-tx guards — static checks */

const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'api/sponsor-tx.js'), 'utf8');

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } }

console.log('1) Amount / key guards');
{
  assert(src.includes('MAX_SPONSOR_USD'), 'max amount constant');
  assert(src.includes('normalizePk'), 'pk normalize');
  assert(src.includes('invalid from'), 'refuse executor self');
  assert(src.includes('amount exceeds max'), 'rejects oversized amount');
  assert(src.includes('isHexAddr'), 'to-address check');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
