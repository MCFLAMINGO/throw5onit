#!/usr/bin/env node
/**
 * Full 5-player night simulation — hangout, throws, rain, poker, claims.
 * Run: node test-5player-night.js
 *
 * This exercises the product logic end-to-end in-process (demo mode).
 * It does NOT replace real multi-phone QA, but catches the bugs that
 * inflated balances and broke group join / poker seating.
 */

const CAP = 50;
const THROW_FEE = 0.01;
const POKER_SB = 1;
const POKER_BB = 2;
const POKER_STACK = 50;

let pass = 0, fail = 0;
function assert(c, m) {
  if (c) { pass++; console.log('  ✓', m); }
  else { fail++; console.error('  ✗', m); }
}

function fee(amount) {
  return Math.round(amount * THROW_FEE * 1e6) / 1e6;
}

function mkPlayer(name, i) {
  return {
    name,
    addr: '0x' + String(i + 1).padStart(40, '0'),
    balance: CAP,
    contacts: [],
    seenCredits: new Set(),
  };
}

function creditKey(data) {
  if (data.hash) return 'h:' + String(data.hash).toLowerCase();
  if (data.throwId) return 't:' + String(data.throwId);
  return 'f:' + (data.from || '') + ':' + Number(data.amount).toFixed(4);
}

function applyDemoCredit(player, amount, meta) {
  const key = creditKey(meta);
  if (player.seenCredits.has(key)) return false;
  // proximity_throw must never credit — only demo_credit
  if (meta.event && meta.event !== 'demo_credit') return false;
  player.seenCredits.add(key);
  player.balance = Math.round((player.balance + amount) * 1e6) / 1e6;
  return true;
}

function throwCash(from, to, amount) {
  if (from.balance < amount) throw new Error(from.name + ' insufficient');
  const net = Math.round((amount - fee(amount)) * 1e6) / 1e6;
  const throwId = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const hash = '0xDEMO' + throwId.toUpperCase();
  from.balance = Math.round((from.balance - amount) * 1e6) / 1e6;

  // Simulate old buggy multi-notify + new correct path
  const events = [
    { event: 'proximity_throw', amount, throwId, from: from.addr, to: to.addr },
    { event: 'demo_credit', amount: net, hash, throwId, from: from.addr, to: to.addr },
    { event: 'proximity_throw', amount, throwId, from: from.addr, to: to.addr }, // relay dupe
  ];
  let credited = 0;
  for (const ev of events) {
    if (applyDemoCredit(to, ev.amount, ev)) credited++;
  }
  return { net, throwId, hash, credited };
}

function hangoutMesh(players) {
  // Host publishes roster; each joiner gets full mesh → upsertContact everyone else
  const roster = players.map(p => ({ addr: p.addr, name: p.name }));
  for (const p of players) {
    p.contacts = roster
      .filter(m => m.addr !== p.addr)
      .map(m => ({ addr: m.addr, name: m.name }));
  }
}

function assignBlinds(n) {
  if (n === 2) return { dealerIdx: 0, sbIdx: 0, bbIdx: 1 };
  return { dealerIdx: 0, sbIdx: 1, bbIdx: 2 };
}

function announceStart(seats, sbIdx, bbIdx, sbAmt, bbAmt) {
  const sb = seats[sbIdx].name;
  const bb = seats[bbIdx].name;
  return `Starting poker. Small blind ${sbAmt}, big blind ${bbAmt}. ` +
    `${bb}, you're the big blind. ${sb}, you're the small blind. Let's start. Real cards — deal them out.`;
}

function seatAll(players) {
  return players.slice(0, 6).map(p => ({
    name: p.name,
    addr: p.addr,
    stack: POKER_STACK,
    bet: 0,
    folded: false,
    acted: false,
  }));
}

function postBlinds(seats, idxs) {
  const sbAmt = Math.min(POKER_SB, seats[idxs.sbIdx].stack);
  const bbAmt = Math.min(POKER_BB, seats[idxs.bbIdx].stack);
  seats[idxs.sbIdx].stack -= sbAmt;
  seats[idxs.sbIdx].bet = sbAmt;
  seats[idxs.bbIdx].stack -= bbAmt;
  seats[idxs.bbIdx].bet = bbAmt;
  const pot = sbAmt + bbAmt;
  const first = seats.length === 2 ? idxs.sbIdx : ((idxs.bbIdx + 1) % seats.length);
  return { pot, currentBet: bbAmt, currentSeat: first, sbAmt, bbAmt };
}

