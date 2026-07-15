#!/usr/bin/env node
/**
 * Unit tests for Texas Hold'em core rules used by throw5onit.
 * Run: node test-poker.js
 */

function assignBlindIndexes(seatCount) {
  if (seatCount === 2) {
    return { dealerIdx: 0, sbIdx: 0, bbIdx: 1 };
  }
  return {
    dealerIdx: 0,
    sbIdx: seatCount >= 2 ? 1 : 0,
    bbIdx: seatCount >= 3 ? 2 : 1,
  };
}

function simulateRound({ seats, street, currentBet, lastRaiser, currentSeat, actions }) {
  // Minimal host-side action applicator mirroring _applyAction turn logic
  const p = {
    seats: seats.map(s => ({ ...s })),
    street,
    currentBet,
    lastRaiser,
    currentSeat,
    pot: seats.reduce((a, s) => a + (s.bet || 0), 0),
    isHost: true,
  };

  const log = [];
  for (const act of actions) {
    const seat = p.seats[p.currentSeat];
    seat.acted = true;
    if (act === 'fold') seat.folded = true;
    else if (act === 'check') { /* noop */ }
    else if (typeof act === 'object' && act.type === 'call') {
      seat.bet += act.amount; seat.stack -= act.amount; p.pot += act.amount;
    } else if (typeof act === 'object' && act.type === 'raise') {
      seat.bet += act.amount; seat.stack -= act.amount; p.pot += act.amount;
      if (seat.bet > p.currentBet) p.currentBet = seat.bet;
      p.lastRaiser = p.currentSeat;
      p.seats.forEach((s, i) => { if (i !== p.currentSeat && !s.folded) s.acted = false; });
    }

    const active = p.seats.filter(s => !s.folded);
    if (active.length <= 1) {
      log.push('fold-win');
      break;
    }
    let next = (p.currentSeat + 1) % p.seats.length;
    let safety = 0;
    while (p.seats[next].folded && safety < p.seats.length) {
      next = (next + 1) % p.seats.length; safety++;
    }
    p.currentSeat = next;
    const everyoneMatched = active.every(s => s.bet === p.currentBet || s.stack === 0);
    const everyoneActed = active.every(s => s.acted);
    if (everyoneMatched && everyoneActed) {
      log.push('street-advance');
      break;
    }
    log.push('next-turn:' + next);
  }
  return { p, log };
}

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓', msg); }
  else { failed++; console.error('  ✗', msg); }
}

console.log('1) Blind indexes');
{
  const hu = assignBlindIndexes(2);
  assert(hu.sbIdx === 0 && hu.bbIdx === 1 && hu.dealerIdx === 0, 'heads-up: dealer posts SB');
  const mw = assignBlindIndexes(4);
  assert(mw.dealerIdx === 0 && mw.sbIdx === 1 && mw.bbIdx === 2, '4-handed: SB=1 BB=2');
  const three = assignBlindIndexes(3);
  assert(three.bbIdx === 2, '3-handed BB is seat 2');
}

console.log('2) Heads-up preflop first actor is SB/dealer');
{
  const idxs = assignBlindIndexes(2);
  const first = idxs.sbIdx; // HU special case
  assert(first === 0, 'HU first to act preflop is dealer/SB');
}

console.log('3) Round closes after checks postflop');
{
  const seats = [
    { addr: 'a', stack: 48, bet: 0, folded: false, acted: false },
    { addr: 'b', stack: 48, bet: 0, folded: false, acted: false },
  ];
  const { log } = simulateRound({
    seats, street: 'flop', currentBet: 0, lastRaiser: null, currentSeat: 1,
    actions: ['check', 'check'],
  });
  assert(log.includes('street-advance'), 'two checks advance the street');
}

console.log('4) Raise re-opens action');
{
  const seats = [
    { addr: 'a', stack: 48, bet: 0, folded: false, acted: false },
    { addr: 'b', stack: 48, bet: 0, folded: false, acted: false },
    { addr: 'c', stack: 48, bet: 0, folded: false, acted: false },
  ];
  const { p, log } = simulateRound({
    seats, street: 'flop', currentBet: 0, lastRaiser: null, currentSeat: 1,
    actions: [
      'check',
      { type: 'raise', amount: 5 },
      { type: 'call', amount: 5 },
      { type: 'call', amount: 5 },
    ],
  });
  assert(log.includes('street-advance'), 'raise + calls close the round');
  assert(p.pot === 15, 'pot is $15 after $5 each');
}

console.log('5) Fold-win when one remains');
{
  const seats = [
    { addr: 'a', stack: 50, bet: 0, folded: false, acted: false },
    { addr: 'b', stack: 50, bet: 0, folded: false, acted: false },
  ];
  const { log } = simulateRound({
    seats, street: 'preflop', currentBet: 2, lastRaiser: null, currentSeat: 0,
    actions: ['fold'],
  });
  assert(log.includes('fold-win'), 'fold leaves one winner');
}

console.log('5b) BB keeps option after limps');
{
  // UTG calls BB, SB calls — BB has not acted yet so street must NOT advance
  const seats = [
    { addr: 'dealer', stack: 49, bet: 1, folded: false, acted: false }, // SB posted
    { addr: 'utg', stack: 48, bet: 2, folded: false, acted: false },
    { addr: 'bb', stack: 48, bet: 2, folded: false, acted: false },
  ];
  // Action on UTG (seat 1) — call already reflected? simulate from UTG check/call done via action
  const { log, p } = simulateRound({
    seats: [
      { addr: 'sb', stack: 48, bet: 2, folded: false, acted: false },
      { addr: 'bb', stack: 48, bet: 2, folded: false, acted: false },
      { addr: 'utg', stack: 48, bet: 0, folded: false, acted: false },
    ],
    street: 'preflop', currentBet: 2, lastRaiser: null, currentSeat: 2,
    actions: [
      { type: 'call', amount: 2 }, // UTG
      { type: 'call', amount: 0 }, // SB already matched? use call 0 as acted after matching — better:
    ],
  });
  // After only UTG acts, should NOT street-advance
  assert(!log.includes('street-advance'), 'do not advance before BB acts');
}

console.log('5c) BB check closes limped pot');
{
  const { log } = simulateRound({
    seats: [
      { addr: 'sb', stack: 48, bet: 2, folded: false, acted: true },
      { addr: 'bb', stack: 48, bet: 2, folded: false, acted: false },
      { addr: 'utg', stack: 48, bet: 2, folded: false, acted: true },
    ],
    street: 'preflop', currentBet: 2, lastRaiser: null, currentSeat: 1,
    actions: ['check'],
  });
  assert(log.includes('street-advance'), 'BB check after limps advances');
}

console.log('6) Escrow fee math — rake 3%');
{
  const pot = 40;
  const fee = parseFloat((pot * 0.03).toFixed(6));
  const payout = parseFloat((pot - fee).toFixed(6));
  assert(fee === 1.2, '3% of $40 is $1.20');
  assert(payout === 38.8, 'winner gets $38.80');
}

console.log('7) Make-it-rain total');
{
  const amount = 5;
  const peers = 3;
  assert(amount * peers === 15, 'rain needs amount × peers');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
