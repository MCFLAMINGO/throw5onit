/* ── THROW CLAIM ENGINE ──────────────────────────────────────────────────
   Throw money at anyone — even if they don't have the app yet.
   Money sits in an escrow pot. Link/SMS/NFC unlocks it into their pocket.
   Claim record lives on MQTT retained topic throw5/claims/{claimId}.
   claimId is the capability secret (unguessable).
   ─────────────────────────────────────────────────────────────────────── */

const CLAIM_TOPIC_PREFIX = 'throw5/claims/';
const CLAIM_OUTBOX_KEY   = 'throw_claim_outbox';
const CLAIM_INBOX_KEY    = 'throw_claim_pending_id';

function claimTopic(id) {
  return CLAIM_TOPIC_PREFIX + id;
}

function claimPublicUrl(claimId) {
  const origin = (typeof location !== 'undefined' && location.origin)
    ? location.origin
    : 'https://www.throw5onit.com';
  return origin + '/c/' + claimId;
}

function generateClaimId() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function loadClaimOutbox() {
  try { return JSON.parse(localStorage.getItem(CLAIM_OUTBOX_KEY) || '[]'); } catch(_) { return []; }
}

function saveClaimOutbox(list) {
  try { localStorage.setItem(CLAIM_OUTBOX_KEY, JSON.stringify(list.slice(0, 40))); } catch(_) {}
}

function rememberOutgoingClaim(rec) {
  const list = loadClaimOutbox().filter(c => c.claimId !== rec.claimId);
  list.unshift(rec);
  saveClaimOutbox(list);
}

function markOutgoingClaimClaimed(claimId, byAddr) {
  const list = loadClaimOutbox().map(c => {
    if (c.claimId === claimId) return { ...c, status: 'claimed', claimedBy: byAddr, claimedAt: Date.now() };
    return c;
  });
  saveClaimOutbox(list);
}

/** Publish claim record (retained) via MQTT + HTTP relay fallback */
function publishClaimRecord(record) {
  const topic = claimTopic(record.claimId);
  const payload = JSON.stringify(record);

  // HTTP relay (reliable on flaky mobile networks)
  try {
    fetch('/api/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...record, topic, retain: true, event: 'claim_open' }),
    }).catch(() => {});
  } catch(_) {}

  // Direct MQTT
  try {
    if (typeof mqtt === 'undefined') return;
    const c = mqtt.connect(typeof MQTT_BROKER !== 'undefined' ? MQTT_BROKER : 'wss://broker.emqx.io:8084/mqtt', {
      clientId: 'clm_' + Math.random().toString(36).slice(2, 8),
      clean: true, connectTimeout: 6000, reconnectPeriod: 0,
    });
    c.on('connect', () => {
      c.publish(topic, payload, { qos: 1, retain: true }, () => {
        try { c.end(true); } catch(_) {}
      });
    });
    c.on('error', () => { try { c.end(true); } catch(_) {} });
  } catch(_) {}
}

function clearClaimRecord(claimId) {
  const topic = claimTopic(claimId);
  try {
    fetch('/api/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, retain: true, clear: true, event: 'claim_clear' }),
    }).catch(() => {});
  } catch(_) {}
  try {
    if (typeof mqtt === 'undefined') return;
    const c = mqtt.connect(typeof MQTT_BROKER !== 'undefined' ? MQTT_BROKER : 'wss://broker.emqx.io:8084/mqtt', {
      clientId: 'clx_' + Math.random().toString(36).slice(2, 8),
      clean: true, connectTimeout: 5000, reconnectPeriod: 0,
    });
    c.on('connect', () => {
      c.publish(topic, '', { qos: 1, retain: true }, () => { try { c.end(true); } catch(_) {} });
    });
  } catch(_) {}
}

/** Fetch retained claim — resolves null on timeout/missing */
function fetchClaimRecord(claimId, timeoutMs) {
  timeoutMs = timeoutMs || 6000;
  return new Promise((resolve) => {
    if (!claimId || typeof mqtt === 'undefined') { resolve(null); return; }
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { c.end(true); } catch(_) {}
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const topic = claimTopic(claimId);
    const c = mqtt.connect(typeof MQTT_BROKER !== 'undefined' ? MQTT_BROKER : 'wss://broker.emqx.io:8084/mqtt', {
      clientId: 'clf_' + Math.random().toString(36).slice(2, 8),
      clean: true, connectTimeout: 5000, reconnectPeriod: 0,
    });
    c.on('connect', () => c.subscribe(topic, { qos: 1 }));
    c.on('message', (t, buf) => {
      if (t !== topic) return;
      const raw = buf.toString();
      if (!raw) { finish(null); return; }
      try { finish(JSON.parse(raw)); } catch(_) { finish(null); }
    });
    c.on('error', () => finish(null));
  });
}

/**
 * Create an open claim: escrow + fund + publish.
 * Requires host app helpers: getViem, sendEscrowDeposit / demo debit, DEMO_MODE, state
 */
