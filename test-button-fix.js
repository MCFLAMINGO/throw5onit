#!/usr/bin/env node
/** Button click blockers — boot loader, sheets in phone shell, Deal feedback */
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } }

console.log('1) Boot loader drops clicks on hide');
{
  const hide = app.match(/function hideBootLoader\([\s\S]*?\n\}/);
  assert(!!hide, 'hideBootLoader exists');
  assert(hide && hide[0].includes('pointerEvents') && hide[0].includes('none'), 'pointer-events none on hide');
}

console.log('2) showScreen activates immediately');
{
  const show = app.match(/function showScreen\(id\)[\s\S]*?\n\}/);
  assert(!!show, 'showScreen exists');
  assert(show && /next\.classList\.add\('active'\);[\s\S]*?_screenTimer = setTimeout/.test(show[0]), 'active before timeout');
}

console.log('3) Sheets above chrome + inside phone frame');
{
  assert(/\.sheet-overlay\s*\{[^}]*z-index:\s*10050/.test(css), 'sheet z-index 10050');
  assert(css.includes('.sheet-overlay,') && css.includes('.history-sheet'), 'sheets in phone shell list');
  assert(/\.sheet-overlay,\s*\n\s*\.history-sheet\s*\{[^}]*z-index:\s*40/.test(css)
    || /sheet-overlay[\s\S]{0,200}z-index:\s*40/.test(css), 'sheets above screen in frame');
}

console.log('4) Deal / group choice feedback');
{
  assert(app.includes("Only the host can deal"), 'host-only deal toast');
  assert(app.includes('Seat 2+ players'), 'need seats toast');
  assert(html.includes('type="button"') && html.includes('id="btn-poker-start"'), 'Deal is type=button');
  assert(app.includes("e.stopPropagation()") && app.includes('btn-group-poker'), 'group poker stops bubble');
}

console.log('5) SW bump');
{
  assert(/VERSION = 'v17\d'|VERSION = 'v169'/.test(sw) || /v170/.test(sw), 'SW >= v169');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
