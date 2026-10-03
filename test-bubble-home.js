#!/usr/bin/env node
/** Bubble home — people constellation + group secondary surface */
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } }

console.log('1) Bubble home markup');
{
  assert(html.includes('id="bubble-field"'), 'bubble field');
  assert(html.includes('id="bubble-join"'), 'central JOIN');
  assert(html.includes('id="bubble-self"'), 'self pocket bubble');
  assert(html.includes('screen-wallet-bubbles'), 'wallet bubble screen');
  assert(html.includes('Tap a friend'), 'tagline');
}

console.log('2) Group secondary = Poker / Wager / Party');
{
  assert(html.includes('id="group-sheet"'), 'group sheet');
  assert(html.includes('id="btn-group-poker"'), 'poker choice');
  assert(html.includes('id="btn-group-wager"'), 'wager choice');
  assert(html.includes('id="btn-group-party"'), 'party choice');
  assert(html.includes('id="party-sheet"'), 'party float sheet');
}

console.log('3) App wiring');
{
  assert(app.includes('function renderBubbleHome'), 'renderBubbleHome');
  assert(app.includes('function openThrowFromBubble'), 'openThrowFromBubble');
  assert(app.includes('function openGroupSheet'), 'openGroupSheet');
  assert(app.includes('function openPartyFloat'), 'openPartyFloat');
  assert(app.includes('function wireBubbleHome'), 'wireBubbleHome');
  assert(app.includes('contactBubbleSize') || app.includes('throwCount'), 'bubble size from use');
  assert(app.includes('wireBubbleHome()'), 'wired on boot');
}

console.log('4) Styles + SW');
{
  assert(css.includes('.bubble-field') && css.includes('.join-bubble'), 'bubble CSS');
  assert(css.includes('.group-choice'), 'group choice CSS');
  assert(/v16[7-9]|v17\d/.test(sw) || sw.includes("VERSION = 'v167'"), 'SW bumped');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
