#!/usr/bin/env node
/** Poker table dealer — brightness + stall jabs */
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } }

console.log('1) Stall jabs');
{
  assert(app.includes('POKER_DEFAULT_JABS'), 'default jabs');
  assert(app.includes('get a move on'), 'yo buddy line');
  assert(app.includes('easy math'), 'math jab');
  assert(app.includes('dial your mom'), 'mom jab');
  assert(app.includes('schedulePokerStallJabs'), 'stall timer');
  assert(app.includes('playStallJab'), 'playStallJab');
  assert(html.includes('id="jab-sheet"'), 'jab sheet');
  assert(html.includes('btn-jab-record'), 'record control');
}

console.log('2) Brightness / table phone');
{
  assert(app.includes('flashPokerBrightness'), 'brightness flash');
  assert(app.includes('requestPokerWakeLock'), 'wake lock');
  assert(app.includes('poker-turn-hero') || html.includes('poker-turn-hero'), 'turn hero');
  assert(css.includes('turn-bright') && css.includes('stall-bright'), 'bright CSS');
  assert(app.includes('onPokerTurnVisual'), 'turn visual hook');
}

console.log('3) Wiring');
{
  assert(app.includes('wireJabSheet'), 'wireJabSheet');
  assert(html.includes('btn-poker-jabs'), 'toolbar jabs');
  assert(html.includes('Dealer voice + brightness') || html.includes('This phone is the table'), 'setup copy');
}

console.log('4) SW');
{
  assert(sw.includes("VERSION = 'v168'") || /v168/.test(sw), 'SW v168');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
