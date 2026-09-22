#!/usr/bin/env node
const fs = require('fs');
const app = fs.readFileSync(__dirname + '/app.js', 'utf8');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } }

console.log('1) Dealer voice helpers');
assert(/function pokerMoneySpeak\b/.test(app), 'pokerMoneySpeak');
assert(/function unlockPokerVoice\b/.test(app), 'unlockPokerVoice');
assert(/function announcePokerTurn\b/.test(app), 'announcePokerTurn');
assert(/function announcePokerAction\b/.test(app), 'announcePokerAction');
assert(/function announcePokerStreet\b/.test(app), 'announcePokerStreet');
assert(/function announcePokerStart\b/.test(app), 'announcePokerStart');

console.log('2) Blind / bet / turn language');
assert(app.includes('big blind is up') || app.includes('Big blind is up'), 'big blind is up callout');
assert(app.includes('to call'), 'to call');
assert(app.includes('Check or raise') || app.includes('check or raise'), 'check or raise');
assert(/pokerMoneySpeak\(/.test(app), 'money spoken for TTS');

console.log('3) Voice unlock + delays');
assert(app.includes('unlockPokerVoice()'), 'unlock on deal/setup');
assert(/_pokerVoiceOn \? 9000/.test(app), 'long delay after blinds line');
assert(/pokerSpeak\(text,\s*forceSpeak\)/.test(app) || /pokerSpeak\(text, forceSpeak\)/.test(app), 'forceSpeak for own-turn');

console.log('4) UI default on');
assert(/id="poker-table-voice"[^>]*checked/.test(html) || /id="poker-table-voice" checked/.test(html), 'voice checkbox default on');
assert(/_pokerVoiceOn = true/.test(app), 'voice defaults on');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
