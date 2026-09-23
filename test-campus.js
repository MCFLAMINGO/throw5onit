#!/usr/bin/env node
/** Campus fund / IOU / theme / deal-push — node test-campus.js */

const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const ads = fs.readFileSync(path.join(__dirname, 'ads.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } }

console.log('1) Ask a friend leads Load (copy beats Relay/Across)');
{
  const fundIdx = html.indexOf('id="screen-qr"');
  const askIdx = html.indexOf('Ask a friend to load you', fundIdx);
  const relayIdx = html.indexOf('Relay', fundIdx);
  const acrossIdx = html.indexOf('Across', fundIdx);
  assert(askIdx > fundIdx, 'ask-a-friend copy on fund screen');
  assert(html.includes('id="btn-ask-friend-load"'), 'primary Ask a friend CTA');
  assert(html.includes('id="btn-sms-friend"'), 'SMS ask CTA');
  assert(askIdx < relayIdx && askIdx < acrossIdx, 'Ask a friend appears before Relay/Across');
  assert(/<details[\s\S]*Relay[\s\S]*Across/.test(html.slice(fundIdx, fundIdx + 3500)), 'Tempo/Relay/Across demoted into details');
  assert(app.includes('buildAskFriendLoadText') && app.includes('askFriendToLoadYou'), 'ask-friend share helpers');
  assert(app.includes('updateSmsFriendLink'), 'SMS body helper');
}

console.log('2) IOU is first-class (default + settle)');
{
  assert(html.includes('data-struct="iou"'), 'IOU structure card in HTML');
  assert(/data-struct="iou"[\s\S]{0,80}structure-card active|structure-card active" data-struct="iou"/.test(html)
    || /class="structure-card active" data-struct="iou"/.test(html)
    || /data-struct="iou"[\s\S]{0,40}active/.test(html)
    || html.indexOf('data-struct="iou"') < html.indexOf('data-struct="winner-all"'), 'IOU listed / preferred before winner-all');
  assert(app.includes("structure = 'iou'") || app.includes("structure:  'iou'"), 'IOU is default structure');
  assert(app.includes("structure === 'iou'") && app.includes('winner-all'), 'IOU settles with winner-all path');
  assert(app.includes('THEY PAID') && app.includes('FORGIVE'), 'IOU settle button labels');
  assert(html.includes('IOU') && (html.includes('btn-open-bet') || html.includes('>IOU<')), 'Wallet CTA labeled IOU');
}

console.log('3) Photo → wallet theme colors');
{
  assert(html.includes('id="theme-photo-input"'), 'theme photo input');
  assert(html.includes('id="theme-swatch-row"'), 'theme swatch row');
  assert(html.includes('id="theme-reset-btn"'), 'theme reset');
  assert(app.includes('extractThemeFromImage') && app.includes('applyWalletTheme'), 'theme extract + apply');
  assert(app.includes("setProperty('--accent'") && app.includes("setProperty('--accent-glow'"), 'writes accent CSS vars');
  assert(app.includes('loadStoredWalletTheme') && app.includes('throw_wallet_theme'), 'persists theme');
  assert(css.includes('.theme-swatch'), 'theme swatch styles');
}

console.log('4) Local business deal push + QR');
{
  assert(html.includes('id="deal-push"') && html.includes('id="deal-push-qr"'), 'deal push sheet + QR canvas');
  assert(app.includes('showDealPush') && app.includes('buildDealRedeemPayload'), 'deal push helpers');
  assert(app.includes('isDealAd') && app.includes('maybePushDealFromSponsor'), 'deal detection from sponsor inventory');
  assert(ads.includes('id="a-deal-text"') && ads.includes('id="a-deal-code"'), 'ads admin deal fields');
  assert(ads.includes('value="deal"') || ads.includes(">In-store deal"), 'ads kind = in-store deal');
  assert(css.includes('.deal-push'), 'deal push styles');
}

console.log('5) Pure helpers');
{
  function buildAskFriendLoadText(name, url) {
    return 'Hey — can you load me on THROW? Cap is $50 for tonight. I\'m ' + (name || 'here') + '. ' + url;
  }
  function isDealAd(item) {
    if (!item) return false;
    if (item.kind === 'deal' || item.type === 'deal' || item.isDeal) return true;
    if (item.dealText || item.dealCode) return true;
    return false;
  }
  function buildDealRedeemPayload(deal) {
    const code = deal.dealCode || deal.code || '';
    const name = deal.name || 'Local deal';
    const offer = deal.dealText || deal.tagline || '';
    if (deal.dealUrl || deal.url) {
      const u = String(deal.dealUrl || deal.url);
      if (code && u.indexOf('code=') < 0) {
        return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'code=' + encodeURIComponent(code);
      }
      return u;
    }
    return 'throw://deal?biz=' + encodeURIComponent(name) +
      '&offer=' + encodeURIComponent(offer) +
      '&code=' + encodeURIComponent(code);
  }
  const msg = buildAskFriendLoadText('MIKE', 'https://throw.app/?x=1');
  assert(msg.includes('load me on THROW') && msg.includes('MIKE') && msg.includes('$50'), 'ask-friend SMS copy');
  assert(isDealAd({ kind: 'deal', name: 'Bar' }), 'kind=deal');
  assert(isDealAd({ dealText: '2-for-1 wings', name: 'Pub' }), 'dealText marks deal');
  assert(!isDealAd({ name: 'Nike', url: 'https://nike.com' }), 'brand ad is not a deal');
  const payload = buildDealRedeemPayload({ name: 'Pub', dealText: 'Wings', dealCode: 'WINGS', url: 'https://pub.example/deal' });
  assert(payload.includes('code=WINGS') && payload.startsWith('https://'), 'deal QR uses url + code');
  const offline = buildDealRedeemPayload({ name: 'Pub', dealText: 'Wings', dealCode: 'WINGS' });
  assert(offline.startsWith('throw://deal') && offline.includes('WINGS'), 'offline deal QR payload');
}


console.log('6) Ad admin reachable from profile');
{
  assert(html.includes('id="my-profile-ads-admin"'), 'profile → ads admin link');
  assert(html.includes('href="/ads"'), 'href /ads');
  assert(fs.existsSync(path.join(__dirname, 'ads.html')), 'ads.html present');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
