#!/usr/bin/env node
/** TOKEN2049 stage rain — node test-stage-rain.js */

const fs = require('fs');
const path = require('path');
const root = __dirname;
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const room = fs.readFileSync(path.join(root, 'room.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const stage = fs.readFileSync(path.join(root, 'stage.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const vercel = fs.readFileSync(path.join(root, 'vercel.json'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } }

console.log('1) Stage route + page');
{
  assert(fs.existsSync(path.join(root, 'stage.html')), 'stage.html exists');
  assert(vercel.includes('/stage') && vercel.includes('stage.html'), 'vercel /stage rewrite');
  assert(stage.includes('throw5/rain/burst'), 'stage listens global rain topic');
  assert(stage.includes('Make the room rain'), 'stage idle copy');
  assert(stage.includes('spawnStageRain') || stage.includes('__stageRain'), 'stage rain renderer');
  assert(sw.includes('stage.html'), 'SW caches stage.html');
}

console.log('2) Cinematic Make It Rain + broadcast');
{
  assert(app.includes('broadcastRainBurst'), 'broadcast helper');
  assert(room.includes('publishRainBurst') && room.includes('throw5/rain/burst'), 'room publishes rain burst');
  assert(app.includes("cinematic: true") && app.includes('stage: true'), 'rain uses cinematic/stage opts');
  assert(app.includes('subscribeStageRain'), 'phones subscribe to rain bursts');
  assert(css.includes('cash-fall'), 'cash bill particles');
}

console.log('3) In-app cast / share');
{
  assert(html.includes('id="btn-cast-stage"'), 'cast stage button');
  assert(html.includes('id="btn-share-rain"'), 'share rain button');
  assert(html.includes('id="btn-make-it-rain"'), 'make it rain CTA');
  assert(html.includes('href="/stage"') || html.includes("'/stage'"), 'profile or link to /stage');
}

console.log('4) Pure burst payload shape');
{
  function buildBurst(amount, peers, fromName) {
    return {
      event: 'rain_burst',
      fromName: fromName || 'SOMEONE',
      amount: Number(amount) || 0,
      peers: Number(peers) || 0,
      total: (Number(amount) || 0) * (Number(peers) || 0),
      count: Math.min(72, 28 + peers * 4),
    };
  }
  const b = buildBurst(5, 12, 'ERIK');
  assert(b.total === 60 && b.count === 72, '12 peers × $5 → $60 / 72 bills');
  assert(b.event === 'rain_burst', 'event name');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