async function createOpenClaim(opts) {
  opts = opts || {};
  const amount = Number(opts.amount);
  if (!(amount > 0)) throw new Error('Invalid amount');
  const fromAddr = opts.fromAddr || (typeof state !== 'undefined' && state.account?.address);
  if (!fromAddr) throw new Error('Wallet not ready');

  const claimId = generateClaimId();
  const toHint = (opts.toHint || '').trim(); // phone, email, or name — optional
  const memo = (opts.memo || '').trim();

  let escrowAddr = null;
  let escrowKey = null;

  if (typeof DEMO_MODE !== 'undefined' && DEMO_MODE) {
    // Demo: no chain escrow — claim redeem credits locally
    escrowAddr = '0xCLAIM' + claimId.slice(0, 34);
    escrowKey = 'demo:' + claimId;
    if (state.total < amount) throw new Error('Insufficient demo balance');
    state.total = Math.max(0, state.total - amount);
    state.pathUSD = state.total;
    try { localStorage.setItem('throw_demo_balance', state.total.toFixed(6)); } catch(_) {}
    if (typeof renderWalletUI === 'function') renderWalletUI();
  } else {
    const { ethers } = await getViem();
    const w = ethers.Wallet.createRandom();
    escrowAddr = w.address;
    escrowKey = w.privateKey;
    // Full face amount into escrow (claim redeem pays net to catcher; optional fee already taken on throw path if desired)
    await sendEscrowDeposit(escrowAddr, amount);
  }

  const record = {
    event: 'claim_open',
    claimId,
    amount,
    netAmount: amount, // face value in pot; fee already paid by thrower on create if using sendStablecoin elsewhere
    escrowAddr,
    escrowKey, // capability-bound to claimId URL — do not log publicly
    from: fromAddr,
    fromName: opts.fromName || (typeof getHandle === 'function' ? getHandle() : '') || fromAddr.slice(0, 6),
    toHint: toHint || null,
    memo: memo || null,
    status: 'open',
    demo: !!(typeof DEMO_MODE !== 'undefined' && DEMO_MODE),
    createdAt: Date.now(),
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  };

  publishClaimRecord(record);
  rememberOutgoingClaim({
    claimId,
    amount,
    toHint: record.toHint,
    fromName: record.fromName,
    url: claimPublicUrl(claimId),
    status: 'open',
    createdAt: record.createdAt,
    escrowAddr,
  });

  return {
    claimId,
    url: claimPublicUrl(claimId),
    amount,
    escrowAddr,
    record,
  };
}

/** Redeem an open claim into toAddr */
async function redeemOpenClaim(claimId, toAddr) {
  if (!claimId || !toAddr) throw new Error('Missing claim or wallet');
  const rec = await fetchClaimRecord(claimId);
  if (!rec || !rec.escrowKey) throw new Error('Claim not found or already claimed');
  if (rec.status && rec.status !== 'open') throw new Error('Claim already ' + rec.status);
  if (rec.expiresAt && Date.now() > rec.expiresAt) throw new Error('Claim expired');

  const amount = Number(rec.netAmount || rec.amount) || 0;
  if (!(amount > 0)) throw new Error('Empty claim');

  // Don't let sender redeem their own throw by accident on same phone unless demo testing
  if (rec.from && rec.from.toLowerCase() === toAddr.toLowerCase()) {
    // Allow — user might be testing; still fine
  }

  if (rec.demo || String(rec.escrowKey).startsWith('demo:')) {
    if (typeof DEMO_MODE !== 'undefined' && DEMO_MODE) {
      state.total = (state.total || 0) + amount;
      state.pathUSD = state.total;
      try { localStorage.setItem('throw_demo_balance', state.total.toFixed(6)); } catch(_) {}
      if (typeof renderWalletUI === 'function') renderWalletUI();
    } else {
      // Demo claim opened in demo mode but claimer is live — still credit demo if they flip, else no-op chain
      state.total = (state.total || 0) + amount;
      state.pathUSD = state.total;
      try { localStorage.setItem('throw_demo_balance', state.total.toFixed(6)); } catch(_) {}
      if (typeof renderWalletUI === 'function') renderWalletUI();
    }
  } else {
    // Live: drain escrow → claimer via sponsor path
    if (typeof _escrowSend !== 'function') throw new Error('Payout engine not ready');
    const wc = { _escrowPK: rec.escrowKey };
    await _escrowSend(wc, {}, toAddr, amount);
  }

  // Clear retained claim so link can't be reused
  clearClaimRecord(claimId);
  markOutgoingClaimClaimed(claimId, toAddr);

  // Notify sender wallet topic
  try {
    const msg = {
      event: 'claim_claimed',
      claimId,
      amount,
      by: toAddr,
      ts: Date.now(),
    };
    fetch('/api/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...msg,
        to: rec.from,
        topic: 'throw5/wallet/' + String(rec.from).toLowerCase() + '/credit',
      }),
    }).catch(() => {});
  } catch(_) {}

  return { amount, fromName: rec.fromName, from: rec.from, claimId };
}

