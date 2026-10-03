#!/usr/bin/env node
/** Simple throw surface + voice parse helpers */

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
    if (friendName) return { mode: 'add-friend', friendName };
  }
  let amount = null;
  const amtMatch = text.match(/\$?\s*(\d+(?:\.\d+)?)\s*(?:dollars?|bucks?)?/);
  if (amtMatch) amount = Math.min(50, Math.max(1, Math.round(parseFloat(amtMatch[1]))));
  let recipientRaw = null;
  const toMatch = text.match(/\b(?:to|for)\s+([a-z][a-z0-9\s'-]{0,40})/i);
  if (toMatch) recipientRaw = toMatch[1].replace(/\s+(please|thanks|thank you).*$/i, '').trim();
  const recipient = recipientRaw ? matchContactBySpokenName(recipientRaw, contacts) : null;
  return { mode: 'throw', amount, recipientRaw, recipient };
}

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } }

const crew = [
  { name: 'ERIK', addr: '0xErik' },
  { name: 'BILL', addr: '0xBill' },
];

console.log('1) Voice parse still works as optional shortcut');
{
  const p = parseThrowVoice('$5 to Erik Osol', crew);
  assert(p.amount === 5 && p.recipient?.name === 'ERIK', '$5 to Erik');
  assert(parseThrowVoice('add friend Bill Lee', crew).friendName === 'BILL', 'add friend');
}

console.log('2) Simple throw markup (reset)');
{
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
  assert(html.includes('id="throw-orb"'), 'toss orb restored');
  assert(html.includes('id="throw-amount-display"'), 'amount display');
  assert(html.includes('throw-more'), 'extras collapsed in details');
  assert(!html.includes('throw-bright'), 'bright hold classroom removed');
  assert(html.includes('btn-open-holdem') || html.includes('action-holdem'), 'Hold\'em on wallet');
  assert(html.includes('iou-link-quiet') || html.includes('btn-open-bet'), 'IOU quiet link kept');
  assert(app.includes('applyDemoCreditOnce'), 'demo credit guard');
  assert(app.includes('_demoCreditClient'), 'singleton credit subscriber');
  assert(css.includes('throw-amount-hero') || css.includes('.throw-orb'), 'simple throw styles');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