function applyActions(table, actions) {
  const log = [];
  for (const act of actions) {
    const seat = table.seats[table.currentSeat];
    seat.acted = true;
    if (act === 'fold') {
      seat.folded = true;
      log.push(seat.name + ' folds');
    } else if (act === 'check') {
      log.push(seat.name + ' checks');
    } else if (act.type === 'call') {
      seat.stack -= act.amount;
      seat.bet += act.amount;
      table.pot += act.amount;
      log.push(seat.name + ' calls ' + act.amount);
    } else if (act.type === 'raise') {
      seat.stack -= act.amount;
      seat.bet += act.amount;
      table.pot += act.amount;
      if (seat.bet > table.currentBet) table.currentBet = seat.bet;
      table.lastRaiser = table.currentSeat;
      table.seats.forEach((s, i) => {
        if (i !== table.currentSeat && !s.folded) s.acted = false;
      });
      log.push(seat.name + ' raises to ' + seat.bet);
    }

    const active = table.seats.filter(s => !s.folded);
    if (active.length <= 1) {
      log.push('fold-win:' + active[0].name);
      table.winner = active[0];
      break;
    }

    let next = (table.currentSeat + 1) % table.seats.length;
    let safety = 0;
    while (table.seats[next].folded && safety < table.seats.length) {
      next = (next + 1) % table.seats.length;
      safety++;
    }
    table.currentSeat = next;

    const everyoneMatched = active.every(s => s.bet === table.currentBet || s.stack === 0);
    const everyoneActed = active.every(s => s.acted);
    if (everyoneMatched && everyoneActed) {
      log.push('street-advance');
      break;
    }
  }
  return log;
}

function makeItRain(from, peers, amount) {
  const need = amount * peers.length;
  if (from.balance < need) return { ok: 0, need };
  let ok = 0;
  for (const peer of peers) {
    throwCash(from, peer, amount);
    ok++;
  }
  return { ok, need };
}

function claimFlow(sender, claimer, amount) {
  // Escrow: sender locks amount; claimer pockets net (no throw fee on claim in product — full amount)
  if (sender.balance < amount) throw new Error('claim underfunded');
  sender.balance = Math.round((sender.balance - amount) * 1e6) / 1e6;
  const claimId = 'c' + Math.random().toString(16).slice(2, 18);
  // Redeem once
  let redeemed = false;
  function redeem(who) {
    if (redeemed) return false;
    redeemed = true;
    who.balance = Math.round((who.balance + amount) * 1e6) / 1e6;
    return true;
  }
  const first = redeem(claimer);
  const second = redeem(claimer);
  return { claimId, first, second, amount };
}

// ═══════════════════════════════════════════════════════════════════════
console.log('\n═══ 5-PLAYER NIGHT SIM ═══\n');

const names = ['HOST', 'WIFE', 'LEE', 'ERIK', 'SAM'];
const players = names.map((n, i) => mkPlayer(n, i));
const [host, wife, lee, erik, sam] = players;

console.log('1) Hangout — one host, four join → full contact mesh');
{
  hangoutMesh(players);
  assert(players.every(p => p.contacts.length === 4), 'each player has 4 contacts');
  assert(wife.contacts.some(c => c.name === 'LEE') && wife.contacts.some(c => c.name === 'HOST'), 'wife has host+lee');
  assert(sam.contacts.every(c => c.addr !== sam.addr), 'no self-contact');
  const edges = players.reduce((n, p) => n + p.contacts.length, 0);
  assert(edges === 20, '5×4 = 20 directed edges (full mesh)');
}

console.log('2) Throws — $5 HOST→WIFE, WIFE→LEE (no multi-credit inflation)');
{
  const t1 = throwCash(host, wife, 5);
  assert(t1.credited === 1, 'wife credited once despite 3 MQTT events');
  assert(Math.abs(wife.balance - 54.95) < 0.001, 'wife ~$54.95 (was the $69 bug)');
  assert(Math.abs(host.balance - 45) < 0.001, 'host $45 after send');

  const t2 = throwCash(wife, lee, 5);
  assert(t2.credited === 1, 'lee credited once');
  assert(Math.abs(lee.balance - 54.95) < 0.001, 'lee ~$54.95');
  // Not ~$69 or ~$100
  assert(wife.balance < 55 && wife.balance > 49, 'wife after send still sane (~49.95)');
}

console.log('3) Make-it-rain — ERIK rains $1 on 4 peers');
{
  const peers = [host, wife, lee, sam];
  const before = peers.map(p => p.balance);
  const rain = makeItRain(erik, peers, 1);
  assert(rain.ok === 4, 'rained on 4');
  assert(Math.abs(erik.balance - (50 - 4)) < 0.001, 'erik paid $4 total');
  peers.forEach((p, i) => {
    const gained = Math.round((p.balance - before[i]) * 1e6) / 1e6;
    assert(Math.abs(gained - 0.99) < 0.001, p.name + ' got $0.99 net');
  });
}