/** Parse claim id from URL path /c/ID or ?claim= */
function parseClaimIdFromLocation(loc) {
  loc = loc || (typeof location !== 'undefined' ? location : null);
  if (!loc) return null;
  try {
    const params = new URLSearchParams(loc.search || '');
    const q = params.get('claim');
    if (q && /^[a-f0-9]{16,64}$/i.test(q)) return q.toLowerCase();
  } catch(_) {}
  const m = String(loc.pathname || '').match(/\/c\/([a-f0-9]{16,64})\/?$/i);
  if (m) return m[1].toLowerCase();
  return null;
}

function stashPendingClaimId(claimId) {
  try { sessionStorage.setItem(CLAIM_INBOX_KEY, claimId); } catch(_) {}
  try { localStorage.setItem(CLAIM_INBOX_KEY, claimId); } catch(_) {}
}

function readPendingClaimId() {
  try {
    return sessionStorage.getItem(CLAIM_INBOX_KEY)
      || localStorage.getItem(CLAIM_INBOX_KEY)
      || parseClaimIdFromLocation()
      || null;
  } catch(_) {
    return parseClaimIdFromLocation();
  }
}

function clearPendingClaimId() {
  try { sessionStorage.removeItem(CLAIM_INBOX_KEY); } catch(_) {}
  try { localStorage.removeItem(CLAIM_INBOX_KEY); } catch(_) {}
}

/** Web Share claim link (SMS/iMessage/etc.) */
async function shareClaimLink(claim, extraText) {
  const url = claim.url || claimPublicUrl(claim.claimId);
  const amount = claim.amount;
  const text = extraText || (`I threw you $${Number(amount).toFixed(2)} on THROW. Tap to put it in your pocket: ${url}`);
  if (navigator.share) {
    try {
      await navigator.share({ title: 'THROW — cash for you', text, url });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'aborted';
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch(_) {
    return 'link:' + url;
  }
}

/** Contacts Picker API — returns { name, tel, email } or null */
async function pickDeviceContact() {
  const supported = 'contacts' in navigator && 'ContactsManager' in window;
  if (!supported) return null;
  try {
    const props = ['name', 'tel', 'email'];
    const opts = { multiple: false };
    const sel = await navigator.contacts.select(props, opts);
    if (!sel || !sel[0]) return null;
    const c = sel[0];
    return {
      name: (c.name && c.name[0]) || 'Friend',
      tel: (c.tel && c.tel[0]) || '',
      email: (c.email && c.email[0]) || '',
    };
  } catch(_) {
    return null;
  }
}

/** WebNFC — write claim URL to tag */
async function nfcWriteClaimUrl(url) {
  if (!('NDEFReader' in window)) throw new Error('NFC not supported on this phone');
  const reader = new NDEFReader();
  await reader.write({
    records: [{ recordType: 'url', data: url }],
  });
  return true;
}

/** WebNFC — read URL from tag (one shot) */
async function nfcReadClaimUrl(timeoutMs) {
  if (!('NDEFReader' in window)) throw new Error('NFC not supported on this phone');
  timeoutMs = timeoutMs || 15000;
  const reader = new NDEFReader();
  await reader.scan();
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('NFC timeout')), timeoutMs);
    reader.onreading = (event) => {
      clearTimeout(timer);
      for (const record of event.message.records) {
        if (record.recordType === 'url' || record.recordType === 'text') {
          const dec = new TextDecoder();
          const str = dec.decode(record.data);
          resolve(str);
          return;
        }
      }
      reject(new Error('No URL on tag'));
    };
    reader.onerror = () => { clearTimeout(timer); reject(new Error('NFC error')); };
  });
}

/** Push permission + subscription scaffold (needs VAPID on server to push) */
async function enableThrowPush() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    return { ok: false, reason: 'unsupported' };
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, reason: 'denied' };
  try {
    const reg = await navigator.serviceWorker.ready;
    // VAPID public key optional — store permission flag even without push subscription
    try { localStorage.setItem('throw_push_enabled', '1'); } catch(_) {}
    let sub = null;
    try {
      sub = await reg.pushManager.getSubscription();
      if (!sub) {
        // Without applicationServerKey, some browsers still allow; others need VAPID
        const vapid = (typeof window !== 'undefined' && window.THROW_VAPID_PUBLIC) || null;
        if (vapid) {
          const key = urlBase64ToUint8Array(vapid);
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        }
      }
    } catch(_) {}
    if (sub) {
      try { localStorage.setItem('throw_push_sub', JSON.stringify(sub)); } catch(_) {}
    }
    return { ok: true, subscription: sub };
  } catch (e) {
    return { ok: false, reason: e.message || 'error' };
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
