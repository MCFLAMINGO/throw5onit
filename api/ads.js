// Vercel serverless — THROW ad resolve + click redirect
// GET  /api/ads?lat=&lng=           → { primary, strips[], source, network }
// GET  /api/ads/click?id=&url=&src= → 302 to advertiser (logs click)
// POST /api/ads/event               → { ok } impression/click telemetry
//
// Inventory is pushed live from /ads admin via MQTT retained topic throw/ads/inventory.
// This endpoint does not hold durable state — it accepts an optional `inventory` body
// for server-side tests, and otherwise returns network-fill guidance for the client.
// The client merges GPS + MQTT inventory; this API is the click gateway + Coinzilla config.

const COINZILLA_ZONE = process.env.COINZILLA_ZONE_ID || '';
const COINZILLA_VERIFY = process.env.COINZILLA_VERIFY || '83ee5bbfa0f3687d9c1df6d7e6209b51';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function haversineMi(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pickFromInventory(inventory, lat, lng) {
  if (!inventory || !Array.isArray(inventory.zones)) {
    return { primary: null, strips: [], source: 'empty' };
  }
  const now = Date.now();
  const scored = [];

  for (const zone of inventory.zones) {
    if (zone.status && zone.status !== 'active') continue;
    const ads = (zone.ads || []).filter(a => a && a.name && (!a.endsAt || a.endsAt > now));
    if (!ads.length) continue;

    let score = 0;
    let dist = null;
    if (zone.type === 'global') {
      score = 10;
    } else if (zone.type === 'city' && zone.city) {
      score = 40;
    } else if ((zone.type === 'geo' || zone.type === 'venue') && zone.lat != null && zone.lng != null && lat != null && lng != null) {
      dist = haversineMi(lat, lng, Number(zone.lat), Number(zone.lng));
      const radius = Number(zone.radiusMi) || (zone.type === 'venue' ? 0.25 : 25);
      if (dist <= radius) {
        score = zone.type === 'venue' ? 100 - dist * 10 : 70 - dist;
      } else {
        continue;
      }
    } else if (zone.type === 'geo' || zone.type === 'venue') {
      // No GPS — skip geo/venue
      continue;
    }

    for (const ad of ads) {
      scored.push({
        ...ad,
        zoneId: zone.id,
        zoneName: zone.name,
        zoneType: zone.type,
        dist,
        score: score + (Number(ad.bidCpc) || 0) * 0.01,
        isVenue: zone.type === 'venue',
        venueId: zone.venueId || zone.id,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const primary = scored[0] || null;
  const strips = scored.slice(0, 8);
  return {
    primary,
    strips,
    source: primary ? (primary.zoneType || 'direct') : 'empty',
  };
}

function safeUrl(u) {
  try {
    const url = new URL(String(u));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch (_) {
    return null;
  }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/^\/api\/ads\/?/, '') || '';

  // ── Click redirect ──────────────────────────────────────────────────────
  // Supports /api/ads/click?url=… (rewritten) and /api/ads?url=…
  if (req.method === 'GET' && (path === 'click' || url.searchParams.get('url') || url.searchParams.get('to'))) {
    const dest = safeUrl(url.searchParams.get('url') || url.searchParams.get('to'));
    const id = url.searchParams.get('id') || 'unknown';
    const src = url.searchParams.get('src') || 'strip';
    // Fire-and-forget log header for Vercel logs
    console.log(JSON.stringify({
      event: 'ad_click',
      id,
      src,
      dest,
      ts: Date.now(),
      ua: req.headers['user-agent'] || '',
    }));
    if (!dest) return res.status(400).json({ error: 'invalid url' });
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(302, { Location: dest });
    return res.end();
  }

  // ── Config / resolve ────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const lat = url.searchParams.get('lat');
    const lng = url.searchParams.get('lng');
    const latN = lat != null && lat !== '' ? Number(lat) : null;
    const lngN = lng != null && lng !== '' ? Number(lng) : null;

    // Optional inventory passed as base64 JSON for testing — production client
    // resolves from MQTT; this returns network fill config always.
    let picked = { primary: null, strips: [], source: 'empty' };
    const invB64 = url.searchParams.get('inv');
    if (invB64) {
      try {
        const inventory = JSON.parse(Buffer.from(invB64, 'base64').toString('utf8'));
        picked = pickFromInventory(inventory, latN, lngN);
      } catch (_) {}
    }

    return res.status(200).json({
      ok: true,
      ...picked,
      network: {
        provider: 'coinzilla',
        zoneId: COINZILLA_ZONE || null,
        verify: COINZILLA_VERIFY,
        enabled: !!COINZILLA_ZONE,
        // Client embeds Coinzilla when no direct sold ad wins for this location
        fillWhenEmpty: true,
      },
      geo: latN != null ? { lat: latN, lng: lngN } : null,
      ts: Date.now(),
    });
  }

  // ── Telemetry ───────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {};
    console.log(JSON.stringify({
      event: body.event || 'ad_event',
      id: body.id,
      sponsor: body.sponsor,
      src: body.src,
      lat: body.lat,
      lng: body.lng,
      ts: Date.now(),
    }));
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'method not allowed' });
}