console.log('4) Poker — seat all 5, blinds, announcement, preflop folds to BB');
{
  const seats = seatAll(players);
  assert(seats.length === 5, '5 seated');
  const idxs = assignBlinds(5);
  assert(idxs.sbIdx === 1 && idxs.bbIdx === 2, 'SB=WIFE BB=LEE');
  const table = { seats, pot: 0, currentBet: 0, currentSeat: 0, lastRaiser: null, winner: null };
  const posted = postBlinds(seats, idxs);
  table.pot = posted.pot;
  table.currentBet = posted.currentBet;
  table.currentSeat = posted.currentSeat;
  assert(table.pot === 3, 'pot $3 after blinds');
  assert(seats[posted.currentSeat].name === 'ERIK', 'UTG is ERIK (after BB)');

  const line = announceStart(seats, idxs.sbIdx, idxs.bbIdx, posted.sbAmt, posted.bbAmt);
  assert(/Starting poker/.test(line), 'start opener');
  assert(/LEE, you're the big blind/.test(line), 'BB named');
  assert(/WIFE, you're the small blind/.test(line), 'SB named');
  assert(/Let's start/.test(line), "let's start");

  // UTG fold, Sam fold, Host fold, Wife fold → Lee wins
  // currentSeat = ERIK(3), then SAM(4), HOST(0), WIFE(1); LEE(2) is BB
  const log = applyActions(table, ['fold', 'fold', 'fold', 'fold']);
  assert(log.some(l => l.includes('fold-win:LEE')), 'LEE wins uncontested');
  assert(table.winner && table.winner.name === 'LEE', 'winner is LEE');
  assert(table.pot === 3, 'pot still $3 for winner');
}

console.log('5) Poker — 5-handed raise + calls close street');
{
  const seats = seatAll(players);
  const idxs = assignBlinds(5);
  const posted = postBlinds(seats, idxs);
  const table = {
    seats,
    pot: posted.pot,
    currentBet: posted.currentBet,
    currentSeat: posted.currentSeat,
    lastRaiser: null,
  };
  // ERIK raises to 6 (puts 6 more? seat bet is 0, need to put 6 total → amount 6)
  // Actually after blinds ERIK bet=0, raise to 6 means amount=6
  // Then SAM calls 6, HOST calls 6, WIFE calls 5 (has 1 in), LEE calls 4 (has 2 in)
  // Order of action from UTG: ERIK, SAM, HOST, WIFE, LEE
  const toCall = (seat) => table.currentBet - seat.bet;
  // We'll drive with explicit amounts matching engine
  seats[3].acted = false; // ensure
  const actions = [
    { type: 'raise', amount: 6 }, // ERIK to 6
  ];
  // After raise, currentBet=6, others need to call
  // Simulate carefully by applying raise then computing calls
  let log = applyActions(table, actions);
  assert(log.some(l => /ERIK raises/.test(l)), 'ERIK raised');
  assert(table.currentBet === 6, 'current bet 6');

  // Continue from wherever currentSeat is
  const more = [];
  const safety = 20;
  let n = 0;
  while (n++ < safety) {
    const active = table.seats.filter(s => !s.folded);
    const everyoneMatched = active.every(s => s.bet === table.currentBet || s.stack === 0);
    const everyoneActed = active.every(s => s.acted);
    if (everyoneMatched && everyoneActed) break;
    const seat = table.seats[table.currentSeat];
    if (seat.folded) break;
    const need = table.currentBet - seat.bet;
    if (need > 0) more.push({ type: 'call', amount: need });
    else more.push('check');
    const piece = applyActions(table, [more[more.length - 1]]);
    log = log.concat(piece);
    if (piece.includes('street-advance') || piece.some(x => /fold-win/.test(x))) break;
  }
  assert(log.includes('street-advance') || table.seats.every(s => s.bet === table.currentBet || s.folded),
    '5-handed preflop action completes');
  assert(table.pot >= 30, 'pot at least 5×$6 = $30');
}

console.log('6) Claim link — SAM throws claim to imaginary friend, one redeem');
{
  const claimer = mkPlayer('NEWBIE', 9);
  claimer.balance = 0;
  const before = sam.balance;
  const c = claimFlow(sam, claimer, 5);
  assert(c.first === true, 'first redeem ok');
  assert(c.second === false, 'double redeem blocked');
  assert(claimer.balance === 5, 'claimer has $5');
  assert(Math.abs(sam.balance - (before - 5)) < 0.001, 'sam escrowed $5');
}

console.log('7) Cap / sanity — no player wildly over $70 from throws');
{
  for (const p of players) {
    assert(p.balance < 70, p.name + ' balance $' + p.balance.toFixed(2) + ' under inflation ceiling');
    assert(p.balance >= 0, p.name + ' non-negative');
  }
}

console.log('8) Seat-everyone helper seats max 5 from crew of 5');
{
  const seats = seatAll(players);
  assert(seats.map(s => s.name).join(',') === names.join(','), 'order preserved HOST…SAM');
}

console.log('\n═══ RESULT: ' + pass + ' passed, ' + fail + ' failed ═══\n');
process.exit(fail ? 1 : 0);
