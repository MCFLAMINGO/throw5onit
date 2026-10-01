#!/usr/bin/env node
/** Voice-hold throw — parse "$5 to Erik" / "add friend Bill Lee" */

function normalizeFriendName(raw) {
  const cleaned = String(raw || '')
    .replace(/[^a-zA-Z0-9\s'-]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (!cleaned) return '';
  return cleaned.split(' ')[0].toUpperCase().slice(0, 6);
}

function matchContactBySpokenName(spoken, contacts) {
  if (!contacts.length || !spoken) return null;
  const norm = String(spoken).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
  const tokens = norm.split(/\s+/).filter(Boolean);
  const first = (tokens[0] || '').slice(0, 6);
  const compact = tokens.join('').slice(0, 6);

  const score = (c) => {
    const n = (c.name || '').toLowerCase();
    if (!n) return 0;
    if (n === first || n === compact) return 100;
    if (n.startsWith(first) || first.startsWith(n)) return 80;
    if (tokens.some(t => n.startsWith(t.slice(0, 6)) || t.startsWith(n))) return 60;
    if (n.includes(first.slice(0, Math.min(3, first.length)))) return 30;
    return 0;
  };

  let best = null, bestScore = 0;
  contacts.forEach(c => {
    const s = score(c);
    if (s > bestScore) { bestScore = s; best = c; }
  });
  return bestScore >= 60 ? best : null;
}

function parseThrowVoice(transcript, contacts) {
  const text = String(transcript || '').toLowerCase().trim();
  if (!text) return { mode: null };

  const addMatch = text.match(/\badd(?:\s+friend)?\s+(.+)/i);
  if (addMatch) {
    const friendName = normalizeFriendName(addMatch[1]);
    if (friendName) return { mode: 'add-friend', friendName, raw: addMatch[1].trim() };
  }

  let amount = null;
  const amtMatch = text.match(/\$?\s*(\d+(?:\.\d+)?)\s*(?:dollars?|bucks?)?/);
  if (amtMatch) {
    amount = Math.min(50, Math.max(1, Math.round(parseFloat(amtMatch[1]))));
  }

  let recipientRaw = null;
  const toMatch = text.match(/\b(?:to|for)\s+([a-z][a-z0-9\s'-]{0,40})/i);
  if (toMatch) {
    recipientRaw = toMatch[1].replace(/\s+(please|thanks|thank you).*$/i, '').trim();
  }

  const recipient = recipientRaw ? matchContactBySpokenName(recipientRaw, contacts) : null;
  return { mode: 'throw', amount, recipientRaw, recipient };
}

function amountFromHorizontalSlide(startAmount, dxPx) {
  const amounts = [1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
  const steps = Math.round(dxPx / 36);
  let idx = amounts.indexOf(startAmount);
  if (idx < 0) idx = amounts.findIndex(a => a >= startAmount);
  if (idx < 0) idx = 1;
  return amounts[Math.max(0, Math.min(amounts.length - 1, idx + steps))];
}

function isSwipeUp(dx, dy, threshold) {
  threshold = threshold || 72;
  return dy < -threshold && Math.abs(dy) > Math.abs(dx);
}

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } }

const crew = [
  { name: 'ERIK', addr: '0xErik' },
  { name: 'BILL', addr: '0xBill' },
  { name: 'OSOL', addr: '0xOsol' },
];

console.log('1) Parse amount only');
{
  const p = parseThrowVoice('five dollars wait $5', crew);
  assert(p.mode === 'throw' && p.amount === 5, '$5 → amount 5');
  const p2 = parseThrowVoice('send 20 bucks', crew);
  assert(p2.amount === 20, '20 bucks → 20');
  const p3 = parseThrowVoice('$50 to the limit', crew);
  assert(p3.amount === 50, 'caps at 50');
}

console.log('2) Parse "$5 to Erik Osol"');
{
  const p = parseThrowVoice('$5 to Erik Osol', crew);
  assert(p.mode === 'throw', 'throw mode');
  assert(p.amount === 5, 'amount 5');
  assert(p.recipient && p.recipient.name === 'ERIK', 'matches ERIK contact');
}

console.log('3) Parse add friend');
{
  const p = parseThrowVoice('add friend Bill Lee', crew);
  assert(p.mode === 'add-friend', 'add-friend mode');
  assert(p.friendName === 'BILL', 'handle BILL from Bill Lee');
  const p2 = parseThrowVoice('add Maya', crew);
  assert(p2.friendName === 'MAYA', 'add Maya → MAYA');
}

console.log('4) Horizontal amount slide');
{
  assert(amountFromHorizontalSlide(5, 36) === 10, 'slide right from $5 → $10');
  assert(amountFromHorizontalSlide(5, -36) === 1, 'slide left from $5 → $1');
  assert(amountFromHorizontalSlide(50, 100) === 50, 'clamp at $50');
}

console.log('5) Swipe-up gesture');
{
  assert(isSwipeUp(10, -90), 'upward swipe counts');
  assert(!isSwipeUp(100, -40), 'mostly horizontal is not a throw');
  assert(!isSwipeUp(0, 80), 'swipe down does not throw');
}

console.log('6) Name normalize');
{
  assert(normalizeFriendName('erik osol') === 'ERIK', 'first token uppercased ≤6');
  assert(normalizeFriendName('Alexander') === 'ALEXAN', 'truncate to 6');
}

console.log('7) Bright hold surface markup');
{
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
  assert(html.includes('id="throw-hold-surface"'), 'hold surface element');
  assert(html.includes('id="throw-amount-display"'), 'amount display');
  assert(html.includes('id="throw-amount-type"'), 'type-amount fallback');
  assert(html.includes('throw-bright'), 'bright screen class');
  assert(css.includes('throwAmountPulse'), 'amount pulse animation');
  assert(app.includes('parseThrowVoice'), 'voice parser in app');
  assert(app.includes('setupThrowHoldSurface'), 'hold surface wiring');
  assert(app.includes('executeAddFriendThrow'), 'voice add-friend throw');
  assert(app.includes("throwMode: 'throw'"), 'throwMode state');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
