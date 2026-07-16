#!/usr/bin/env node
/** Ad inventory location scoring tests — node test-ads.js */

function haversineDistMi(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function pickAdsFromInventory(inventory, lat, lng) {
  if (!inventory?.zones) return [];
  const scored = [];
  for (const zone of inventory.zones) {
    if (zone.status && zone.status !== 'active') continue;
    const ads = (zone.ads || []).filter(a => a && a.name && a.status !== 'paused');
    if (!ads.length) continue;
    let score = 0;
    let dist = null;
    if (zone.type === 'global') score = 10;
    else if ((zone.type === 'geo' || zone.type === 'venue') && zone.lat != null && lat != null) {
      dist = haversineDistMi(lat, lng, Number(zone.lat), Number(zone.lng));
      const radius = Number(zone.radiusMi) || (zone.type === 'venue' ? 0.25 : 25);
      if (dist > radius) continue;
      score = zone.type === 'venue' ? 100 - dist * 10 : 70 - dist;
    } else if (zone.type === 'geo' || zone.type === 'venue') continue;
    for (const ad of ads) {
      scored.push({ ...ad, score: score + (Number(ad.bidCpc) || 0) * 0.01, zoneType: zone.type });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

let pass = 0, fail = 0;
function assert(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } }

const inv = {
  zones: [
    { id: 'g', name: 'Global', type: 'global', ads: [{ id: 1, name: 'GlobalBrand', bidCpc: 0.2, status: 'active' }] },
    { id: 'v', name: 'Club', type: 'venue', lat: 25.79, lng: -80.13, radiusMi: 0.25,
      ads: [{ id: 2, name: 'LIV', bidCpc: 1.5, status: 'active' }] },
    { id: 'c', name: 'Miami', type: 'geo', lat: 25.76, lng: -80.19, radiusMi: 15,
      ads: [{ id: 3, name: 'CityBar', bidCpc: 0.8, status: 'active' }] },
  ],
};

console.log('1) Near venue wins over city + global');
{
  const picked = pickAdsFromInventory(inv, 25.7901, -80.1301);
  assert(picked[0].name === 'LIV', 'venue ad is primary near pin');
}

console.log('2) Outside venue but in city → city wins');
{
  const picked = pickAdsFromInventory(inv, 25.76, -80.19);
  assert(picked[0].name === 'CityBar', 'city geo wins away from venue');
}

console.log('3) No GPS → only global');
{
  const picked = pickAdsFromInventory(inv, null, null);
  assert(picked.length === 1 && picked[0].name === 'GlobalBrand', 'global only without GPS');
}

console.log('4) Empty inventory → network fill path');
{
  const picked = pickAdsFromInventory({ zones: [] }, 25.79, -80.13);
  assert(picked.length === 0, 'empty → Coinzilla fill eligible');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
