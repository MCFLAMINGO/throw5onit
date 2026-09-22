#!/usr/bin/env node
/** Solid polish guards — toast class, no alert spam, history sheet, SW bump */
const fs = require('fs');
const app = fs.readFileSync(__dirname + '/app.js', 'utf8');
const css = fs.readFileSync(__dirname + '/style.css', 'utf8');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const sw = fs.readFileSync(__dirname + '/sw.js', 'utf8');

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } }

console.log('1) Toast feedback actually shows');
{
  assert(/function showToast\(/.test(app), 'showToast exists');
  assert(/classList\.add\('show'\)/.test(app), 'toast uses .show class');
  assert(/\.throw-toast\.show\s*\{/.test(css), 'CSS has .throw-toast.show');
  assert(!/classList\.add\('visible'\)/.test(app.match(/function showToast[\s\S]*?^\}/m)?.[0] || ''), 'toast not using broken .visible');
}

console.log('2) Alerts replaced with in-app errors (except boot)');
{
  const alerts = [...app.matchAll(/\balert\(/g)];
  assert(alerts.length <= 1, 'at most one alert (wallet library boot)');
  assert(/function showError\(/.test(app), 'showError helper');
}

console.log('3) Screen transitions are fade-only (less jitter)');
{
  assert(/transition:\s*opacity/.test(css.match(/\.screen\s*\{[\s\S]*?\}/)?.[0] || ''), 'screen opacity transition');
  assert(!/transform:\s*translateY\(12px\)/.test(css.match(/\.screen\s*\{[\s\S]*?\}/)?.[0] || ''), 'no enter slide jitter');
}

console.log('4) History sheet + busy lock');
{
  assert(html.includes('id="history-sheet"'), 'history sheet markup');
  assert(/function openHistorySheet\(/.test(app), 'openHistorySheet');
  assert(/async function withBusy\(/.test(app), 'withBusy');
  assert(/withBusy\('throw'/.test(app), 'throw guarded');
  assert(/withBusy\('start-pot'/.test(app), 'start pot guarded');
}

console.log('5) Balance polish + SW');
{
  assert(/font-variant-numeric:\s*tabular-nums/.test(css), 'tabular nums');
  assert(/bal-tick/.test(app) && /balTick|bal-tick/.test(css), 'balance tick animation');
  assert(/VERSION = 'v15[5-9]'/.test(sw) || /VERSION = 'v1[6-9]\d'/.test(sw), 'SW version bumped');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
