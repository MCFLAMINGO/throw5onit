#!/usr/bin/env node
/** THROW-to-join Hold'em + soft navigation / session persistence */
const fs = require('fs');
const app = fs.readFileSync(__dirname + '/app.js', 'utf8');
const room = fs.readFileSync(__dirname + '/room.js', 'utf8');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const css = fs.readFileSync(__dirname + '/style.css', 'utf8');

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } }

console.log('1) Global poker discovery in room.js');
assert(room.includes('function publishGlobalPokerTable'), 'publishGlobalPokerTable');
assert(room.includes('function scanForPokerTables'), 'scanForPokerTables');
assert(room.includes('function clearGlobalPokerTable'), 'clearGlobalPokerTable');
assert(room.includes("throw5/poker/open") || room.includes('throw5/poker/open'), 'poker open topic');

console.log('2) THROW-to-join helpers in app.js');
assert(app.includes('function shouldJoinPokerInsteadOfThrow'), 'shouldJoinPokerInsteadOfThrow');
assert(app.includes('function joinNearbyPokerTable') || app.includes('async function joinNearbyPokerTable'), 'joinNearbyPokerTable');
assert(app.includes('function scanNearbyPokerTable'), 'scanNearbyPokerTable');
assert(app.includes('function handlePokerJoinRequest'), 'handlePokerJoinRequest');
assert(app.includes("poker_join_request"), 'join request event');
assert(app.includes('publishHostPokerBeacon') || app.includes('function publishHostPokerBeacon'), 'host beacon');

console.log('3) Soft navigation — Back keeps table, Leave destroys');
assert(app.includes('softExitPokerToWallet'), 'softExitPokerToWallet');
assert(/poker-setup-back[\s\S]{0,200}softExitPokerToWallet/.test(app), 'setup back soft-exits');
assert(/poker-table-back[\s\S]{0,200}softExitPokerToWallet/.test(app), 'table back soft-exits');
assert(html.includes('id="btn-poker-leave-setup"'), 'leave setup button in HTML');
assert(html.includes('id="btn-poker-leave-table"'), 'leave table button in HTML');
assert(/btn-poker-leave-setup[\s\S]{0,200}leavePokerRoom/.test(app), 'leave setup calls leavePokerRoom');
assert(/btn-poker-leave-table[\s\S]{0,200}leavePokerRoom/.test(app), 'leave table calls leavePokerRoom');

console.log('4) Session rail + persistence');
assert(html.includes('id="session-rail"'), 'session-rail in HTML');
assert(html.includes('id="btn-resume-poker"'), 'resume poker chip');
assert(html.includes('id="btn-resume-pot"'), 'resume pot chip');
assert(css.includes('.session-rail'), 'session-rail CSS');
assert(app.includes('function updateSessionRail'), 'updateSessionRail');
assert(app.includes('function persistPokerSession'), 'persistPokerSession');
assert(app.includes('function tryRestorePokerSession'), 'tryRestorePokerSession');
assert(app.includes('throw_poker_session'), 'localStorage key');

console.log('5) Pot soft leave keeps money');
assert(/pot-back[\s\S]{0,250}persistActiveBet/.test(app), 'pot back persists bet');
assert(!/pot-back[\s\S]{0,200}bet\.active\s*=\s*false/.test(app), 'pot back does not wipe bet.active');

console.log('6) Fixed back buttons visible under demo banner');
assert(/\.screen\s*>\s*\.back-btn\s*\{[\s\S]*?position:\s*fixed/.test(css), 'back-btn fixed on screens');
assert(css.includes('demo-banner:not(.hidden)') && css.includes('.screen > .back-btn'), 'back below demo banner');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
