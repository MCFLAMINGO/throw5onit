/* ── THROW PWA ── app.js ─────────────────────────────────────────────── */
/* Tempo chain ID 4217 | pathUSD + USDC | ethers.js bundled locally (no CDN) */

/* ═══════════════════════════════════════════════════════════════════════
   0. IMPORTS (local bundle — eliminates CDN XSS/supply-chain risk)
   ═════════════════════════════════════════════════════════════════════ */

// ethers.bundle.js is loaded as a classic <script> before this file.
// It exposes ethers on window.__ethers__
let ethersLib = null;
async function getViem() {
  if (ethersLib) return ethersLib;
  // Bundle sets window.__ethers__ = the ethers namespace object directly
  // All callers do: const { ethers } = await getViem()
  // So we must return { ethers: <namespace> }
  if (typeof window.__ethers__ !== 'undefined') {
    ethersLib = { ethers: window.__ethers__ };
    return ethersLib;
  }
  // Fallback: dynamic import — bundle may also export as default or named
  try {
    const mod = await import('./ethers.bundle.js');
    // mod may be the namespace directly or { default: namespace }
    const ns = mod.ethers || mod.default || mod;
    ethersLib = { ethers: ns };
    return ethersLib;
  } catch(e) {
    console.error('[THROW] ethers bundle failed to load:', e);
    alert('Failed to load wallet library. Please refresh the page.');
    throw e;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   1. CONSTANTS
   ═════════════════════════════════════════════════════════════════════ */
const TEMPO_RPC   = 'https://tempo-mainnet.core.chainstack.com/b6e3587d839ae0350e2a75f3aac441b2';
const CHAIN_ID    = 4217n;

const PATHUSD_ADDR = '0x20c0000000000000000000000000000000000000';
const USDC_ADDR    = '0x20c000000000000000000000b9537d11c60e8b50';

// Treasury wallet — receives $0.10 service fee on every throw
const TREASURY_ADDR = '0x774f484192Cf3F4fB9716Af2e15f44371fD32FEA'; // THROW treasury — Tempo Wallet
// Tiered service fee by throw amount
// THROW fee: 1% on $1 bets, 3% on everything else
// Applied at settlement — deducted from pot before winner receives
function getThrowFee(amount) {
  // Regular throws: flat 1% always
  return Math.round(amount * 0.01 * 1e6) / 1e6;
}
function getBetFee(amount) {
  // Bets: 1% on $1, 3% on everything else
  if (amount <= 1) return Math.round(amount * 0.01 * 1e6) / 1e6;
  return Math.round(amount * 0.03 * 1e6) / 1e6;
}

// Tempo DEX — fee is swapped through AMM so we earn the 0.3% LP fee on our own volume
const TEMPO_DEX_ADDR = '0xDEc0000000000000000000000000000000000000';

/* ── DEMO MODE ── set true to use fake money (no chain txs) */
let DEMO_MODE = (() => {
  try { return localStorage.getItem('throw_demo_mode') === 'true'; } catch(_) { return false; }
})();
const DEMO_START_BALANCE = 50.00; // each new wallet gets $50 play money

function setDemoMode(on) {
  DEMO_MODE = on;
  try { localStorage.setItem('throw_demo_mode', on ? 'true' : 'false'); } catch(_) {}
  renderDemoBanner();
  if (on) {
    state.pathUSD = DEMO_START_BALANCE;
    state.usdc    = 0;
    state.total   = DEMO_START_BALANCE;
    renderWalletUI();
  }
}

function renderDemoBanner() {
  const banner = document.getElementById('demo-banner');
  if (banner) banner.classList.toggle('hidden', !DEMO_MODE);

  // Update wallet screen button label
  const lbl = document.getElementById('demo-mode-btn-label');
  const btn = document.getElementById('btn-demo-toggle');
  if (lbl) lbl.textContent = DEMO_MODE ? 'DEMO MODE ON' : 'ENABLE DEMO MODE';
  if (btn) {
    btn.classList.toggle('active', DEMO_MODE);
    const sub = btn.querySelector('.demo-mode-btn-sub');
    if (sub) sub.textContent = DEMO_MODE ? 'Tap to turn off — real money mode' : 'Test with $50 play money';
  }

  // Sync checkbox in profile modal
  const toggle = document.getElementById('demo-toggle');
  if (toggle) toggle.checked = DEMO_MODE;
}

// Fake tx: 1.5s delay, deduct locally, publish credit to receiver via MQTT, return fake hash
async function demoSendStablecoin(toAddr, usdAmount) {
  const fee    = getThrowFee(usdAmount);
  const net    = Math.max(0, usdAmount - fee);
  if (state.total < usdAmount) throw new Error('Insufficient demo balance');

  // 0.5/0.5 venue split in demo mode too
  const isAtVenue = !!(_activeSponsor?.isVenue && _activeSponsor?.venueId);
  const venueFee  = isAtVenue ? Math.round(fee * 0.5 * 1e6) / 1e6 : 0;
  if (venueFee > 0) accrueVenueFee(_activeSponsor.venueId, _activeSponsor.name, venueFee, usdAmount);

  // Deduct sender
  state.total   = Math.max(0, state.total - usdAmount);
  state.pathUSD = state.total;
  try { localStorage.setItem('throw_demo_balance', state.total.toFixed(6)); } catch(_) {}
  renderWalletUI();
  // Simulate network delay
  await new Promise(r => setTimeout(r, 1500));
  // Fake hash
  const hash = '0xDEMO' + Math.random().toString(16).slice(2, 14).toUpperCase();
  // Credit receiver via MQTT demo topic (if they're in the same room)
  if (room.client && room.code) {
    const msg = JSON.stringify({
      event: 'demo_credit',
      to:    toAddr,
      from:  state.account.address,
      amount: net,
      hash,
      ts: Date.now(),
    });
    room.client.publish('throw5/room/' + room.code + '/demo', msg, { qos: 0 });
  }
  // Also broadcast globally so receiver sees credit even without shared room
  _demoCreditGlobal(toAddr, net, hash);
  state.txHistory.unshift({ type: 'sent', amount: usdAmount, to: toAddr, hash, ts: Date.now() });
  return hash;
}

function _demoCreditGlobal(toAddr, amount, hash) {
  // Publish on a per-address topic so receiver always gets credited
  try {
    const clientId = 'throw_dcr_' + Math.random().toString(36).slice(2,8);
    const c = mqtt.connect(MQTT_BROKER, { clientId, clean: true, connectTimeout: 6000, reconnectPeriod: 0 });
    c.on('connect', () => {
      const msg = JSON.stringify({ event: 'demo_credit', to: toAddr, from: state.account?.address, amount, hash, ts: Date.now() });
      c.publish('throw5/wallet/' + toAddr.toLowerCase() + '/credit', msg, { qos: 0 }, () => {
        try { c.end(true); } catch(_) {}
      });
    });
    c.on('error', () => { try { c.end(true); } catch(_) {} });
  } catch(_) {}
}

// Tell the other device they were scanned — they auto-add us back
function _notifyContactAdded(toAddr, myAddr, myName) {
  try {
    const msg = JSON.stringify({ event: 'contact_added', to: toAddr, fromAddr: myAddr, fromName: myName, ts: Date.now() });
    const topic = 'throw5/wallet/' + toAddr.toLowerCase() + '/credit';
    const clientId = 'throw_ca_' + Math.random().toString(36).slice(2,8);
    const c = mqtt.connect(MQTT_BROKER, { clientId, clean: true, connectTimeout: 6000, reconnectPeriod: 0 });
    c.on('connect', () => {
      c.publish(topic, msg, { qos: 1 }, () => { try { c.end(true); } catch(_) {} });
    });
    c.on('error', () => { try { c.end(true); } catch(_) {} });
  } catch(_) {}
}

/* ── Notify receiver — relay (primary) + MQTT (parallel) ── */
function notifyReceiverDirect(toAddr, amount) {
  if (!toAddr || !amount) return;
  const payload = {
    event: 'proximity_throw',
    to: toAddr,
    from: state.account?.address,
    fromName: getHandle() || (state.account?.address?.slice(0,6) || ''),
    amount,
    throwId: Date.now().toString(36),
    ts: Date.now(),
  };
  // Fire both simultaneously — relay is guaranteed, MQTT is faster if it works
  relayThrow(payload);
  try {
    const c = mqtt.connect(MQTT_BROKER, { clientId: 'nr_' + Math.random().toString(36).slice(2,7), clean: true, connectTimeout: 4000, reconnectPeriod: 0 });
    c.on('connect', () => {
      c.publish('throw5/wallet/' + toAddr.toLowerCase() + '/credit', JSON.stringify(payload), { qos: 1 }, () => { try { c.end(true); } catch(_) {} });
    });
    c.on('error', () => { try { c.end(true); } catch(_) {} });
    setTimeout(() => { try { c.end(true); } catch(_) {} }, 8000);
  } catch(_) {}
}

/* ── HTTP relay — Vercel serverless publishes MQTT server-side ── */
function relayThrow(payload) {
  fetch('/api/relay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

// Tempo Points — local tally of on-chain throws (airdrop eligibility tracking)
const points = {
  throws: 0,
  totalVolume: 0,   // USD
  save() {
    // In-memory only — resets on page close (no persistence by design)
  },
  add(usdAmount) {
    this.throws++;
    this.totalVolume += usdAmount;
    this.save();
    renderPoints();
  },
};

const ERC20_ABI = [
  { name: 'balanceOf',  type: 'function', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }] },
  { name: 'decimals',   type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { name: 'transfer',   type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }] },
  { name: 'approve',    type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }] },
  { name: 'allowance',  type: 'function', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }] },
];

const CAP_USD = 50;
const MEMO    = 'THROW';

/* ═══════════════════════════════════════════════════════════════════════
   2. WALLET STATE
   ═════════════════════════════════════════════════════════════════════ */
const state = {
  account:    null,   // { address, privateKey }
  pathUSD:    0,      // in USD
  usdc:       0,      // in USD
  total:      0,      // pathUSD + usdc
  txHistory:  [],

  // Bet state
  bet: {
    active:     false,
    isHost:     false,
    description: '',
    amountPer:  5,
    structure:  'winner-all',
    escrowKey:  null,
    escrowAddr: null,
    hostAddr:   null,
    roomCode:   null,
    players:    [],   // { addr, name, amount, side }
    total:      0,
    yesPot:     0,
    noPot:      0,
    side:       null,
  },

  // Pending bet from another host (drives THROW button glow)
  pendingBet: null,
  betJoined:  false, // true after successfully joining a bet this session

  // Throw state
  throwAmount: 5,
  throwMethod: 'gesture',
  throwTarget: null,      // { name, addr } — contact selected on throw screen
  pendingThrowId: null,   // dedup: only process each throwId once

  // Room state
  inRoom: false,
  roomCode: null,
  roomPeers: [],        // [{addr, name, heading}]
  currentTarget: null,  // peer currently aimed at
  headingPollInterval: null,
};

/* ═══════════════════════════════════════════════════════════════════════
   3. SCREEN ROUTER
   ═════════════════════════════════════════════════════════════════════ */
let currentScreen = 'setup';

function showScreen(id) {
  const prev = document.querySelector('.screen.active');
  if (prev) {
    prev.classList.add('exit');
    setTimeout(() => prev.classList.remove('active', 'exit'), 280);
  }
  const next = document.getElementById('screen-' + id);
  if (!next) return;
  setTimeout(() => {
    next.classList.add('active');
    currentScreen = id;
    // When navigating TO first-scan, always reset so camera button is visible
    if (id === 'first-scan') {
      stopFirstScan();
      const startBtn = document.getElementById('btn-first-scan-start');
      if (startBtn) { startBtn.style.display = ''; startBtn.textContent = 'Tap to Open Camera'; }
      const status = document.getElementById('first-scan-status');
      if (status) status.textContent = '';
    }
    // Always re-render crew when returning to wallet
    if (id === 'wallet') {
      renderCrew();
    }
  }, prev ? 30 : 0);
}

/* ═══════════════════════════════════════════════════════════════════════
   4. WALLET GENERATION & PERSISTENCE
   ═════════════════════════════════════════════════════════════════════ */
async function generateWallet() {
  const { ethers } = await getViem();
  const w = ethers.Wallet.createRandom();
  return { privateKey: w.privateKey, address: w.address };
}

async function importWallet(pk) {
  const { ethers } = await getViem();
  if (!pk.startsWith('0x')) pk = '0x' + pk;
  const w = new ethers.Wallet(pk);
  return { privateKey: w.privateKey, address: w.address };
}

/* ── IndexedDB key store (primary) — iOS never evicts IDB the way it evicts localStorage ── */
const IDB_DB   = 'throw_idb';
const IDB_STORE = 'kv';
let _idb = null;

async function openIDB() {
  if (_idb) return _idb;
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
    req.onsuccess = e => { _idb = e.target.result; res(_idb); };
    req.onerror   = () => rej(req.error);
  });
}
async function idbSet(key, val) {
  try {
    const db = await openIDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch(e) { console.warn('idbSet failed', e); }
}
async function idbGet(key) {
  try {
    const db = await openIDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => res(req.result ?? null);
      req.onerror   = () => rej(req.error);
    });
  } catch(e) { return null; }
}

// Persist private key — IndexedDB primary, localStorage fallback
let _storedPK = null;

function saveWallet(acc) {
  _storedPK = acc.privateKey;
  idbSet('throw_pk', acc.privateKey);  // primary (async, fire-and-forget)
  try { localStorage.setItem('throw_pk', acc.privateKey); } catch(e) {}  // fallback
}

async function loadWallet() {
  if (!_storedPK) {
    // Try IndexedDB first
    _storedPK = await idbGet('throw_pk');
  }
  if (!_storedPK) {
    // Fall back to localStorage
    try { _storedPK = localStorage.getItem('throw_pk'); } catch(e) {}
  }
  if (_storedPK) {
    // Write back to IDB in case it was only in localStorage
    idbSet('throw_pk', _storedPK);
  }
  if (!_storedPK) return null;
  return importWallet(_storedPK);
}

async function initWallet(acc, isNew = false) {
  state.account = acc;
  saveWallet(acc);
  updateAddrDisplay();

  // showScreen FIRST — never let balance loading block navigation
  showScreen('wallet');

  try {
    if (DEMO_MODE) {
      const saved = parseFloat(localStorage.getItem('throw_demo_balance') || '0');
      state.pathUSD = saved > 0 ? saved : DEMO_START_BALANCE;
      state.usdc    = 0;
      state.total   = state.pathUSD;
      renderWalletUI();
    } else {
      await refreshBalances();
    }
  } catch(e) {
    // Balance load failed — show $0 but don't block the user
    state.pathUSD = 0; state.usdc = 0; state.total = 0;
    renderWalletUI();
  }

  try { subscribeDemoCredits(state.account.address); } catch(_) {}
  try { subscribeSponsorChannel(); } catch(_) {}
  try { renderDemoBanner(); } catch(_) {}

  // Restore active bet if host reloaded mid-bet — defer until after DOM is fully ready
  setTimeout(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('throw_active_bet') || 'null');
      if (saved && saved.isHost && saved.escrowKey && saved.active) {
        Object.assign(state.bet, saved);
        const onBetJoin = (data) => {
          addPlayerToPot(data.addr, data.name || data.addr.slice(0,6), data.amount, data.side);
        };
        enterRoom(saved.roomCode, { onBetJoin }).catch(() => {});
        room.onBetJoin = onBetJoin;
        showScreen('pot');
        setTimeout(() => {
          renderPotScreen();
          if (state.bet.players.length) {
            renderPotPlayers();
            const totalEl = document.getElementById('pot-total');
            if (totalEl) totalEl.textContent = '$' + state.bet.total.toFixed(0);
            document.getElementById('pot-orb')?.classList.add('live');
          }
          const statusEl = document.getElementById('pot-status');
          if (statusEl) statusEl.textContent = 'Bet restored — ready to settle';
          const settleRow = document.getElementById('settle-row');
          if (settleRow) settleRow.style.display = '';
        }, 350);
      }
    } catch(_) {}
  }, 800);

  // If no active host bet in localStorage, clear any stale retained global bet on broker
  // This prevents the glow persisting after a failed/abandoned settlement
  try {
    const savedCheck = JSON.parse(localStorage.getItem('throw_active_bet') || 'null');
    if (!savedCheck || !savedCheck.active) {
      clearGlobalBet();
    }
  } catch(_) {}

  // Start background bet scanner — glows THROW button if an open bet is nearby
  try { startBetScanner(); } catch(_) {}

  if (isNew) {
    setTimeout(async () => {
      try {
        const backed = await hasBackedUp();
        if (!backed) offerBackup(acc);
      } catch(_) {}
    }, 800);
  }
}

// Subscribe to global sponsor broadcast channel (throw/sponsor, retained)
// Called at page load — no wallet required. Gets retained message from broker immediately.
function subscribeSponsorChannel() {
  try {
    const clientId = 'throw_spn_' + Math.random().toString(36).slice(2, 8);
    const c = mqtt.connect(MQTT_BROKER, { clientId, clean: true, connectTimeout: 8000, reconnectPeriod: 0 });
    c.on('connect', () => c.subscribe('throw/sponsor', { qos: 0 }));
    c.on('message', (_t, msg) => {
      try {
        const data = JSON.parse(msg.toString());
        const sp = data.sponsor || null;
        try { localStorage.setItem('throw_active_sponsor', JSON.stringify(sp)); } catch(_) {}
        setSponsor(sp);
      } catch(_) {}
    });
    c.on('error', () => {});
  } catch(_) {}
}

function subscribeDemoCredits(myAddr) {
  if (!myAddr) return;
  const topic = 'throw5/wallet/' + myAddr.toLowerCase() + '/credit';
  const clientId = 'throw_sub_' + Math.random().toString(36).slice(2,8);
  const c = mqtt.connect(MQTT_BROKER, { clientId, clean: true, connectTimeout: 8000, reconnectPeriod: 3000 });
  c.on('connect', () => c.subscribe(topic, { qos: 0 }));
  c.on('message', (_t, msg) => {
    try {
      const data = JSON.parse(msg.toString());
      const myAddrLc = myAddr.toLowerCase();
      const toMatch  = data.to && data.to.toLowerCase() === myAddrLc;

      // Demo credit — credit balance directly (never blocked by catchState.fired)
      if ((data.event === 'demo_credit' || data.event === 'proximity_throw') && toMatch) {
        const amt = parseFloat(data.amount) || 0;
        const fromName = data.fromName || (data.from ? data.from.slice(0,6) : 'Someone');
        if (amt > 0) {
          // Always credit the balance regardless of catch screen state
          if (DEMO_MODE) {
            state.total   += amt;
            state.pathUSD  = state.total;
            try { localStorage.setItem('throw_demo_balance', state.total.toFixed(6)); } catch(_) {}
            renderWalletUI();
          }
          // Show flash notification
          showTxFlash('💸', '$' + amt.toFixed(2), fromName + ' threw you $' + amt.toFixed(2) + '!');
          moneyRain();
          setTimeout(() => hideTxFlash(), 3000);
          state.txHistory.unshift({ type: 'received', amount: amt, from: fromName, ts: Date.now() });
          // If catch window is active, also complete it
          if (catchState.active && !catchState.fired) {
            onCatchHit(amt, fromName, data.throwId || null, data.event);
          }
        }
      }
      // Real throw notification
      if (data.event === 'throw_credit' && toMatch) {
        const fromName = data.fromName || (data.from ? data.from.slice(0,6) : 'Someone');
        showTxFlash('💸', '$' + data.amount, fromName + ' threw you $' + data.amount + '!');
        setTimeout(() => hideTxFlash(), 3500);
        refreshBalances();
      }
      // Mutual contact add — someone scanned our QR, auto-add them back
      if (data.event === 'contact_added' && toMatch && data.fromAddr && data.fromName) {
        upsertContact(data.fromName, data.fromAddr);
        showToast('👋 ' + data.fromName + ' added you — added back!');
      }
      // Sponsor push via MQTT — update active sponsor for this session
      if (data.event === 'sponsor_push') {
        const sp = data.sponsor || null;
        try { localStorage.setItem('throw_active_sponsor', JSON.stringify(sp)); } catch(_) {}
        setSponsor(sp);
      }
    } catch(_) {}
  });
}

/* ══════════════════════════════════════════════════════════════════
   SPONSOR AD SYSTEM
   ══════════════════════════════════════════════════════════════════ */

// Active sponsor state
let _activeSponsor = null;  // { name, logoUrl, tagline, color }
let _stripAnimFrame = null;
let _stripOffset = 0;
let _stripItemHeight = 40; // px per item including gap
let _stripItems = [];       // array of { name, logoUrl }
let _stripCenterIdx = 0;
let _stripScrollInterval = null;
let _nudgeTimer = null;

// Default house brands for strips when no paid sponsor
const HOUSE_BRANDS = [
  { name: 'THROW', text: '\u{1F4B8}' },
  { name: '$$$',   text: '$' },
  { name: 'THROW', text: '\u26A1' },
  { name: 'TEMPO', text: 'T' },
  { name: 'THROW', text: '\u{1F3B0}' },
  { name: '$$$',   text: '\u{1F911}' },
];

function setSponsor(sponsor) {
  _activeSponsor = sponsor;
  renderOrbSponsor();
  renderSponsorStrips();
}

// Render sponsor logo in orb background
function renderOrbSponsor() {
  const bg = document.getElementById('orb-sponsor-bg');
  if (!bg) return;
  if (_activeSponsor?.logoUrl) {
    bg.innerHTML = `<img src="${_activeSponsor.logoUrl}" alt="${_activeSponsor.name}" />`;
    bg.classList.add('visible');
  } else {
    bg.innerHTML = '';
    bg.classList.remove('visible');
  }
}

// Build and start the vertical scrolling strips
function renderSponsorStrips() {
  // Populate both throw-screen strips AND wallet-screen strips
  const trackIds = ['sponsor-track-left', 'sponsor-track-right', 'wallet-track-left', 'wallet-track-right'];
  trackIds.forEach(trackId => {
    const side = trackId.includes('right') ? 'right' : 'left';
    const track = document.getElementById(trackId);
    if (!track) return;
    track.innerHTML = '';
    clearInterval(_stripScrollInterval);

    // Build item list — sponsor brand repeated + house brands as filler
    const items = [];
    if (_activeSponsor) {
      // Paid sponsor: interleave their logo with house brand separators
      for (let i = 0; i < 4; i++) items.push({ ..._activeSponsor, paid: true });
      HOUSE_BRANDS.forEach(b => items.push(b));
    } else {
      HOUSE_BRANDS.forEach(b => items.push(b));
    }
    // Double the list for seamless infinite loop
    const doubled = [...items, ...items];
    _stripItems = doubled;

    doubled.forEach((item, idx) => {
      const el = document.createElement('div');
      el.className = 'sponsor-item' + (item.text ? ' sponsor-text' : '');
      el.dataset.idx = idx;
      el.dataset.name = item.name || '';
      if (item.logoUrl) {
        const img = document.createElement('img');
        img.src = item.logoUrl;
        img.alt = item.name || '';
        el.appendChild(img);
      } else {
        el.textContent = item.text || item.name?.slice(0,3) || '$';
      }
      // Click = CPC event
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        logSponsorEvent('click', item);
        if (item.url) window.open(item.url, '_blank', 'noopener');
      });
      track.appendChild(el);
    });

    // CSS animation for smooth infinite scroll
    const totalItems = items.length;
    const itemH = 40; // 28px item + 12px gap
    const totalH = totalItems * itemH;
    track.style.animation = 'none';
    track.style.transform = 'translateY(0)';
    // Use CSS animation on the track
    track.style.animation = `stripScroll ${totalItems * 1.4}s linear infinite`;
    track.style.setProperty('--strip-half', `-${totalH}px`);
  });

  // Add CSS custom property animation target if not set
  if (!document.getElementById('strip-scroll-style')) {
    const s = document.createElement('style');
    s.id = 'strip-scroll-style';
    s.textContent = `@keyframes stripScroll { 0% { transform: translateY(0); } 100% { transform: translateY(var(--strip-half)); } }`;
    document.head.appendChild(s);
  }
}

// Log sponsor analytics event via MQTT
function logSponsorEvent(type, item) {
  // type: 'impression' | 'click' | 'throw_coincidence'
  const payload = {
    event:     'sponsor_event',
    type,
    sponsor:   item?.name || 'house',
    paid:      !!item?.paid,
    addr:      state.account?.address || 'anon',
    ts:        Date.now(),
  };
  // Publish to analytics topic (fire-and-forget)
  try {
    const c = mqtt.connect(MQTT_BROKER, {
      clientId: 'sp_' + Math.random().toString(36).slice(2,8),
      clean: true, connectTimeout: 4000, reconnectPeriod: 0,
    });
    c.on('connect', () => {
      c.publish('throw/sponsor/analytics', JSON.stringify(payload), { qos: 0 }, () => c.end(true));
    });
  } catch(_) {}
}

// Show post-throw sponsor credit line
function showThrowSponsorCredit(sponsorName) {
  const el = document.getElementById('throw-sponsor-credit');
  if (!el || !sponsorName) return;
  el.textContent = 'Throw powered by ' + sponsorName;
  el.classList.remove('hidden');
  el.style.opacity = '1';
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.classList.add('hidden'), 500);
  }, 3000);
}

// ── GPS Venue Proximity Resolution ────────────────────────────────────────
// Venues register with lat/lng + radiusMi. On app open we check GPS and
// prefer the nearest venue's ad over the global sponsor.
// Venues stored in 'throw_venues' localStorage key (populated by dashboard push).

function haversineDistMi(lat1, lng1, lat2, lng2) {
  const R = 3958.8; // Earth radius miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function getNearbyVenueSponsor(lat, lng) {
  try {
    const venues = JSON.parse(localStorage.getItem('throw_venues') || '[]');
    let best = null, bestDist = Infinity;
    for (const v of venues) {
      if (v.status !== 'active' || !v.lat || !v.lng) continue;
      const dist = haversineDistMi(lat, lng, v.lat, v.lng);
      if (dist <= (v.radiusMi || 0.25) && dist < bestDist) {
        best = v;
        bestDist = dist;
      }
    }
    if (!best) return null;
    return {
      name:       best.name,
      logoUrl:    best.logoUrl || '',
      tagline:    best.tagline || '',
      url:        best.clickUrl || '',
      placements: ['splash', 'orb', 'strips'],
      paid:       true,
      isVenue:    true,
      venueId:    best.id,
      revenueSharePct: best.revenueSharePct || 15,
    };
  } catch(_) { return null; }
}

async function resolveActiveSponsor() {
  // 1. Try GPS — venue ad takes priority over global sponsor
  try {
    const pos = await new Promise((res, rej) =>
      navigator.geolocation.getCurrentPosition(res, rej, { timeout: 3000, maximumAge: 60000 })
    );
    const venue = getNearbyVenueSponsor(pos.coords.latitude, pos.coords.longitude);
    if (venue) return venue;
  } catch(_) {} // GPS denied or timed out — fall through

  // 2. Fall back to global sponsor pushed via MQTT
  try {
    const sp = JSON.parse(localStorage.getItem('throw_active_sponsor') || 'null');
    if (sp?.name) return sp;
  } catch(_) {}

  return null;
}

// Log a venue throw event (for revenue share accounting)
function logVenueThrow(amount) {
  if (!_activeSponsor?.isVenue || !_activeSponsor?.venueId) return;
  const payload = {
    event:     'venue_throw',
    venueId:   _activeSponsor.venueId,
    venueName: _activeSponsor.name,
    amount,
    addr:      state.account?.address || 'anon',
    ts:        Date.now(),
  };
  try {
    const c = mqtt.connect(MQTT_BROKER, {
      clientId: 'vt_' + Math.random().toString(36).slice(2,8),
      clean: true, connectTimeout: 4000, reconnectPeriod: 0,
    });
    c.on('connect', () => {
      c.publish('throw/venue/throws', JSON.stringify(payload), { qos: 0 }, () => c.end(true));
    });
  } catch(_) {}
}

// Show sponsor splash for returning users — resolves after display
function showSponsorSplash(sponsor) {
  return new Promise(resolve => {
    // Populate
    const nameEl = document.getElementById('spsplash-name');
    const logoEl = document.getElementById('spsplash-logo');
    const tagEl  = document.getElementById('spsplash-tagline');
    const bar    = document.getElementById('spsplash-bar');
    if (nameEl) nameEl.textContent = sponsor.name || 'THROW';
    if (tagEl && sponsor.tagline) tagEl.textContent = sponsor.tagline;
    if (logoEl) {
      if (sponsor.logoUrl) {
        logoEl.innerHTML = `<img src="${sponsor.logoUrl}" alt="${sponsor.name}" />`;
      } else {
        logoEl.textContent = sponsor.name?.slice(0,2) || 'T';
        logoEl.style.fontSize = '1.2rem';
        logoEl.style.fontWeight = '900';
        logoEl.style.color = '#fff';
      }
    }
    showScreen('sponsor-splash');
    // Start progress bar
    requestAnimationFrame(() => { if (bar) bar.classList.add('running'); });
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    // Skip button
    const skipBtn = document.getElementById('btn-spsplash-skip');
    if (skipBtn) skipBtn.onclick = finish;
    // Auto-advance after 8s
    setTimeout(finish, 8000);
  });
}

/* ── MY PROFILE ─────────────────────────────────────────────────────── */

function getSelfProfile() {
  try {
    return JSON.parse(localStorage.getItem('throw_my_profile') || '{}');
  } catch(_) { return {}; }
}

function saveSelfProfile(data) {
  try { localStorage.setItem('throw_my_profile', JSON.stringify(data)); } catch(_) {}
}

function initMyProfile() {
  const modal    = document.getElementById('my-profile-modal');
  const closeBtn = document.getElementById('my-profile-close');
  const saveBtn  = document.getElementById('my-profile-save');
  const nameIn   = document.getElementById('my-profile-name');
  const phoneIn  = document.getElementById('my-profile-phone');
  const photoIn  = document.getElementById('my-profile-photo-input');
  const avatar   = document.getElementById('my-profile-avatar');
  const initials = document.getElementById('my-profile-initials');
  const shareBtn = document.getElementById('my-profile-share');
  const shareStatus = document.getElementById('my-profile-share-status');

  if (!modal) return;

  // Open modal from self-avatar button
  const selfBtn = document.getElementById('self-avatar-btn');
  if (selfBtn) selfBtn.onclick = () => {
    const p = getSelfProfile();
    if (nameIn)  nameIn.value  = p.name  || getHandle() || '';
    if (phoneIn) phoneIn.value = p.phone || '';
    // Show photo if saved
    if (p.photo && avatar) {
      avatar.innerHTML = '<img src="' + p.photo + '" style="width:100%;height:100%;border-radius:50%;object-fit:cover">';
    } else if (initials) {
      initials.textContent = (p.name || getHandle() || '?').slice(0,2).toUpperCase();
    }
    modal.classList.remove('hidden');
  };

  // Close
  if (closeBtn) closeBtn.onclick = () => modal.classList.add('hidden');
  modal.onclick = (e) => { if (e.target === modal) modal.classList.add('hidden'); };

  // Photo upload
  if (photoIn) photoIn.onchange = () => {
    const file = photoIn.files[0];
    if (!file) return;
    resizeImageToDataUrl(file, 128, 0.75, (dataUrl) => {
      if (avatar) avatar.innerHTML = '<img src="' + dataUrl + '" style="width:100%;height:100%;border-radius:50%;object-fit:cover">';
      const p = getSelfProfile();
      p.photo = dataUrl;
      saveSelfProfile(p);
      // Update self-avatar in top bar
      updateSelfAvatar();
    });
  };

  // Save
  if (saveBtn) saveBtn.onclick = () => {
    const p = getSelfProfile();
    const name  = nameIn  ? nameIn.value.trim().slice(0,6).toUpperCase()  : '';
    const phone = phoneIn ? phoneIn.value.trim() : '';
    if (name)  { p.name = name;  saveHandle(name); }
    if (phone) p.phone = phone;
    saveSelfProfile(p);
    updateSelfAvatar();
    if (saveBtn) { saveBtn.textContent = 'Saved!'; setTimeout(() => saveBtn.textContent = 'Save', 1500); }
  };

  // Share My Card — builds a URL with name+addr+phone+thumb encoded
  if (shareBtn) shareBtn.onclick = () => {
    const p    = getSelfProfile();
    const name = p.name || getHandle() || '';
    const addr = state.account?.address || '';
    if (!addr) { alert('Create a wallet first'); return; }
    const params = new URLSearchParams();
    params.set('addName', name);
    params.set('addAddr', addr);
    if (p.phone) params.set('addPhone', p.phone);
    if (p.photo) {
      // Shrink photo to 64px thumb for URL
      resizeImageToDataUrl(
        dataURLtoFile(p.photo, 'thumb.jpg'), 64, 0.6,
        (thumb) => {
          params.set('addThumb', thumb);
          _doShareCard(params, shareStatus);
        }
      );
    } else {
      _doShareCard(params, shareStatus);
    }
  };
}

function dataURLtoFile(dataUrl, filename) {
  const arr  = dataUrl.split(',');
  const mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8 = new Uint8Array(n);
  while(n--) u8[n] = bstr.charCodeAt(n);
  return new File([u8], filename, { type: mime });
}

function _doShareCard(params, statusEl) {
  const url = APP_URL + '/?' + params.toString();
  if (navigator.share) {
    navigator.share({
      title: 'Add me on THROW',
      text:  'Tap to add me as a contact on THROW',
      url,
    }).catch(() => _copyShareURL(url, statusEl));
  } else {
    _copyShareURL(url, statusEl);
  }
}

function _copyShareURL(url, statusEl) {
  navigator.clipboard?.writeText(url).then(() => {
    if (statusEl) { statusEl.textContent = 'Link copied — paste it to your friend!'; statusEl.style.display = 'block'; }
    setTimeout(() => { if (statusEl) statusEl.style.display = 'none'; }, 3000);
  }).catch(() => {
    // Fallback for browsers that block clipboard
    if (statusEl) { statusEl.textContent = url; statusEl.style.display = 'block'; }
  });
}

function updateSelfAvatar() {
  const p       = getSelfProfile();
  const circle  = document.getElementById('self-avatar-circle');
  const initEl  = document.getElementById('self-avatar-initials');
  const name    = p.name || getHandle() || '?';
  if (!circle) return;
  if (p.photo) {
    circle.innerHTML = '<img src="' + p.photo + '" style="width:100%;height:100%;border-radius:50%;object-fit:cover">';
  } else {
    circle.innerHTML = '<span id="self-avatar-initials">' + name.slice(0,2).toUpperCase() + '</span>';
  }
}

/* ── URL params: auto-add contact from share card link ────────────────── */
function handleContactParams() {
  const params   = new URLSearchParams(window.location.search);
  const addName  = params.get('addName');
  const addAddr  = params.get('addAddr');
  const addPhone = params.get('addPhone');
  const addThumb = params.get('addThumb');
  if (!addAddr) return false;
  // Auto-add as contact
  const extra = {};
  if (addPhone) extra.phone = addPhone;
  if (addThumb) extra.photo = addThumb;
  upsertContact(addName || addAddr.slice(0,6), addAddr, extra);
  window.history.replaceState({}, '', window.location.pathname);
  // Show confirmation toast once wallet is ready
  setTimeout(() => showToast((addName || 'Contact') + ' added to your crew!'), 1200);
  return true;
}

/* ── WALLET BACKUP — vCard contact + email ── */
function offerBackup(acc) {
  const handle = getHandle() || 'YOU';
  const pk     = acc.privateKey;
  const addr   = acc.address;

  const modal = document.getElementById('backup-offer-modal');
  if (!modal) return;
  document.getElementById('backup-offer-name').textContent = handle;
  modal.classList.remove('hidden');

  document.getElementById('btn-backup-contact').onclick = () => {
    saveAsContact(handle, addr, pk);
    modal.classList.add('hidden');
  };
  document.getElementById('btn-backup-email').onclick = () => {
    emailBackup(handle, addr, pk);
    modal.classList.add('hidden');
  };
  document.getElementById('btn-backup-skip').onclick = () => {
    modal.classList.add('hidden');
  };
}

function saveAsContact(handle, addr, pk) {
  // Build a vCard — iOS will open Contacts app and offer to save it
  const name  = handle.toUpperCase();
  const vcard = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${name} THROW`,
    `N:THROW;${name};;;`,
    `ORG:THROW`,
    `NOTE:THROW wallet address: ${addr}\nPrivate Key (KEEP SECRET): ${pk}`,
    'END:VCARD'
  ].join('\r\n');

  const blob = new Blob([vcard], { type: 'text/vcard;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${name.toLowerCase()}-throw.vcf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  // Also mark that backup was offered so we don’t nag again
  try { localStorage.setItem('throw_backed_up', '1'); } catch(e) {}
  idbSet('throw_backed_up', '1');
}

function emailBackup(handle, addr, pk) {
  const subject = encodeURIComponent(`[THROW] Your ${handle} wallet backup`);
  const body = encodeURIComponent(
    `THROW Wallet Backup\n` +
    `Name: ${handle}\n` +
    `Address: ${addr}\n` +
    `Private Key (KEEP SECRET — anyone with this owns your wallet): ${pk}\n\n` +
    `To recover: open throw5onit.com, tap "Import Key" on setup screen, paste the key above.`
  );
  window.open(`mailto:?subject=${subject}&body=${body}`, '_self');
  try { localStorage.setItem('throw_backed_up', '1'); } catch(e) {}
  idbSet('throw_backed_up', '1');
}

// Check if backup has been done — checks both localStorage and IDB
async function hasBackedUp() {
  try { if (localStorage.getItem('throw_backed_up')) return true; } catch(e) {}
  try { const v = await idbGet('throw_backed_up'); if (v) return true; } catch(e) {}
  return false;
}

function updateAddrDisplay() {
  // Show handle if set, else short address
  const handle = getHandle();
  const addr   = state.account?.address || '';
  const label  = handle || (addr ? addr.slice(0, 6) + '\u2026' + addr.slice(-4) : 'THROW');
  const el = document.getElementById('wallet-handle-display');
  if (el) el.textContent = label;
}

/* ═══════════════════════════════════════════════════════════════════════
   5. BALANCE REFRESH
   ═════════════════════════════════════════════════════════════════════ */
async function refreshBalances(addr) {
  if (!addr) addr = state.account?.address;
  if (!addr) return;
  if (DEMO_MODE) { renderWalletUI(); return; } // demo balances are local only
  try {
    const { ethers } = await getViem();
    const provider = new ethers.JsonRpcProvider(TEMPO_RPC);
    const balABI   = ['function balanceOf(address) view returns (uint256)'];
    const pathToken = new ethers.Contract(PATHUSD_ADDR, balABI, provider);
    const usdcToken = new ethers.Contract(USDC_ADDR,    balABI, provider);

    // Both pathUSD and USDC.e use 6 decimals (TIP-20 standard)
    const [pathBal, usdcBal] = await Promise.all([
      pathToken.balanceOf(addr),
      usdcToken.balanceOf(addr),
    ]);

    state.pathUSD = Number(pathBal) / 1e6;
    state.usdc    = Number(usdcBal) / 1e6;
    state.total   = state.pathUSD + state.usdc;

    renderWalletUI();
  } catch (e) {
    console.warn('Balance fetch failed:', e.message);
  }
}

function renderPoints() {
  const badge = document.getElementById('tempo-points-badge');
  if (badge) {
    badge.textContent = points.throws > 0
      ? `⚡ ${points.throws} Tempo Point${points.throws !== 1 ? 's' : ''}`
      : '⚡ Earn Tempo Points';
    badge.classList.toggle('has-points', points.throws > 0);
  }
  const stat = document.getElementById('points-stat-throws');
  if (stat) stat.textContent = `${points.throws} throw${points.throws !== 1 ? 's' : ''}`;
}

function openPointsModal() {
  renderPoints();
  document.getElementById('points-modal').classList.remove('hidden');
}
function closePointsModal() {
  document.getElementById('points-modal').classList.add('hidden');
}

function renderWalletUI() {
  const total = state.total;
  document.getElementById('balance-display').textContent = '$' + total.toFixed(2);
  const tokenParts = [];
  if (state.pathUSD > 0) tokenParts.push(`${state.pathUSD.toFixed(2)} pathUSD`);
  if (state.usdc    > 0) tokenParts.push(`${state.usdc.toFixed(2)} USDC.e`);
  document.getElementById('balance-tokens').textContent =
    tokenParts.length ? tokenParts.join(' + ') : '0.00 pathUSD';

  const pct = Math.min((total / CAP_USD) * 100, 100);
  document.getElementById('cap-bar-fill').style.width = pct + '%';
  document.getElementById('cap-label').textContent = `$${total.toFixed(0)} of $${CAP_USD}`;

  // Always keep THROW enabled — balance may be loading
  document.getElementById('btn-throw').style.opacity = '1';
  document.getElementById('btn-throw').disabled = false;

  // Render sponsor strips on wallet screen
  try { renderSponsorStrips(); } catch(_) {}
}

/* ═══════════════════════════════════════════════════════════════════════
   6. SEND TRANSACTION (ERC-20 transfer on Tempo)
   ═════════════════════════════════════════════════════════════════════ */
async function sendStablecoin(toAddr, usdAmount) {
  if (DEMO_MODE) return demoSendStablecoin(toAddr, usdAmount);

  // 1% fee total. If at a venue: 0.5% to treasury + 0.5% accrues to venue.
  // If no venue: 1% to treasury.
  const fee = getThrowFee(usdAmount);       // always 1%
  const netAmount = Math.max(0, usdAmount - fee);

  const isAtVenue = !!(_activeSponsor?.isVenue && _activeSponsor?.venueId);
  const treasuryFee = isAtVenue
    ? Math.round(fee * 0.5 * 1e6) / 1e6     // 0.5% to THROW
    : fee;                                   // 1.0% to THROW
  const venueFee = isAtVenue
    ? Math.round(fee * 0.5 * 1e6) / 1e6     // 0.5% accrued for venue (paid monthly)
    : 0;

  if (TREASURY_ADDR && TREASURY_ADDR !== '0x0000000000000000000000000000000000000001') {
    // Send THROW's cut to treasury (silently — user sees full $X throw)
    try { await _sendToken(USDC_ADDR, 6, TREASURY_ADDR, treasuryFee); } catch (_) {}
  }

  // Accrue venue's cut locally — paid out monthly in batch from dashboard
  if (venueFee > 0) accrueVenueFee(_activeSponsor.venueId, _activeSponsor.name, venueFee, usdAmount);

  // Choose token for net payment: prefer USDC.e, then pathUSD — both 6 decimals
  let tokenAddr, decimals = 6;
  if (state.usdc >= netAmount) {
    tokenAddr = USDC_ADDR;
  } else if (state.pathUSD >= netAmount) {
    tokenAddr = PATHUSD_ADDR;
  } else if ((state.pathUSD + state.usdc) >= netAmount) {
    // split: send USDC.e first, then pathUSD for remainder
    if (state.usdc > 0.001) {
      await _sendToken(USDC_ADDR, 6, toAddr, state.usdc);
      const remainder = netAmount - state.usdc;
      if (remainder > 0.001) await _sendToken(PATHUSD_ADDR, 6, toAddr, remainder);
      return;
    } else {
      tokenAddr = PATHUSD_ADDR;
    }
  } else {
    throw new Error('Insufficient balance');
  }

  await _sendToken(tokenAddr, decimals, toAddr, netAmount);
}

// Accrue venue fee locally — aggregated by venueId, paid out monthly from Swarm dashboard
function accrueVenueFee(venueId, venueName, feeAmount, throwAmount) {
  try {
    const key = 'throw_venue_accrued_' + venueId;
    const existing = JSON.parse(localStorage.getItem(key) || '{"venueId":"","venueName":"","totalAccrued":0,"throwCount":0,"log":[]}');
    existing.venueId   = venueId;
    existing.venueName = venueName;
    existing.totalAccrued = Math.round((existing.totalAccrued + feeAmount) * 1e6) / 1e6;
    existing.throwCount++;
    existing.log.push({ ts: Date.now(), fee: feeAmount, throwAmt: throwAmount });
    // Keep last 500 log entries
    if (existing.log.length > 500) existing.log = existing.log.slice(-500);
    localStorage.setItem(key, JSON.stringify(existing));
  } catch (_) {}

  // Fire MQTT venue_throw event for Swarm dashboard accounting
  try {
    if (room.client) {
      room.client.publish('throw/venue/throws', JSON.stringify({
        venueId, venueName, feeAmount, throwAmount, ts: Date.now()
      }), { qos: 0 });
    }
  } catch (_) {}
}

async function _sendToken(tokenAddr, decimals, toAddr, usdAmount) {
  const { ethers } = await getViem();

  const provider = new ethers.JsonRpcProvider(TEMPO_RPC);
  const signer   = new ethers.Wallet(state.privateKey, provider);
  const token    = new ethers.Contract(tokenAddr, [
    'function transfer(address to, uint256 amount) returns (bool)',
  ], signer);

  const dp     = decimals > 6 ? 6 : decimals;
  const amount = ethers.parseUnits(usdAmount.toFixed(dp), dp);

  const tx      = await token.transfer(toAddr, amount);
  const receipt = await tx.wait();
  const hash    = receipt.hash;

  // Log history
  state.txHistory.unshift({ type: 'sent', amount: usdAmount, to: toAddr, hash, ts: Date.now() });
  await refreshBalances();
  return hash;
}

/* ═══════════════════════════════════════════════════════════════════════
   7. GESTURE ENGINE — enhanced accelerometer throw/catch detection
   ═════════════════════════════════════════════════════════════════════ */
const gesture = {
  listening:    false,
  startTime:    0,
  samples:      [],   // raw magnitude samples
  smoothed:     [],   // EMA-smoothed
  maxAccel:     0,
  onThrow:      null,
  onCatch:      null,
  emaAlpha:     0.35, // EMA smoothing factor (higher = more responsive)
  throwThresh:  8,    // m/s² — spike needed to register throw (lowered: most flicks = 8-12)
  catchThresh:  5,    // m/s² — gentler motion detects incoming catch
  _ema:         0,
};

async function requestMotionPermission() {
  if (typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function') {
    const perm = await DeviceMotionEvent.requestPermission();
    return perm === 'granted';
  }
  return true; // Android / non-iOS — always granted
}

/* Exponential Moving Average — smooths out noise, amplifies real spikes */
function emaUpdate(newVal) {
  gesture._ema = gesture._ema === 0
    ? newVal
    : gesture.emaAlpha * newVal + (1 - gesture.emaAlpha) * gesture._ema;
  return gesture._ema;
}

/* Jerk = rate of change of acceleration — catches the flick impulse */
function computeJerk(samples) {
  if (samples.length < 2) return 0;
  return Math.abs(samples[samples.length-1] - samples[samples.length-2]);
}

function startGestureCapture(onThrow) {
  gesture.listening = true;
  gesture.samples   = [];
  gesture.smoothed  = [];
  gesture.maxAccel  = 0;
  gesture.onThrow   = onThrow;
  gesture.startTime = Date.now();
  gesture._ema      = 0;
  window.addEventListener('devicemotion', onMotionThrow);
}

function stopGestureCapture() {
  gesture.listening = false;
  window.removeEventListener('devicemotion', onMotionThrow);
}

function startGestureCatch(onCatch) {
  gesture.listening = true;
  gesture.samples   = [];
  gesture.smoothed  = [];
  gesture.maxAccel  = 0;
  gesture.onCatch   = onCatch;
  gesture.startTime = Date.now();
  gesture._ema      = 0;
  window.addEventListener('devicemotion', onMotionCatch);
}

function stopGestureCatch() {
  gesture.listening = false;
  window.removeEventListener('devicemotion', onMotionCatch);
}

function onMotionThrow(e) {
  if (!gesture.listening) return;
  const a = e.acceleration || e.accelerationIncludingGravity;
  if (!a) return;

  const raw = Math.sqrt((a.x||0)**2 + (a.y||0)**2 + (a.z||0)**2);
  const smoothed = emaUpdate(raw);
  gesture.samples.push(raw);
  gesture.smoothed.push(smoothed);
  if (raw > gesture.maxAccel) gesture.maxAccel = raw;

  const jerk = computeJerk(gesture.samples);

  // Enhanced throw detection: spike AND jerk (sudden impulse)
  if (raw > gesture.throwThresh && jerk > 3 && gesture.samples.length > 2) {
    stopGestureCapture();
    gesture.onThrow && gesture.onThrow();
    return;
  }

  // Timeout safety
  if (Date.now() - gesture.startTime > 10000) stopGestureCapture();
}

function onMotionCatch(e) {
  if (!gesture.listening) return;
  const a = e.acceleration || e.accelerationIncludingGravity;
  if (!a) return;

  const raw = Math.sqrt((a.x||0)**2 + (a.y||0)**2 + (a.z||0)**2);
  const smoothed = emaUpdate(raw);
  gesture.samples.push(raw);

  // Catch gesture: gentler threshold — phone tilting toward/pulling back
  // Look for sustained motion above catchThresh for 150ms+
  const sustained = gesture.samples.slice(-5);
  if (sustained.length === 5 && sustained.every(s => s > gesture.catchThresh)) {
    stopGestureCatch();
    gesture.onCatch && gesture.onCatch();
    return;
  }

  if (Date.now() - gesture.startTime > 10000) stopGestureCatch();
}

/* ═══════════════════════════════════════════════════════════════════════
   8. NFC ENGINE
   ═════════════════════════════════════════════════════════════════════ */
let nfcReader = null;

async function startNFCWrite(data) {
  if (!('NDEFReader' in window)) return false;
  try {
    const ndef = new NDEFReader();
    await ndef.write({ records: [{ recordType: 'text', data: JSON.stringify(data) }] });
    return true;
  } catch (e) {
    console.warn('NFC write failed:', e);
    return false;
  }
}

async function startNFCRead(onData) {
  if (!('NDEFReader' in window)) return false;
  try {
    nfcReader = new NDEFReader();
    await nfcReader.scan();
    nfcReader.onreading = (event) => {
      for (const record of event.message.records) {
        if (record.recordType === 'text') {
          const dec = new TextDecoder();
          try {
            const payload = JSON.parse(dec.decode(record.data));
            onData(payload);
          } catch (_) {}
        }
      }
    };
    return true;
  } catch (e) {
    console.warn('NFC scan failed:', e);
    return false;
  }
}

function stopNFC() {
  nfcReader = null;
}

/* ═══════════════════════════════════════════════════════════════════════
   9. SONIC ENGINE (ultrasonic data transfer)
   ═════════════════════════════════════════════════════════════════════ */
const SONIC_BASE_FREQ = 18500; // Hz — above most adult hearing
const SONIC_BIT_DURATION = 50; // ms per symbol
let sonicAudioCtx = null;
let sonicAnalyser = null;
let sonicStream   = null;

async function getSonicAudioCtx() {
  if (!sonicAudioCtx) sonicAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  // iOS suspends AudioContext until inside user gesture
  if (sonicAudioCtx.state === 'suspended') {
    try { await sonicAudioCtx.resume(); } catch(_) {}
  }
  return sonicAudioCtx;
}

// Encode amount as sequence of tones (base + (digit * 200Hz))
async function sonicSend(amount) {
  const ctx = await getSonicAudioCtx();
  const digits = String(Math.round(amount * 100)).padStart(5, '0');
  let t = ctx.currentTime + 0.05;

  // Preamble
  const pre = ctx.createOscillator();
  pre.frequency.value = SONIC_BASE_FREQ;
  pre.connect(ctx.destination);
  pre.start(t);
  pre.stop(t + 0.1);
  t += 0.12;

  for (const d of digits) {
    const osc = ctx.createOscillator();
    osc.frequency.value = SONIC_BASE_FREQ + parseInt(d) * 200;
    const g = ctx.createGain();
    g.gain.value = 0.4;
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + SONIC_BIT_DURATION / 1000);
    t += (SONIC_BIT_DURATION + 10) / 1000;
  }

  // Also embed sender address (first 4 hex chars as 2 bytes)
  // This is a simplified protocol — production would use FSK with error correction
}

async function sonicListen(onAmount) {
  const ctx = await getSonicAudioCtx();
  try {
    sonicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const source = ctx.createMediaStreamSource(sonicStream);
    sonicAnalyser = ctx.createAnalyser();
    sonicAnalyser.fftSize = 2048;
    sonicAnalyser.smoothingTimeConstant = 0.4;
    source.connect(sonicAnalyser);

    const binCount = sonicAnalyser.frequencyBinCount;
    const freqData = new Float32Array(binCount);
    const sampleRate = ctx.sampleRate;
    const nyq = sampleRate / 2;
    const binHz = nyq / binCount;

    let detected = [];
    let lastDetect = 0;
    let preambleTime = 0;

    function tick() {
      if (!sonicAnalyser) return;
      sonicAnalyser.getFloatFrequencyData(freqData);

      // Find peak in 18–20kHz range
      const lowBin  = Math.floor(18000 / binHz);
      const highBin = Math.min(Math.floor(20500 / binHz), binCount - 1);
      let peakDb = -200, peakBin = lowBin;
      for (let i = lowBin; i <= highBin; i++) {
        if (freqData[i] > peakDb) { peakDb = freqData[i]; peakBin = i; }
      }

      const peakHz = peakBin * binHz;
      const now = Date.now();

      if (peakDb > -50) { // signal detected
        if (!preambleTime && Math.abs(peakHz - SONIC_BASE_FREQ) < 300) {
          preambleTime = now;
          detected = [];
        } else if (preambleTime && (now - preambleTime > 100)) {
          // Decode digit
          const digit = Math.round((peakHz - SONIC_BASE_FREQ) / 200);
          if (digit >= 0 && digit <= 9 && now - lastDetect > 40) {
            detected.push(digit);
            lastDetect = now;
          }
          if (detected.length === 5) {
            const cents = parseInt(detected.join(''));
            const amount = cents / 100;
            stopSonicListen();
            onAmount(amount);
            return;
          }
        }
      }

      // Reset if silent too long
      if (preambleTime && now - lastDetect > 1000) {
        preambleTime = 0;
        detected = [];
      }

      requestAnimationFrame(tick);
    }
    tick();
    return true;
  } catch (e) {
    console.warn('Mic access failed:', e);
    return false;
  }
}

function stopSonicListen() {
  if (sonicStream) { sonicStream.getTracks().forEach(t => t.stop()); sonicStream = null; }
  sonicAnalyser = null;
}

/* ═══════════════════════════════════════════════════════════════════════
   10. BROADCAST CHANNEL (same-device / demo peer messaging)
   ═════════════════════════════════════════════════════════════════════ */
const bc = new BroadcastChannel('throw_channel');

function bcSend(type, payload) {
  bc.postMessage({ type, payload, ts: Date.now() });
}

// Listen for proximity throws from same device (demo / testing)
bc.onmessage = (e) => {
  const { type, payload } = e.data || {};
  if (type === 'proximity_throw' && payload) {
    const myAddr = state.account?.address;
    if (!myAddr) return;
    if (payload.to && payload.to.toLowerCase() === myAddr.toLowerCase()) {
      onCatchHit(payload.amount, payload.fromName || payload.from, payload.throwId, 'bc');
    }
  }
};

/* ═══════════════════════════════════════════════════════════════════════
   10b. ROOM ENGINE WIRING
   ═════════════════════════════════════════════════════════════════════ */

async function enterRoom(code, betCallbacks) {
  const addr = state.account.address;
  const name = addr.slice(2, 6).toUpperCase(); // e.g. "A3F2"
  try {
    await joinRoom(code, addr, name,
      // onPeers
      (peers) => {
        state.roomPeers = peers;
        updateRoomUI();
        updateTargetUI();
      },
      // onThrowReceived
      (data) => {
        showTxFlash('💸', '$' + data.amount, 'Incoming throw from ' + data.from.slice(0,6));
        refreshBalances();
      },
      // bet callbacks — { onBetOpen, onBetJoin, onBetSettled }
      betCallbacks || {}
    );
    state.inRoom   = true;
    state.roomCode = code;
    updateRoomBar();
    updateRoomUI();
  } catch (e) {
    // Host opening a pot — suppress alert, MQTT is best-effort
    // Players trying to join will see the error
    if (!state.bet.isHost) {
      console.warn('Room join failed:', e.message);
    }
  }
}
function updateRoomBar() {
  // room-bar removed — only used by bet flow internally
}

function updateRoomUI() {
  // room-peers UI removed — peers managed by bet flow
}

// Called on a tick while throw screen is open — updates who you're aimed at
function updateTargetUI() {
  if (!state.inRoom || !state.roomPeers.length) return;

  const target = findTarget(room.myHeading);
  state.currentTarget = target;

  const display = document.getElementById('target-display');
  const noRoom  = document.getElementById('no-room-hint');
  const rainBtn = document.getElementById('btn-make-it-rain');

  if (!display) return;

  display.classList.remove('hidden');
  noRoom && noRoom.classList.add('hidden');

  if (target) {
    document.getElementById('target-avatar').textContent = target.name.slice(0,2);
    document.getElementById('target-name').textContent   = target.name;
    document.getElementById('target-hint').textContent   = 'Aimed — flick to throw!';
    display.classList.add('locked');
  } else {
    document.getElementById('target-avatar').textContent = '?';
    document.getElementById('target-name').textContent   = 'Point at your friend';
    document.getElementById('target-hint').textContent   = state.roomPeers.length + ' in room';
    display.classList.remove('locked');
  }

  // Show make-it-rain if 2+ peers
  if (state.roomPeers.length >= 2) {
    rainBtn && rainBtn.classList.remove('hidden');
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   11. QR CODE
   ═════════════════════════════════════════════════════════════════════ */
function renderQR(addr) {
  const canvas = document.getElementById('qr-canvas');
  document.getElementById('qr-address').textContent = addr;
  if (typeof QRCode !== 'undefined') {
    QRCode.toCanvas(canvas, `tempo:${addr}`, { width: 220, margin: 1, color: { light: '#fff', dark: '#000' } });
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   12. THROW SCREEN — pick target, hold+flick fires all 3 channels
   ═════════════════════════════════════════════════════════════════════ */

/* ── Proximity throw: fires Sonic + Gesture + MQTT simultaneously ── */
async function executeProximityThrow(target) {
  if (!target || !target.addr) {
    showToast('👆 Select a friend first');
    return;
  }

  // Generate unique throwId — dedup guard so money only moves once
  const throwId = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
  state.pendingThrowId = throwId;

  const amount = state.throwAmount;
  const fromAddr = state.account.address;
  const fromName = getHandle() || fromAddr.slice(0,6);

  // Build the throw payload published to all channels
  const payload = {
    event: 'proximity_throw',
    throwId,
    from: fromAddr,
    fromName,
    to: target.addr,
    amount,
    ts: Date.now(),
  };

  // Visual: show charging flash
  showTxFlash('🤌', '$' + amount, 'Throwing to ' + target.name + '…');
  playThrowAnimation();

  // Fire all 3 channels simultaneously — don't await, let them race
  // Channel 1: MQTT direct to receiver's wallet topic
  const mqttPromise = new Promise(resolve => {
    try {
      const topic = 'throw5/wallet/' + target.addr.toLowerCase() + '/credit';
      const msg = JSON.stringify({ ...payload, channel: 'mqtt' });
      const clientId = 'throw_px_' + Math.random().toString(36).slice(2,8);
      const c = mqtt.connect(MQTT_BROKER, { clientId, clean: true, connectTimeout: 5000, reconnectPeriod: 0 });
      c.on('connect', () => {
        c.publish(topic, msg, { qos: 1 }, () => { try { c.end(true); } catch(_) {} });
        resolve('mqtt');
      });
      c.on('error', () => resolve('mqtt_err'));
      setTimeout(() => resolve('mqtt_timeout'), 4000);
    } catch(e) { resolve('mqtt_err'); }
  });

  // Channel 2: Sonic — encode throwId + amount as ultrasonic burst
  const sonicPromise = (async () => {
    try {
      await sonicSendThrow(amount, throwId);
      return 'sonic';
    } catch(e) { return 'sonic_err'; }
  })();

  // Channel 3: BroadcastChannel (same-device / demo)
  bcSend('proximity_throw', payload);

  // Execute all channels in parallel
  await Promise.all([mqttPromise, sonicPromise]);

  // Now execute the actual blockchain transaction
  try {
    const hash = await sendStablecoin(target.addr, amount);
    notifyReceiverDirect(target.addr, amount);
    if (state.inRoom) publishThrow(fromAddr, target.addr, amount);
    touchContact(target.addr);
    points.add(amount);
    showTxFlash('\u2705', '$' + amount, 'Thrown to ' + target.name + '!');
    // Log throw-coincidence if a paid sponsor is active
    if (_activeSponsor?.paid) logSponsorEvent('throw_coincidence', _activeSponsor);
    // Log venue throw for revenue share accounting
    logVenueThrow(amount);
    showThrowSponsorCredit(_activeSponsor?.name || null);
    await refreshBalances();
    setTimeout(() => { hideTxFlash(); showScreen('wallet'); }, 1800);
  } catch(e) {
    hideTxFlash();
    showToast('✕ Throw failed: ' + (e.message || String(e)));
    showScreen('wallet');
  }
}

function openThrowScreen(preselect) {
  if (state.total < 0.01) {
    showScreen('qr');
    const addr = state.account?.address || '';
    renderQR(addr);
    const pk = _storedPK || localStorage.getItem('throw_pk') || 'Not found';
    document.getElementById('backup-key-display').textContent = pk;
    return;
  }
  state.throwTarget = preselect || null;
  renderThrowContacts(preselect);
  setupThrowScreen();
  renderOrbSponsor();
  renderSponsorStrips();
  showScreen('throw');
}

function renderThrowContacts(preselect) {
  const strip = document.getElementById('throw-contacts-strip');
  if (!strip) return;
  const contacts = getContacts();
  if (!contacts.length) {
    strip.innerHTML = '<div class="throw-no-contacts">No friends yet — add one with ADD FRIEND</div>';
    return;
  }
  strip.innerHTML = contacts.map(c => {
    const initials = c.name.slice(0,2).toUpperCase();
    const color = addrToColor(c.addr);
    const isPreselected = preselect && c.addr.toLowerCase() === preselect.addr.toLowerCase();
    return `<div class="throw-contact-chip${isPreselected ? ' selected' : ''}" data-addr="${c.addr}" data-name="${c.name}">
      <div class="throw-chip-avatar" style="background:${color}">${initials}</div>
      <div class="throw-chip-name">${c.name.toUpperCase().slice(0,6)}</div>
    </div>`;
  }).join('');
  strip.querySelectorAll('.throw-contact-chip').forEach(chip => {
    chip.onclick = () => selectThrowTarget(chip.dataset.name, chip.dataset.addr, chip);
  });
  // If preselected, fire selectThrowTarget to update orb
  if (preselect) {
    const sel = strip.querySelector('.throw-contact-chip.selected');
    if (sel) selectThrowTarget(sel.dataset.name, sel.dataset.addr, sel);
  }
}

function selectThrowTarget(name, addr, chipEl) {
  // Deselect all
  document.querySelectorAll('.throw-contact-chip').forEach(c => c.classList.remove('selected'));
  chipEl && chipEl.classList.add('selected');
  state.throwTarget = { name, addr };

  // Update orb label and hint
  const orbLabel = document.getElementById('throw-orb-label');
  const orbHint  = document.getElementById('throw-orb-hint');
  const orbSub   = document.getElementById('throw-orb-sub');
  if (orbLabel) orbLabel.textContent = '$' + state.throwAmount;
  if (orbHint)  orbHint.textContent  = 'Hold & draw toward ' + name.toUpperCase().slice(0,6);
  if (orbSub)   orbSub.textContent   = 'Hold · flick · release — $' + state.throwAmount + ' flies';
  // Show tap fallback button
  const tapBtn = document.getElementById('btn-tap-throw');
  if (tapBtn) tapBtn.classList.remove('hidden');
}

async function throwToContact(name, addr) {
  await executeProximityThrow({ name, addr });
}

function setupThrowScreen() {
  // Amount buttons — scroll strip
  const qbtns = document.querySelectorAll('#throw-amounts-scroll .qbtn');
  qbtns.forEach(b => {
    const a = parseFloat(b.dataset.amount);
    b.style.opacity = '';
    b.style.pointerEvents = '';
    const canAfford = state.total === 0 || a <= state.total;
    if (!canAfford) { b.style.opacity = '0.35'; b.style.pointerEvents = 'none'; }
    b.classList.toggle('active', a === state.throwAmount);
    b.onclick = () => {
      const a = parseFloat(b.dataset.amount);
      if (a > state.total && state.total > 0) return;
      state.throwAmount = a;
      // Update orb label
      const orbLabel = document.getElementById('throw-orb-label');
      if (orbLabel) orbLabel.textContent = '$' + a;
      qbtns.forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const fee = getBetFee(a);
      const net = (a - fee).toFixed(2);
      document.getElementById('throw-fee-line').textContent = `$${fee.toFixed(2)} fee — recipient gets $${net}`;
    };
  });

  // Wire throw orb — hold + flick fires proximity throw
  setupThrowOrb();
}

function setupThrowOrb() {
  const orb     = document.getElementById('throw-orb');
  const orbWrap = document.getElementById('throw-orb-wrap');
  const orbHint = document.getElementById('throw-orb-hint');
  const orbSub  = document.getElementById('throw-orb-sub');
  if (!orb) return;

  orb.classList.remove('charging', 'fired');

  const startThrow = async () => {
    if (!state.throwTarget) {
      // Pulse the contacts strip to hint user to pick someone
      const strip = document.getElementById('throw-contacts-strip');
      if (strip) {
        strip.style.animation = 'none';
        void strip.offsetWidth;
        strip.style.animation = 'orbPulse 0.4s ease 2';
      }
      showToast('👆 Pick a friend first');
      return;
    }

    // Request motion permission on first use (iOS)
    const hasPerm = await requestMotionPermission();
    if (!hasPerm) {
      showToast('⚠ Allow motion in Settings to throw');
      return;
    }

    orb.classList.add('charging');
    if (orbHint) orbHint.textContent = 'FLICK!';

    // Start gesture capture — fires on flick
    startGestureCapture(async () => {
      orb.classList.remove('charging');
      orb.classList.add('fired');
      if (orbHint) orbHint.textContent = 'Thrown! ✓';
      await executeProximityThrow(state.throwTarget);
    });
  };

  const cancelThrow = () => {
    if (orb.classList.contains('fired')) return;
    stopGestureCapture();
    orb.classList.remove('charging', 'fired');
    if (orbHint) orbHint.textContent = state.throwTarget
      ? 'Hold & draw toward ' + state.throwTarget.name.slice(0,6).toUpperCase()
      : 'Hold & draw';
  };

  orb.ontouchstart = orb.onmousedown = startThrow;
  orb.ontouchend   = orb.onmouseup   = cancelThrow;

  // Tap-to-throw fallback — same flow, no gesture required
  const tapBtn = document.getElementById('btn-tap-throw');
  if (tapBtn) {
    tapBtn.onclick = async () => {
      if (!state.throwTarget) { showToast('\uD83D\uDC46 Pick a friend first'); return; }
      orb.classList.add('fired');
      if (orbHint) orbHint.textContent = 'Thrown! \u2713';
      await executeProximityThrow(state.throwTarget);
    };
  }
}

/* ── Sonic send: encode throwId suffix + amount ── */
async function sonicSendThrow(amount, throwId) {
  const ctx = await getSonicAudioCtx();
  const digits = String(Math.round(amount * 100)).padStart(5, '0');
  // Also encode last 2 hex chars of throwId as extra signal marker
  const marker = parseInt(throwId.slice(-2), 36) % 10;

  let t = ctx.currentTime + 0.02;

  // Preamble burst
  const pre = ctx.createOscillator();
  const preGain = ctx.createGain();
  preGain.gain.value = 0.6;
  pre.frequency.value = SONIC_BASE_FREQ;
  pre.connect(preGain).connect(ctx.destination);
  pre.start(t);
  pre.stop(t + 0.08);
  t += 0.10;

  // Amount digits
  for (const d of digits) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0.45;
    osc.frequency.value = SONIC_BASE_FREQ + parseInt(d) * 200;
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + SONIC_BIT_DURATION / 1000);
    t += (SONIC_BIT_DURATION + 8) / 1000;
  }

  // Marker tone (helps receiver confirm it's a real throw, not noise)
  const mOsc = ctx.createOscillator();
  const mGain = ctx.createGain();
  mGain.gain.value = 0.3;
  mOsc.frequency.value = SONIC_BASE_FREQ + 2200 + marker * 100;
  mOsc.connect(mGain).connect(ctx.destination);
  mOsc.start(t);
  mOsc.stop(t + 0.06);
}

/* ═══════════════════════════════════════════════════════════════════════
   13. CATCH SCREEN — 10s window, all 3 channels simultaneously, fires once
   ═════════════════════════════════════════════════════════════════════ */

// Global catch state — tracks whether a catch is already in flight
const catchState = {
  active:    false,
  fired:     false,   // dedup: only fire once per catch window
  seenIds:   new Set(), // throwIds already processed
  timer:     null,    // 10s window timeout
  pollTimer: null,    // balance poll interval
};



/* ── Start 10-second catch window ── */
async function startCatchWindow() {
  if (catchState.active) return; // already listening
  catchState.active  = true;
  catchState.fired   = false;

  const orb    = document.getElementById('catch-orb');
  const status = document.getElementById('catch-status');
  orb.classList.remove('caught');
  orb.classList.add('live');
  status.textContent = 'Catching… hold still';

  // Countdown display
  let secondsLeft = 10;
  const countdown = setInterval(() => {
    secondsLeft--;
    if (!catchState.active) { clearInterval(countdown); return; }
    if (secondsLeft > 0) {
      status.textContent = 'Catching… ' + secondsLeft + 's';
    } else {
      clearInterval(countdown);
      if (!catchState.fired) stopCatchWindow('Missed — try again');
    }
  }, 1000);

  // ── Channel 1: MQTT — subscribe to my wallet topic ──
  const myAddr = state.account.address;
  const mqttCatchClient = (() => {
    try {
      const topic = 'throw5/wallet/' + myAddr.toLowerCase() + '/credit';
      const clientId = 'catch_' + Math.random().toString(36).slice(2,8);
      const c = mqtt.connect(MQTT_BROKER, { clientId, clean: true, connectTimeout: 5000, reconnectPeriod: 0 });
      c.on('connect', () => c.subscribe(topic, { qos: 1 }));
      c.on('message', (_t, msg) => {
        try {
          const data = JSON.parse(msg.toString());
          if ((data.event === 'proximity_throw' || data.event === 'throw_credit')
              && data.to && data.to.toLowerCase() === myAddr.toLowerCase()) {
            onCatchHit(data.amount, data.fromName || data.from, data.throwId, 'mqtt');
          }
        } catch(_) {}
      });
      return c;
    } catch(e) { return null; }
  })();

  // ── Channel 2: Sonic mic listening ──
  const sonicStarted = await sonicListen(amt => {
    catchState.sonicReceived = true;
    catchState.sonicAmount   = amt;
    onCatchHit(amt, 'nearby', null, 'sonic');
  });

  // ── Channel 3: Gesture — hold catch, detect incoming motion ──
  const hasPerm = await requestMotionPermission().catch(() => false);
  if (hasPerm) {
    startGestureCatch(() => {
      // Gesture catch alone doesn't move money — it confirms sonic/MQTT signal
      // But if both sonic AND gesture fire within 2s, high confidence → trigger
      if (catchState.sonicReceived && !catchState.fired) {
        onCatchHit(catchState.sonicAmount, 'nearby', null, 'gesture+sonic');
      }
    });
  }

  // ── Channel 4: On-chain balance poll (ultimate fallback) ──
  const startBal = state.total;
  catchState.pollTimer = setInterval(async () => {
    if (!catchState.active || catchState.fired) return;
    await refreshBalances();
    if (state.total > startBal + 0.005) {
      const received = +(state.total - startBal).toFixed(2);
      onCatchHit(received, 'on-chain', null, 'chain');
    }
  }, 3000);

  // Store cleanup refs
  catchState._mqttClient  = mqttCatchClient;
  catchState._countdown   = countdown;
  catchState.sonicReceived = false;
  catchState.sonicAmount   = 0;

  // ── BroadcastChannel (same-device demo) ──
  // bc listener is always running (set up in DOMContentLoaded)
}

function stopCatchWindow(msg) {
  if (!catchState.active) return;
  catchState.active = false;
  clearInterval(catchState.pollTimer);
  clearInterval(catchState._countdown);
  stopSonicListen();
  stopGestureCatch();
  try { catchState._mqttClient?.end(true); } catch(_) {}
  catchState._mqttClient = null;

  const status = document.getElementById('catch-status');
  const orb    = document.getElementById('catch-orb');
  if (status) status.textContent = msg || 'Done';
  if (orb)    orb.classList.remove('live');
  if (currentScreen !== 'catch') return;
  setTimeout(() => {
    if (currentScreen === 'catch' && !catchState.fired) showScreen('wallet');
  }, 1500);
}

/* ── Dedup guard: only fires once per window ── */
function onCatchHit(amount, fromName, throwId, channel) {
  if (catchState.fired) return; // already caught something
  if (throwId && catchState.seenIds.has(throwId)) return; // duplicate
  catchState.fired = true;
  if (throwId) catchState.seenIds.add(throwId);

  stopCatchWindow();

  const orb    = document.getElementById('catch-orb');
  const status = document.getElementById('catch-status');
  if (orb)    { orb.classList.remove('live'); orb.classList.add('caught'); }
  if (status)  status.textContent = '$' + (+amount).toFixed(2) + ' caught! 💸';

  // Credit demo balance immediately — don't rely on chain refresh
  if (DEMO_MODE && amount > 0) {
    state.total   += +amount;
    state.pathUSD  = state.total;
    try { localStorage.setItem('throw_demo_balance', state.total.toFixed(6)); } catch(_) {}
    renderWalletUI();
  }

  moneyRain();
  showTxFlash('💸', '$' + (+amount).toFixed(2), (fromName || 'Someone') + ' threw you money!');
  state.txHistory.unshift({ type: 'received', amount: +amount, from: fromName || '?', ts: Date.now() });

  setTimeout(async () => {
    hideTxFlash();
    if (!DEMO_MODE) await refreshBalances();
    showScreen('wallet');
  }, 2500);
}

function onMoneyReceived(amount, from) {
  onCatchHit(amount, from, null, 'legacy');
}

/* ═══════════════════════════════════════════════════════════════════════
   14. BET SETUP (HOST)
   ═════════════════════════════════════════════════════════════════════ */
// ── Pending Bet — glows THROW button amber when an open bet is nearby ──────────

function setPendingBetButton(betData) {
  if (!betData || state.bet.isHost) return;
  // If this is a DIFFERENT bet than the one we joined, reset the joined guard
  const incomingEscrow = (betData.escrow || betData.escrowAddr || '').toLowerCase();
  const joinedEscrow   = (state.bet.joinedEscrow || '').toLowerCase();
  if (state.bet.joined && incomingEscrow && incomingEscrow !== joinedEscrow) {
    state.bet.joined = false;
    state.bet.joinedEscrow = null;
  }
  if (state.bet.joined) return;
  state.pendingBet = betData;
  const btn   = document.getElementById('btn-throw');
  const label = btn?.querySelector('span');
  if (!btn) return;
  btn.classList.add('bet-pending');
  if (label) label.textContent = 'BET $' + betData.amountPer;
  btn.onclick = () => joinBetInstantly();
}

async function joinBetInstantly() {
  const betData = state.pendingBet;
  if (!betData) return;
  // Hard guard — one throw per THIS bet (keyed by escrow address)
  if (state.bet.joined) return;
  state.bet.joined = true;
  state.bet.joinedEscrow = (betData.escrow || betData.escrowAddr || '').toLowerCase();

  // Stop scanner so retained message can't re-trigger the button
  if (_betScanTimer) { clearTimeout(_betScanTimer); _betScanTimer = null; }

  // Lock button immediately — prevent double tap
  const btn   = document.getElementById('btn-throw');
  const label = btn?.querySelector('span');
  if (btn) btn.onclick = null;
  if (label) label.textContent = 'THROWING…';

  // Load bet into state
  Object.assign(state.bet, {
    active:     true,
    isHost:     false,
    description: betData.description,
    amountPer:  betData.amountPer,
    structure:  betData.structure,
    escrowAddr: betData.escrow || betData.escrowAddr,
    hostAddr:   betData.hostAddr,
    roomCode:   betData.roomCode,
    side:       'yes',
  });

  try {
    await sendStablecoin(state.bet.escrowAddr, state.bet.amountPer);

    const myAddr = state.account.address;
    const myName = (() => {
      try { return localStorage.getItem('throw_my_name') || myAddr.slice(2,8).toUpperCase(); }
      catch(_) { return myAddr.slice(2,8).toUpperCase(); }
    })();
    const netAmt = state.bet.amountPer - 0.10;

    // Notify host via MQTT + relay fallback
    publishBetJoin(state.bet.hostAddr, myAddr, myName, netAmt, 'yes', state.bet.roomCode);
    relayThrow({
      event:    'bet_join',
      topic:    'throw5/room/' + state.bet.roomCode + '/bet',
      hostAddr: state.bet.hostAddr,
      addr:     myAddr,
      name:     myName,
      amount:   netAmt,
      side:     'yes',
      ts:       Date.now(),
    });
    bcSend('player_threw', { addr: myAddr, name: myName, amount: netAmt, side: 'yes' });

    // Visual feedback — button locked green permanently (you're in)
    state.pendingBet = null;
    if (btn) {
      btn.classList.remove('bet-pending');
      btn.classList.add('bet-pending');
      btn.style.background = '#22c55e';
      btn.style.boxShadow = '0 0 30px rgba(34,197,94,0.6)';
      btn.onclick = null;
      if (label) label.textContent = 'IN THE POT';
    }
    moneyRain(4);

  } catch(e) {
    // Reset on failure so they can retry
    state.bet.joined = false;
    if (label) label.textContent = 'FAILED — TAP TO RETRY';
    if (btn) btn.onclick = () => joinBetInstantly();
    // Restart scanner
    if (!_betScanTimer) _betScanTimer = setTimeout(startBetScanner, 2000);
  }
}

function clearPendingBetButton() {
  state.pendingBet = null;
  const btn   = document.getElementById('btn-throw');
  const label = btn?.querySelector('span');
  if (!btn) return;
  btn.classList.remove('bet-pending');
  if (label) label.textContent = 'THROW';
  btn.onclick = openThrowScreen;
}

let _betScanTimer = null;
function startBetScanner() {
  if (state.bet?.isHost) return;
  if (_betScanTimer) { clearTimeout(_betScanTimer); _betScanTimer = null; }
  scanForBets((betData) => {
    if (betData && betData.escrow && betData.description) {
      if (betData.hostAddr?.toLowerCase() === state.account?.address?.toLowerCase()) return;
      setPendingBetButton(betData);
    } else {
      if (!state.bet?.isHost) clearPendingBetButton();
    }
    if (!state.bet?.isHost) _betScanTimer = setTimeout(startBetScanner, 8000);
  }, 10000);
}

// Re-scan instantly when app comes back to foreground
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.account && !state.bet?.isHost) {
    if (_betScanTimer) { clearTimeout(_betScanTimer); _betScanTimer = null; }
    startBetScanner();
  }
});

function openBetSetup() {
  showScreen('bet-setup');
  state.bet.amountPer = 5;
  state.bet.structure = 'winner-all';

  // Amount buttons
  document.querySelectorAll('[data-betamt]').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.betamt) === state.bet.amountPer);
    b.onclick = () => {
      state.bet.amountPer = parseInt(b.dataset.betamt);
      document.querySelectorAll('[data-betamt]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    };
  });

  // Structure cards
  document.querySelectorAll('[data-struct]').forEach(c => {
    c.classList.toggle('active', c.dataset.struct === state.bet.structure);
    c.onclick = () => {
      state.bet.structure = c.dataset.struct;
      document.querySelectorAll('[data-struct]').forEach(x => x.classList.remove('active'));
      c.classList.add('active');
    };
  });
}

async function startPot() {
  const desc = document.getElementById('bet-description').value.trim();
  if (!desc) { document.getElementById('bet-description').focus(); return; }

  const { ethers } = await getViem();
  const escrowWallet = ethers.Wallet.createRandom();
  const escrowPK     = escrowWallet.privateKey;
  const escrowAcct   = { address: escrowWallet.address };
  const betRoomCode  = escrowWallet.address.slice(2, 8).toUpperCase();

  Object.assign(state.bet, {
    active:      true,
    isHost:      true,
    description: desc,
    escrowKey:   escrowPK,
    escrowAddr:  escrowAcct.address,
    hostAddr:    state.account.address,
    roomCode:    betRoomCode,
    players:     [],
    total:       0,
    yesPot:      0,
    noPot:       0,
  });

  // Persist bet state so settlement survives page reload
  try {
    localStorage.setItem('throw_active_bet', JSON.stringify({
      active:      true,
      isHost:      true,
      description: desc,
      escrowKey:   escrowPK,
      escrowAddr:  escrowAcct.address,
      hostAddr:    state.account.address,
      roomCode:    betRoomCode,
      amountPer:   state.bet.amountPer,
      structure:   state.bet.structure,
      players:     [],
      total:       0,
    }));
  } catch(_) {}

  // Enter MQTT room in background — don't await, go straight to pot screen
  const onBetJoin = (data) => {
    addPlayerToPot(data.addr, data.name || data.addr.slice(0,6), data.amount, data.side);
  };
  if (!state.inRoom) {
    enterRoom(betRoomCode, { onBetJoin }).catch(() => {});
  } else {
    room.onBetJoin = onBetJoin;
  }

  // Publish — fire and forget
  try { publishBetOpen(state.account.address, state.bet); } catch(_) {}
  try { publishGlobalBet({ ...state.bet, hostAddr: state.account.address }); } catch(_) {}

  // BroadcastChannel for same-device tabs
  bcSend('bet_open', {
    escrow:      state.bet.escrowAddr,
    description: state.bet.description,
    amountPer:   state.bet.amountPer,
    structure:   state.bet.structure,
    roomCode:    betRoomCode,
    hostAddr:    state.account.address,
  });

  // Host opened this bet — clear any pending bet glow on their own device
  clearPendingBetButton();
  if (_betScanTimer) { clearTimeout(_betScanTimer); _betScanTimer = null; }

  showScreen('pot');
  renderPotScreen();
}
function renderPotScreen() {
  const betText = document.getElementById('pot-bet-text');
  if (betText) betText.textContent = state.bet.description;
  const badge = document.getElementById('pot-struct-badge');
  if (badge) badge.textContent = {
    'winner-all':  'WINNER TAKES ALL',
    'flip':        'THE FLIP',
    'round-robin': 'ROUND ROBIN',
  }[state.bet.structure] || '';
  const totalEl = document.getElementById('pot-total');
  if (totalEl) totalEl.textContent = '$' + (state.bet.total || 0).toFixed(2);

  // Orb starts inert — goes .live when first player joins
  const orb = document.getElementById('pot-orb');
  if (orb) orb.classList.remove('live');

  const countdownEl = document.getElementById('pot-countdown');
  if (countdownEl) countdownEl.textContent = '';

  const statusEl = document.getElementById('pot-status');
  if (statusEl) statusEl.textContent = 'Waiting for bettors to throw in…';

  renderPotPlayers();
}
function renderPotPlayers() {
  const orbit = document.getElementById('pot-orbit');
  if (!orbit) return;
  orbit.innerHTML = '';
  const players = state.bet.players;
  const count   = players.length;
  if (!count) return;

  // Place chips evenly around a circle (radius = 95px, arena = 260px so center = 130px)
  const cx = 130, cy = 130, r = 95;
  players.forEach((p, i) => {
    const angle = (i / count) * 2 * Math.PI - Math.PI / 2;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    const initials = (p.name || p.addr.slice(0,4)).slice(0,2).toUpperCase();
    const chip = document.createElement('div');
    chip.className = 'pot-orbit-chip';
    chip.style.left = x + 'px';
    chip.style.top  = y + 'px';
    chip.textContent = initials;
    orbit.appendChild(chip);
  });
}
function addPlayerToPot(fromAddr, playerName, amount, side) {
  if (state.bet.players.find(p => p.addr === fromAddr)) return; // deduplicate
  const s = side || 'yes';
  state.bet.players.push({ addr: fromAddr, name: playerName || fromAddr.slice(0,6), amount, side: s });
  state.bet.total += amount;

  // Update orb total — animate number bump
  const totalEl = document.getElementById('pot-total');
  if (totalEl) {
    totalEl.textContent = '$' + state.bet.total.toFixed(0);
    totalEl.animate([
      { transform: 'scale(1.4)', color: '#00FF94' },
      { transform: 'scale(1)',   color: '#ffffff' }
    ], { duration: 400, easing: 'ease-out' });
  }

  // Activate orb on first player
  const orb = document.getElementById('pot-orb');
  if (orb) orb.classList.add('live');

  // First player in — start 10s countdown
  if (state.bet.players.length === 1) {
    startPotCountdown(10);
  }

  renderPotPlayers();
  moneyRain(3);

  // Keep persisted bet state in sync with players + total
  try {
    const saved = JSON.parse(localStorage.getItem('throw_active_bet') || 'null');
    if (saved && saved.isHost) {
      saved.players = state.bet.players;
      saved.total   = state.bet.total;
      localStorage.setItem('throw_active_bet', JSON.stringify(saved));
    }
  } catch(_) {}
}

let _potCountdownTimer = null;
function startPotCountdown(seconds) {
  const orb = document.getElementById('pot-orb');
  const countdownEl = document.getElementById('pot-countdown');
  const statusEl = document.getElementById('pot-status');

  if (orb) orb.classList.add('live');
  if (statusEl) statusEl.textContent = 'Window open — throw in now!';

  if (_potCountdownTimer) clearInterval(_potCountdownTimer);
  let remaining = seconds;
  if (countdownEl) countdownEl.textContent = remaining + 's';

  _potCountdownTimer = setInterval(() => {
    remaining--;
    if (countdownEl) countdownEl.textContent = remaining > 0 ? remaining + 's' : '';
    if (remaining <= 0) {
      clearInterval(_potCountdownTimer);
      _potCountdownTimer = null;
      if (orb) orb.classList.remove('live');
      const n = state.bet.players.length;
      if (statusEl) statusEl.textContent = n + ' player' + (n !== 1 ? 's' : '') + ' in — settle when ready';
      // Show settle buttons now that betting is closed
      const settleRow = document.getElementById('settle-row');
      if (settleRow) settleRow.style.display = '';
    }
  }, 1000);
}

/* ─── SETTLE ─── */
async function settleBet(hostWon) {
  if (!state.bet.active || !state.bet.isHost) return;

  const pot      = state.bet.total;
  const players  = state.bet.players;
  const hostAddr = state.account.address;

  showTxFlash('⚖️', '$' + pot.toFixed(2), 'Settling…');

  let results = [];

  try {
    if (DEMO_MODE) {
      // ── DEMO SETTLEMENT: no on-chain tx needed, just credit demo balances ──
      const fakeHash = () => '0xDEMO' + Math.random().toString(16).slice(2,14).toUpperCase();

      const payTo = (addr, amount) => {
        // If it's our own address, credit locally too
        if (addr.toLowerCase() === hostAddr.toLowerCase()) {
          state.total   = (state.total || 0) + amount;
          state.pathUSD = state.total;
          try { localStorage.setItem('throw_demo_balance', state.total.toFixed(6)); } catch(_) {}
          renderWalletUI();
        }
        // Always fire global MQTT credit so the recipient's device updates
        _demoCreditGlobal(addr, amount, fakeHash());
        return Promise.resolve();
      };

      if (state.bet.structure === 'winner-all') {
        if (hostWon) {
          await payTo(hostAddr, pot);
          results = [{ addr: hostAddr, amount: pot, type: 'win' }];
        } else {
          const share = pot / (players.length || 1);
          for (const p of players) {
            await payTo(p.addr, share);
            results.push({ addr: p.addr, amount: share, type: 'win' });
          }
        }
      } else if (state.bet.structure === 'flip') {
        const hostStake = state.bet.amountPer;
        if (hostWon) {
          await payTo(hostAddr, Math.min(hostStake * 2, pot));
          results = [{ addr: hostAddr, amount: Math.min(hostStake * 2, pot), type: 'win' }];
        } else {
          const share = Math.min(state.bet.amountPer * 2, pot / (players.length || 1));
          for (const p of players) {
            await payTo(p.addr, share);
            results.push({ addr: p.addr, amount: share, type: 'win' });
          }
        }
      } else {
        // Round robin
        if (hostWon) {
          await payTo(hostAddr, pot);
          results = [{ addr: hostAddr, amount: pot, type: 'win' }];
        } else {
          const sh = pot / (players.length || 1);
          for (const p of players) {
            await payTo(p.addr, sh);
            results.push({ addr: p.addr, amount: sh, type: 'win' });
          }
        }
      }

    } else {
      // ── REAL MONEY SETTLEMENT: send from escrow on-chain ──
      if (!state.bet.escrowKey) throw new Error('Escrow key missing — cannot settle. Start a new bet.');

      // wc carries the escrow PK — _escrowSend reads wc._escrowPK
      const wc = { _escrowPK: state.bet.escrowKey };
      const pc = null; // unused in ethers-based _escrowSend

      // Fee split: take THROW cut from pot before sending to winner
      const potFee = getBetFee(state.bet.amountPer) * (players.length + 1);
      const potNet = Math.max(0, pot - potFee);
      if (potFee >= 0.001) {
        try { await _escrowSendExact(state.bet.escrowKey, USDC_ADDR, TREASURY_ADDR, potFee); } catch(_) {}
      }

      if (state.bet.structure === 'winner-all') {
        if (hostWon) {
          await _escrowSend(wc, pc, hostAddr, potNet);
          results = [{ addr: hostAddr, amount: potNet, type: 'win' }];
        } else {
          const share = potNet / (players.length || 1);
          for (const p of players) {
            await _escrowSend(wc, pc, p.addr, share);
            results.push({ addr: p.addr, amount: share, type: 'win' });
          }
        }
      } else if (state.bet.structure === 'flip') {
        const hostStake = state.bet.amountPer;
        if (hostWon) {
          await _escrowSend(wc, pc, hostAddr, Math.min(hostStake * 2, potNet));
        } else {
          let remaining = potNet;
          for (const p of players) {
            const pay = Math.min(p.amount * 2, remaining / players.length);
            await _escrowSend(wc, pc, p.addr, pay);
            remaining -= pay;
            results.push({ addr: p.addr, amount: pay, type: 'win' });
          }
          if (remaining > 0.001) await _escrowSend(wc, pc, hostAddr, remaining);
        }
      } else {
        if (hostWon) {
          await _escrowSend(wc, pc, hostAddr, potNet);
        } else {
          const sh = potNet / (players.length || 1);
          for (const p of players) await _escrowSend(wc, pc, p.addr, sh);
        }
      }
    }

    publishBetSettled(state.account.address, hostWon, pot, state.bet.structure);
    clearGlobalBet();
    bcSend('bet_settled', { hostWon, yesWon: hostWon, pot, structure: state.bet.structure });
    try { localStorage.removeItem('throw_active_bet'); } catch(_) {}

    showSettledScreen(hostWon, pot, results);
    state.bet.active = false;

  } catch (e) {
    hideTxFlash();
    // Always clear the retained global bet so scanners stop glowing — even on failure
    try { clearGlobalBet(); } catch(_) {}
    try { localStorage.removeItem('throw_active_bet'); } catch(_) {}
    state.bet.active = false;
    alert('Settlement failed: ' + (e.shortMessage || e.message));
  }
}

// Exact token send from escrow by PK — used for fee collection
async function _escrowSendExact(escrowPK, tokenAddr, toAddr, usdAmount) {
  if (usdAmount < 0.001) return;
  const { ethers } = await getViem();
  const provider = new ethers.JsonRpcProvider(TEMPO_RPC);
  const wallet   = new ethers.Wallet(escrowPK, provider);
  const token    = new ethers.Contract(tokenAddr, ['function transfer(address,uint256) returns (bool)'], wallet);
  const raw      = ethers.parseUnits(usdAmount.toFixed(6), 6);
  const tx       = await token.transfer(toAddr, raw);
  return (await tx.wait()).hash;
}

async function _escrowSend(wc, pc, toAddr, usdAmount) {
  if (usdAmount < 0.001) return;
  const { ethers } = await getViem();

  // wc.account.source is the escrow private key stored on the wallet client
  const escrowPK   = wc._escrowPK || wc.account?._privateKey || wc._pk;
  const provider   = new ethers.JsonRpcProvider(TEMPO_RPC);
  const escrowWallet = new ethers.Wallet(escrowPK, provider);

  const TIP20_ABI = [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function balanceOf(address account) view returns (uint256)',
  ];

  // Check balances to pick token
  const usdcToken = new ethers.Contract(USDC_ADDR,    TIP20_ABI, escrowWallet);
  const pathToken = new ethers.Contract(PATHUSD_ADDR, TIP20_ABI, escrowWallet);
  const [uRaw, pRaw] = await Promise.all([
    usdcToken.balanceOf(escrowWallet.address),
    pathToken.balanceOf(escrowWallet.address),
  ]);
  const uFloat = Number(uRaw) / 1e6;
  const pFloat = Number(pRaw) / 1e6;

  // Settle USDC.e first, then pathUSD — send full available balance of each
  const settled = [];
  if (uFloat >= 0.001) {
    const tx = await usdcToken.transfer(toAddr, uRaw);
    const r  = await tx.wait();
    settled.push(r.hash);
  }
  if (pFloat >= 0.001) {
    const tx2 = await pathToken.transfer(toAddr, pRaw);
    const r2  = await tx2.wait();
    settled.push(r2.hash);
  }

  return settled[0];
}

/* ─── SETTLED SCREEN ─── */
function showSettledScreen(hostWon, pot, results) {
  hideTxFlash();
  showScreen('settled');
  const resultEl = document.getElementById('settled-result');
  resultEl.textContent = hostWon ? 'YOU WON 🏆' : 'THEY WIN 🤝';
  resultEl.className = 'settled-result ' + (hostWon ? 'win' : 'lose');

  document.getElementById('settled-breakdown').textContent =
    `Pot: $${pot.toFixed(2)} | ${state.bet.structure.replace('-', ' ').toUpperCase()} | ${state.bet.players.length} player${state.bet.players.length !== 1 ? 's' : ''}`;

  if (hostWon) moneyRain(8);
}

/* ═══════════════════════════════════════════════════════════════════════
   15. PLAYER-SIDE BET FLOW
   ═════════════════════════════════════════════════════════════════════ */
function openPlayerBet(betData) {
  Object.assign(state.bet, {
    active:      true,
    isHost:      false,
    description: betData.description,
    amountPer:   betData.amountPer,
    structure:   betData.structure,
    escrowAddr:  betData.escrow || betData.escrowAddr,
    hostAddr:    betData.hostAddr,
    roomCode:    betData.roomCode,
    side:        'yes',
  });

  showScreen('player-bet');

  // Populate host row
  const hostInitials = (() => {
    try {
      const n = localStorage.getItem('throw_contact_name_' + (betData.hostAddr || '').toLowerCase());
      if (n) return n.slice(0,2).toUpperCase();
    } catch(_) {}
    return (betData.hostAddr || '??').slice(2,4).toUpperCase();
  })();
  const avatarEl = document.getElementById('bet-host-avatar');
  if (avatarEl) avatarEl.textContent = hostInitials;
  const nameEl = document.getElementById('bet-host-name');
  if (nameEl) nameEl.textContent = hostInitials + ' opened a bet';

  // Populate bet card
  const descEl = document.getElementById('player-bet-desc');
  if (descEl) descEl.textContent = betData.description;
  const amtEl = document.getElementById('player-bet-amount');
  if (amtEl) amtEl.textContent = '$' + betData.amountPer + ' per player';
  const statusEl = document.getElementById('player-bet-status');
  if (statusEl) statusEl.textContent = 'Pick YES or NO, then throw in';

  // Throw orb — reset state
  const throwOrb = document.getElementById('bet-throw-orb');
  const orbLabel = document.getElementById('bet-throw-orb-label');
  const orbHint  = document.getElementById('bet-throw-orb-hint');
  if (throwOrb) {
    throwOrb.classList.remove('ready-yes', 'ready-no', 'throwing');
    throwOrb.onclick = null;
  }
  if (orbLabel) orbLabel.textContent = 'THROW IN';
  if (orbHint)  orbHint.textContent  = 'Pick a side first';

  // YES / NO buttons
  const yesBtn = document.getElementById('btn-side-yes');
  const noBtn  = document.getElementById('btn-side-no');
  if (yesBtn && noBtn) {
    const setSide = (s) => {
      state.bet.side = s;
      yesBtn.classList.toggle('active', s === 'yes');
      noBtn.classList.toggle('active',  s === 'no');
      if (throwOrb) {
        throwOrb.classList.remove('ready-yes', 'ready-no');
        throwOrb.classList.add(s === 'yes' ? 'ready-yes' : 'ready-no');
        throwOrb.onclick = executePlayerBetJoin;
      }
      if (orbHint) orbHint.textContent = 'Tap or flick to throw $' + betData.amountPer;
    };
    setSide('yes');
    yesBtn.onclick = () => setSide('yes');
    noBtn.onclick  = () => setSide('no');
  }
}

async function executePlayerBetJoin() {
  // Disable throw orb immediately to prevent double-fire
  const throwOrb = document.getElementById('bet-throw-orb');
  if (throwOrb) { throwOrb.onclick = null; throwOrb.classList.add('throwing'); }
  const statusEl = document.getElementById('player-bet-status');
  if (statusEl) statusEl.textContent = 'Sending…';

  try {
    await sendStablecoin(state.bet.escrowAddr, state.bet.amountPer);

    const myAddr  = state.account.address;
    const myName  = (() => {
      try { return localStorage.getItem('throw_my_name') || myAddr.slice(2,8).toUpperCase(); }
      catch(_) { return myAddr.slice(2,8).toUpperCase(); }
    })();
    const netAmt  = state.bet.amountPer - 0.10;
    const capSide = state.bet.side || 'yes';

    if (state.bet.roomCode) {
      if (!state.inRoom) {
        // Fire-and-forget — never block the throw on MQTT
        enterRoom(state.bet.roomCode, {
          onBetSettled: (data) => {
            if (!state.bet.isHost && (currentScreen === 'player-bet' || currentScreen === 'screen-player-bet')) {
              const won = (capSide === 'yes') ? !!data.yesWon : !data.yesWon;
              showScreen('settled');
              const resultEl = document.getElementById('settled-result');
              if (resultEl) {
                resultEl.textContent = won ? 'YOU WON' : 'THEY WIN';
                resultEl.className   = 'settled-result ' + (won ? 'win' : 'lose');
              }
              const breakdownEl = document.getElementById('settled-breakdown');
              if (breakdownEl) breakdownEl.textContent =
                'Pot: $' + ((data.pot || 0).toFixed(2)) + ' | ' + ((data.structure || '').replace('-', ' ').toUpperCase());
              if (won) moneyRain(8);
              state.bet.active = false;
              setTimeout(() => refreshBalances(), 3000);
            }
          },
        }).catch(() => {});
      }
      publishBetJoin(state.bet.hostAddr, myAddr, myName, netAmt, capSide, state.bet.roomCode);

      // HTTP relay fallback — pushes bet_join to host's wallet credit topic
      // so the host receives it even if MQTT room client isn't connected yet
      relayThrow({
        event:    'bet_join',
        topic:    'throw5/room/' + state.bet.roomCode + '/bet',
        hostAddr: state.bet.hostAddr,
        addr:     myAddr,
        name:     myName,
        amount:   netAmt,
        side:     capSide,
        ts:       Date.now(),
      });
    }

    bcSend('player_threw', { addr: myAddr, name: myName, amount: netAmt, side: capSide });
    const stEl = document.getElementById('player-bet-status');
    if (stEl) stEl.textContent = "You're in! Waiting for host...";
    const orbLbl = document.getElementById('bet-throw-orb-label');
    if (orbLbl) orbLbl.textContent = 'THROWN ✔';
    const orbHnt = document.getElementById('bet-throw-orb-hint');
    if (orbHnt) orbHnt.textContent = '';

    try { sonicSend(state.bet.amountPer); } catch(_) {}

  } catch (e) {
    const stEl2 = document.getElementById('player-bet-status');
    if (stEl2) stEl2.textContent = 'Failed: ' + e.message;
    // Re-enable throw orb on error
    const throwOrbErr = document.getElementById('bet-throw-orb');
    if (throwOrbErr) { throwOrbErr.classList.remove('throwing'); throwOrbErr.onclick = executePlayerBetJoin; }
  }
}


/* ═══════════════════════════════════════════════════════════════════════
   16. TX FLASH + ANIMATIONS
   ═════════════════════════════════════════════════════════════════════ */
let _txFlashTimer = null;
function showTxFlash(icon, amount, label) {
  document.getElementById('tx-icon').textContent   = icon;
  document.getElementById('tx-amount').textContent = amount;
  document.getElementById('tx-label').textContent  = label;
  document.getElementById('tx-flash').classList.remove('hidden');
  // Safety: auto-hide after 8s so screen never stays black
  clearTimeout(_txFlashTimer);
  _txFlashTimer = setTimeout(() => hideTxFlash(), 8000);
}
function hideTxFlash() {
  document.getElementById('tx-flash').classList.add('hidden');
}

function playThrowAnimation() {
  const el = document.getElementById('throw-anim');
  const bill = document.getElementById('money-bill');
  el.classList.remove('hidden');
  bill.style.animation = 'none';
  void bill.offsetWidth;
  bill.style.animation = '';
  setTimeout(() => el.classList.add('hidden'), 700);
}

function moneyRain(count = 6) {
  const container = document.createElement('div');
  container.className = 'money-rain';
  document.body.appendChild(container);
  const bills = ['💵', '💴', '💶', '💷', '💰'];
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.className = 'money-particle';
    p.textContent = bills[Math.floor(Math.random() * bills.length)];
    p.style.left = Math.random() * 95 + 'vw';
    const dur = 0.8 + Math.random() * 0.6;
    p.style.animation = `rainFall ${dur}s ${Math.random() * 0.3}s linear forwards`;
    container.appendChild(p);
  }
  setTimeout(() => container.remove(), 2000);
}

function shortAddr(addr) {
  return addr ? addr.slice(0, 5) + '…' + addr.slice(-3) : '???';
}

/* ═══════════════════════════════════════════════════════════════════════
   17. BROADCAST CHANNEL LISTENER
   ═════════════════════════════════════════════════════════════════════ */
bc.onmessage = (evt) => {
  const { type, payload } = evt.data;

  if (type === 'catcher_ready') {
    // Thrower gets catcher's address
    if (catcherResolve) {
      catcherResolve(payload.addr);
      catcherResolve = null;
    }
  }

  if (type === 'throw_confirmed') {
    // We're the receiver side — update balance
    if (payload.to === state.account?.address) {
      onMoneyReceived(payload.amount, payload.from);
    }
  }

  if (type === 'bet_open') {
    // Another device opened a bet — glow the THROW button, let user tap in
    if (!state.bet.isHost && state.account) {
      setPendingBetButton(payload);
    }
  }

  if (type === 'player_threw') {
    if (state.bet.isHost && currentScreen === 'pot') {
      addPlayerToPot(payload.addr, payload.name || payload.addr.slice(0,6), payload.amount, payload.side);
    }
  }

  if (type === 'bet_settled') {
    // Player learns outcome
    if (!state.bet.isHost && currentScreen === 'player-bet') {
      const won = !payload.hostWon; // if host lost, players won
      showScreen('settled');
      const resultEl = document.getElementById('settled-result');
      resultEl.textContent = won ? 'YOU WON 🏆' : 'HOST WINS 🤝';
      resultEl.className = 'settled-result ' + (won ? 'win' : 'lose');
      document.getElementById('settled-breakdown').textContent =
        `Pot: $${payload.pot.toFixed(2)} | ${payload.structure.toUpperCase().replace('-', ' ')}`;
      if (won) moneyRain(8);
      state.bet.active = false;
      state.bet.joined = false;       // reset so player can join the next bet
      state.bet.joinedEscrow = null;
      clearPendingBetButton();
      setTimeout(() => refreshBalances(), 3000);
    }
  }
};

/* ═══════════════════════════════════════════════════════════════════════
   18. VOICE AMOUNT
   ═════════════════════════════════════════════════════════════════════ */
function setupVoice() {
  const btn   = document.getElementById('voice-btn');
  const label = document.getElementById('voice-label');
  if (!btn) return;
  if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
    btn.style.display = 'none';
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const sr = new SR();
  sr.lang = 'en-US';
  sr.interimResults = false;

  btn.onclick = () => {
    btn.classList.add('listening');
    label.textContent = 'Listening…';
    sr.start();
  };
  sr.onresult = (e) => {
    const text = e.results[0][0].transcript.toLowerCase();
    const match = text.match(/(\d+(\.\d+)?)/);
    if (match) {
      const val = parseFloat(match[1]);
      if (val >= 1 && val <= 50) {
        state.throwAmount = val;
        document.getElementById('throw-amount-display').textContent = '$' + val;
        document.querySelectorAll('.throw-ui .qbtn').forEach(b => {
          b.classList.toggle('active', parseFloat(b.dataset.amount) === val);
        });
      }
    }
    btn.classList.remove('listening');
    label.textContent = 'Say it';
  };
  sr.onerror = () => {
    btn.classList.remove('listening');
    label.textContent = 'Say it';
  };
}


/* ═══════════════════════════════════════════════════════════════════════
   19. INSTALL QR SCREEN
   ═════════════════════════════════════════════════════════════════════ */
const APP_URL = 'https://throw5onit.com';

function isMobile() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

function isStandalone() {
  return window.matchMedia('(display-mode: fullscreen)').matches ||
         window.matchMedia('(display-mode: standalone)').matches ||
         navigator.standalone === true;
}

function renderInstallQR() {
  const canvas = document.getElementById('install-qr-canvas');
  if (typeof QRCode !== 'undefined') {
    QRCode.toCanvas(canvas, APP_URL, {
      width: 220,
      margin: 1,
      color: { light: '#ffffff', dark: '#000000' },
    });
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   19. EVENT WIRING (DOMContentLoaded)
   ═════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════
   SHARE TO X
   ═════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════
   18b. HANDLE + CONTACTS + CREW + DOCK + URL PARAMS
   ═════════════════════════════════════════════════════════════════════ */

/* ─ Handle (up to 6 chars, stored in localStorage) ─ */
function getHandle() {
  try { return localStorage.getItem('throw_handle') || ''; } catch(e) { return ''; }
}
function saveHandle(h) {
  try { localStorage.setItem('throw_handle', h.toUpperCase().slice(0,6)); } catch(e) {}
}

/* ─ Contacts store ─ */
// Schema: [{ name, addr, lastThrow, ts }]
function getContacts() {
  try {
    const local = localStorage.getItem('throw_contacts');
    if (local) return JSON.parse(local);
    // Fallback to sessionStorage if localStorage was wiped (iOS PWA)
    const session = sessionStorage.getItem('throw_contacts_bak');
    if (session) return JSON.parse(session);
    return [];
  } catch(e) { return []; }
}
function saveContacts(arr) {
  try { localStorage.setItem('throw_contacts', JSON.stringify(arr)); } catch(e) {}
  // Mirror to sessionStorage as backup against iOS eviction
  try { sessionStorage.setItem('throw_contacts_bak', JSON.stringify(arr)); } catch(e) {}
}
function showToast(msg, durationMs) {
  const el = document.getElementById('throw-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove('visible'), durationMs || 2500);
}

function resizeImageToDataUrl(file, maxPx, quality, cb) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(maxPx / img.width, maxPx / img.height, 1);
      const w = Math.round(img.width  * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      cb(canvas.toDataURL('image/jpeg', quality || 0.75));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function upsertContact(name, addr, extra) {
  const contacts = getContacts();
  const idx = contacts.findIndex(c => c.addr.toLowerCase() === addr.toLowerCase());
  const entry = {
    name: (name || addr.slice(0,6)).toUpperCase().slice(0,6),
    addr,
    lastThrow: Date.now(),
    ts: Date.now(),
    ...(extra || {}),
  };
  if (idx >= 0) {
    // Merge — preserve existing photo/phone unless new one provided
    contacts[idx] = { ...contacts[idx], ...entry };
  } else {
    contacts.unshift(entry);
  }
  saveContacts(contacts.slice(0, 20));
  renderCrew();
}
function touchContact(addr) {
  const contacts = getContacts();
  const idx = contacts.findIndex(c => c.addr.toLowerCase() === addr.toLowerCase());
  if (idx >= 0) { contacts[idx].lastThrow = Date.now(); saveContacts(contacts); renderCrew(); }
}

/* ─ Crew row render ─ */
function renderCrew() {
  const row = document.getElementById('crew-row');
  if (!row) return;
  const contacts = getContacts();
  if (!contacts.length) { row.innerHTML = ''; return; }
  row.innerHTML = contacts.slice(0, 8).map(c => {
    const initials = c.name.slice(0,2);
    const color = addrToColor(c.addr);
    return `<button class="crew-avatar" data-addr="${c.addr}" data-name="${c.name}" title="${c.name}" style="background:${color}">${initials}</button>`;
  }).join('');
  row.querySelectorAll('.crew-avatar').forEach(btn => {
    btn.onclick = () => openContactOverlay(btn.dataset.name, btn.dataset.addr);
  });
}
function addrToColor(addr) {
  const h = parseInt(addr.slice(2,6), 16) % 360;
  return `hsl(${h},55%,38%)`;
}

/* ─ Contact overlay ─ */
let contactOverlayTarget = null;
let contactOverlayAmount = 5;

function openContactOverlay(name, addr) {
  contactOverlayTarget = { name, addr };
  document.getElementById('contact-overlay-avatar').textContent = name.slice(0,2);
  document.getElementById('contact-overlay-avatar').style.background = addrToColor(addr);
  document.getElementById('contact-overlay-name').textContent = name;
  document.getElementById('contact-overlay-addr').textContent = addr.slice(0,6) + '…' + addr.slice(-4);
  // Show last throw if available
  const lastThrowRow = document.getElementById('contact-detail-lastthrow-row');
  const lastThrowEl  = document.getElementById('contact-detail-lastthrow');
  try {
    const history = JSON.parse(localStorage.getItem('throw_history') || '[]');
    const last = history.filter(h => h.to && h.to.toLowerCase() === addr.toLowerCase()).slice(-1)[0];
    if (last && lastThrowRow && lastThrowEl) {
      lastThrowEl.textContent = '$' + last.amount + ' — ' + new Date(last.ts).toLocaleDateString();
      lastThrowRow.style.display = '';
    } else if (lastThrowRow) {
      lastThrowRow.style.display = 'none';
    }
  } catch(_) {}
  document.getElementById('contact-overlay').classList.remove('hidden');
}
function closeContactOverlay() {
  document.getElementById('contact-overlay').classList.add('hidden');
  contactOverlayTarget = null;
}
function updateContactFeeLine() {
  const fee = getBetFee(contactOverlayAmount);
  const net = (contactOverlayAmount - fee).toFixed(2);
  document.getElementById('contact-fee-line').textContent = `$${fee.toFixed(2)} fee — they get $${net}`;
}
function initContactOverlay() {
  document.getElementById('contact-overlay-close').onclick = closeContactOverlay;
  document.getElementById('btn-contact-delete').onclick = () => {
    if (!contactOverlayTarget) return;
    const contacts = getContacts().filter(c => c.addr.toLowerCase() !== contactOverlayTarget.addr.toLowerCase());
    saveContacts(contacts);
    closeContactOverlay();
    renderCrew();
  };
  document.getElementById('contact-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('contact-overlay')) closeContactOverlay();
  });
  document.querySelectorAll('.contact-overlay-amounts .qbtn').forEach(b => {
    const a = parseFloat(b.dataset.camount);
    b.style.opacity = '';
    b.style.pointerEvents = '';
    if (state.total > 0 && a > state.total) { b.style.opacity = '0.35'; b.style.pointerEvents = 'none'; }
    b.onclick = () => {
      contactOverlayAmount = parseFloat(b.dataset.camount);
      document.querySelectorAll('.contact-overlay-amounts .qbtn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      updateContactFeeLine();
    };
  });
  // THROW button — goes to throw screen with this contact pre-selected
  document.getElementById('btn-contact-throw').onclick = () => {
    if (!contactOverlayTarget) return;
    const target = contactOverlayTarget;
    closeContactOverlay();
    openThrowScreen(target);
  };

  document.getElementById('btn-contact-bet').onclick = () => {
    if (!contactOverlayTarget) return;
    closeContactOverlay();
    openBetSetup();
  };
}

/* ─ DOCK logic ─ */
let dockScanStream   = null;
let dockScanInterval = null;

function openDockScreen() {
  showScreen('dock');
  stopDockScan();
  // Reset everything fresh each time
  document.getElementById('dock-friend-name').value = '';
  document.getElementById('dock-gift-qr').classList.add('hidden');
  document.getElementById('dock-gift-form').classList.remove('hidden');
  document.getElementById('dock-gift-addr').textContent = '';
  document.getElementById('dock-gift-name').textContent = 'them';
  document.getElementById('dock-scan-status').textContent = '';
  switchDockTab('new');
}

function switchDockTab(tab) {
  document.querySelectorAll('.dock-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.getElementById('dock-panel-new').classList.toggle('active', tab === 'new');
  document.getElementById('dock-panel-existing').classList.toggle('active', tab === 'existing');
  if (tab !== 'existing') stopDockScan();
}

async function dockGiftWallet() {
  const nameEl = document.getElementById('dock-friend-name');
  const name = nameEl.value.trim().toUpperCase().slice(0,6);
  if (!name) { nameEl.focus(); return; }

  const { ethers } = await getViem();
  const w   = ethers.Wallet.createRandom();
  const pk  = w.privateKey;
  const acc = { address: w.address };

  upsertContact(name, acc.address);

  const myAddr = state.account?.address || '';
  const myName = getHandle() || '';
  const url = `https://throw5onit-deploy.vercel.app?name=${encodeURIComponent(name)}&pk=${encodeURIComponent(pk)}&fromAddr=${encodeURIComponent(myAddr)}&fromName=${encodeURIComponent(myName)}`;
  document.getElementById('dock-gift-name').textContent = name;
  document.getElementById('dock-gift-addr').textContent = acc.address.slice(0,10) + '…';

  const canvas = document.getElementById('dock-gift-canvas');
  if (typeof QRCode !== 'undefined') {
    QRCode.toCanvas(canvas, url, { width: 220, margin: 1, color: { light: '#fff', dark: '#000' } });
  }
  document.getElementById('dock-gift-qr').classList.remove('hidden');
  document.getElementById('dock-gift-form').classList.add('hidden');
}

async function startDockScan() {
  const status = document.getElementById('dock-scan-status');
  const video  = document.getElementById('dock-scanner');
  const cnv    = document.getElementById('dock-scanner-canvas');
  status.textContent = 'Starting camera…';

  try {
    dockScanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = dockScanStream;
    video.classList.remove('hidden');
    await video.play();
    status.textContent = 'Point at their CATCH QR…';

    if ('BarcodeDetector' in window) {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      dockScanInterval = setInterval(async () => {
        try {
          const codes = await detector.detect(video);
          if (codes.length) { stopDockScan(); onDockScanResult(codes[0].rawValue); }
        } catch(_) {}
      }, 400);
    } else {
      cnv.classList.remove('hidden');
      const ctx = cnv.getContext('2d');
      dockScanInterval = setInterval(() => {
        if (!video.videoWidth) return;
        cnv.width  = video.videoWidth;
        cnv.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        if (typeof jsQR !== 'undefined') {
          const img  = ctx.getImageData(0, 0, cnv.width, cnv.height);
          const code = jsQR(img.data, img.width, img.height);
          if (code) { stopDockScan(); onDockScanResult(code.data); }
        }
      }, 400);
    }
  } catch(e) {
    status.textContent = 'Camera denied. Ask them to share their address manually.';
  }
}

function stopDockScan() {
  if (dockScanInterval) { clearInterval(dockScanInterval); dockScanInterval = null; }
  if (dockScanStream)   { dockScanStream.getTracks().forEach(t => t.stop()); dockScanStream = null; }
  const video = document.getElementById('dock-scanner');
  const cnv   = document.getElementById('dock-scanner-canvas');
  if (video) { video.classList.add('hidden'); video.srcObject = null; }
  if (cnv)   cnv.classList.add('hidden');
}

function onDockScanResult(raw) {
  const status = document.getElementById('dock-scan-status');
  let addr = raw.replace(/^tempo:/i, '').split('?')[0].trim();
  if (!addr.startsWith('0x') || addr.length !== 42) {
    status.textContent = '❌ Unrecognized QR — ask them to show their CATCH screen.';
    return;
  }
  const name = (prompt('What is their name? (up to 6 chars)') || '').trim();
  if (!name) { status.textContent = 'Scan cancelled.'; return; }
  upsertContact(name, addr);

  // Ping the scanned address so THEIR device auto-adds us back
  const myAddr = state.account?.address;
  const myName = (getHandle() || myAddr?.slice(0,6) || '').toUpperCase().slice(0,6);
  if (myAddr) {
    _notifyContactAdded(addr, myAddr, myName);
  }

  status.textContent = '✅ Docked with ' + name.toUpperCase().slice(0,6) + '!';
  setTimeout(() => showScreen('wallet'), 1500);
}

/* ─ URL param auto-import (?pk=&name=) ─ */
async function handleURLParams() {
  const params = new URLSearchParams(window.location.search);
  const pk   = params.get('pk');
  const name = params.get('name');
  if (!pk) return null;
  try {
    const acc = await importWallet(pk);
    if (name) saveHandle(name);
    saveWallet(acc);
    window.history.replaceState({}, '', window.location.pathname);
    return acc;
  } catch(e) {
    console.warn('URL param import failed:', e.message);
    return null;
  }
}

function openAddCashScreen() {
  showScreen('qr');
  const addr = state.account?.address || '';
  renderQR(addr);
  const pk = _storedPK || localStorage.getItem('throw_pk') || 'Not found';
  document.getElementById('backup-key-display').textContent = pk;
}

/* ─ First-launch camera scan ─ */
let _firstScanStream   = null;
let _firstScanInterval = null;

async function startFirstScan() {
  const video  = document.getElementById('first-scan-video');
  const canvas = document.getElementById('first-scan-canvas');
  const status = document.getElementById('first-scan-status');
  const startBtn = document.getElementById('btn-first-scan-start');
  if (!video) return;

  if (startBtn) startBtn.style.display = 'none';
  status.textContent = 'Opening camera…';

  try {
    _firstScanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = _firstScanStream;
    await video.play();
    status.textContent = 'Point your camera at your friend\'s screen';

    const ctx = canvas.getContext('2d');

    async function tick() {
      if (!_firstScanStream) return;
      if (!video.videoWidth) { requestAnimationFrame(tick); return; }
      canvas.width  = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);

      let result = null;

      // Try BarcodeDetector first (Android/Chrome)
      if ('BarcodeDetector' in window) {
        try {
          const detector = new BarcodeDetector({ formats: ['qr_code'] });
          const codes = await detector.detect(video);
          if (codes.length) result = codes[0].rawValue;
        } catch(_) {}
      }

      // jsQR fallback
      if (!result && typeof jsQR !== 'undefined') {
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height);
        if (code) result = code.data;
      }

      if (result) {
        stopFirstScan();
        await onFirstScanResult(result);
        return;
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  } catch(e) {
    status.textContent = 'Camera blocked — tap below to try again';
    if (startBtn) { startBtn.textContent = 'Try Camera Again'; startBtn.style.display = ''; }
    console.warn('First scan camera failed:', e);
  }
}

function stopFirstScan() {
  if (_firstScanStream) { _firstScanStream.getTracks().forEach(t => t.stop()); _firstScanStream = null; }
}

async function onFirstScanResult(raw) {
  const status = document.getElementById('first-scan-status');
  // Parse URL or plain pk
  let pk = null, name = null, fromAddr = '', fromName = '';
  try {
    const url    = new URL(raw);
    const params = url.searchParams;
    pk   = params.get('pk');
    name = params.get('name');
    fromAddr = params.get('fromAddr') || '';
    fromName = params.get('fromName') || '';
  } catch(_) {
    // Not a URL — maybe raw pk
    if (raw.startsWith('0x') && raw.length === 66) pk = raw;
  }

  if (!pk) {
    status.textContent = '❌ Not a THROW QR — ask your friend to show ADD FRIEND';
    setTimeout(startFirstScan, 2000);
    return;
  }

  status.textContent = '✅ Got it! Setting up your wallet…';
  try {
    const acc = await importWallet(pk);
    if (name) saveHandle(name);
    saveWallet(acc);
    // Auto-add the friend who invited you
    if (fromAddr && fromName) upsertContact(fromName, fromAddr);
    await initWallet(acc);
  } catch(e) {
    status.textContent = '❌ Something went wrong — try again';
    setTimeout(startFirstScan, 2000);
  }
}

const X_HANDLE = '@Throw_Bet';
const APP_SHARE_URL = 'https://throw5onit.com';

function shareOnX(text) {
  const tweet = encodeURIComponent(text);
  const url   = encodeURIComponent(APP_SHARE_URL);
  window.open(
    `https://x.com/intent/tweet?text=${tweet}&url=${url}`,
    '_blank', 'noopener,noreferrer'
  );
}

function hideBootLoader() {
  const bl = document.getElementById('boot-loader');
  if (!bl) return;
  bl.style.transition = 'opacity 0.2s';
  bl.style.opacity = '0';
  setTimeout(() => { try { bl.remove(); } catch(_) {} }, 250);
}

// Hard safety — boot loader gone within 10s even if JS errors
// Stored so sponsor splash flow can cancel it and control timing itself
let _bootKillTimer = setTimeout(hideBootLoader, 10000);

document.addEventListener('DOMContentLoaded', async () => {

  // Subscribe to global sponsor channel immediately — retained message arrives within ~1s
  try { subscribeSponsorChannel(); } catch(_) {}

  /* ── Handle gifted wallet URL params ── */
  const _urlParams = new URLSearchParams(window.location.search);
  const _giftPK       = _urlParams.get('pk');
  const _giftName     = _urlParams.get('name');
  const _giftFromAddr = _urlParams.get('fromAddr') || '';
  const _giftFromName = _urlParams.get('fromName') || '';
  const _hasGiftedPK  = !!_giftPK;

  if (_hasGiftedPK && !isStandalone()) {
    // In browser with gifted wallet URL — show install instructions.
    // CRITICAL: do NOT strip URL params — iOS saves current URL as PWA launch URL.
    // When they add to home screen and open the PWA, it launches with ?pk=...&name=... intact.
    // Wire all button handlers below, then stop — do NOT run wallet init.
  }

  /* ── Setup screen — choice buttons ── */
  document.getElementById('btn-invited-by-friend').onclick = () => {
    showScreen('first-scan');
  };
  document.getElementById('btn-just-me').onclick = () => {
    document.getElementById('setup-choice').classList.add('hidden');
    document.getElementById('setup-solo').classList.remove('hidden');
  };
  document.getElementById('btn-recover-wallet').onclick = () => {
    // Show solo panel with import area pre-opened
    document.getElementById('setup-choice').classList.add('hidden');
    document.getElementById('setup-solo').classList.remove('hidden');
    document.getElementById('import-area').classList.remove('hidden');
    // Update label so context is clear
    const hint = document.querySelector('#setup-solo .handle-input-hint');
    if (hint) hint.textContent = 'Enter your name, then paste your backup key below';
    // Scroll import area into view
    setTimeout(() => document.getElementById('import-key')?.focus(), 150);
  };

  /* ── Setup screen ── */
  document.getElementById('btn-new-wallet').onclick = async () => {
    // Save handle before creating wallet
    const handleVal = document.getElementById('handle-input').value.trim();
    if (handleVal) saveHandle(handleVal);
    const acc = await generateWallet();
    saveWallet(acc);
    // Show save-key screen before continuing
    document.getElementById('new-wallet-pk-display').textContent = acc.privateKey;
    showScreen('save-key');
    // Continue button routes to wallet/merchant
    document.getElementById('btn-save-key-done').onclick = () => routeAfterWallet(acc);
  };

  document.getElementById('btn-copy-new-pk').onclick = () => {
    const pk = document.getElementById('new-wallet-pk-display').textContent;
    navigator.clipboard?.writeText(pk);
    document.getElementById('btn-copy-new-pk').textContent = 'Copied!';
    setTimeout(() => document.getElementById('btn-copy-new-pk').textContent = 'Copy Key', 2000);
  };
  document.getElementById('btn-import-wallet').onclick = () => {
    document.getElementById('import-area').classList.toggle('hidden');
  };
  document.getElementById('btn-confirm-import').onclick = async () => {
    const pk = document.getElementById('import-key').value.trim();
    if (!pk) return;
    try {
      const acc = await importWallet(pk);
      routeAfterWallet(acc);
    } catch (e) {
      alert('Invalid key: ' + e.message);
    }
  };

  /* ── Merchant setup screen ── */
  initMerchantSetup();

  /* ── Merchant dashboard ── */
  document.getElementById('btn-merchant-show-qr').onclick = () => showMerchantQR('', 0);
  document.getElementById('btn-merchant-qr-close').onclick = () => {
    document.getElementById('merchant-qr-panel').classList.add('hidden');
  };
  document.getElementById('btn-merchant-menu-toggle').onclick = () => showScreen('merchant-setup');

  /* ── Wallet screen ── */
  document.getElementById('btn-throw').onclick  = openThrowScreen;

  document.getElementById('btn-open-bet').onclick = () => {
    if (!state.account) return;
    openBetSetup();
  };
  document.getElementById('btn-dock').onclick = openDockScreen;

  /* ── Dock screen ── */
  document.getElementById('dock-back').onclick = () => { stopDockScan(); showScreen('wallet'); };
  document.querySelectorAll('.dock-tab').forEach(tab => {
    tab.onclick = () => switchDockTab(tab.dataset.tab);
  });
  document.getElementById('btn-dock-gift').onclick = dockGiftWallet;
  document.getElementById('btn-dock-scan').onclick = startDockScan;

  /* ── Contact overlay ── */
  initContactOverlay();

  /* ── Throw screen ── */
  document.getElementById('btn-make-it-rain').onclick = () => moneyRain(12);
  document.getElementById('btn-qr-receive').onclick = () => openAddCashScreen();
  document.getElementById('btn-load-cash').onclick  = () => openAddCashScreen();

  // Manual address throw button
  document.getElementById('throw-addr-send').onclick = async () => {
    const input = document.getElementById('throw-addr-input');
    const addr = input.value.trim();
    if (!addr || addr.length < 10) { input.focus(); return; }
    selectThrowTarget('Friend', addr, null);
    await executeProximityThrow(state.throwTarget);
    input.value = '';
  };
  document.getElementById('throw-addr-input').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const addr = e.target.value.trim();
      if (!addr || addr.length < 10) return;
      selectThrowTarget('Friend', addr, null);
      await executeProximityThrow(state.throwTarget);
      e.target.value = '';
    }
  });
  // Share wallet address button
  const shareAddrBtn = document.getElementById('btn-share-my-addr');
  if (shareAddrBtn) {
    shareAddrBtn.onclick = () => {
      const addr = state.account?.address;
      if (!addr) return;
      const url = APP_URL + '/?addAddr=' + addr
        + '&addName=' + encodeURIComponent(getSelfProfile().name || getHandle() || '');
      if (navigator.share) {
        navigator.share({ title: 'My THROW address', text: 'Add me on THROW', url })
          .catch(() => navigator.clipboard?.writeText(addr));
      } else {
        navigator.clipboard?.writeText(addr);
        shareAddrBtn.textContent = 'Copied!';
        setTimeout(() => shareAddrBtn.textContent = 'Share address ↗', 2000);
      }
    };
  }

  // Also make addr display tap-to-copy
  const addrDisplay = document.getElementById('addr-share-display');
  if (addrDisplay) {
    addrDisplay.style.cursor = 'pointer';
    addrDisplay.onclick = () => {
      const addr = state.account?.address;
      if (!addr) return;
      navigator.clipboard?.writeText(addr);
      addrDisplay.textContent = 'Copied!';
      setTimeout(() => {
        addrDisplay.textContent = addr ? addr.slice(0,6) + '...' + addr.slice(-4) : '0x...';
      }, 1500);
    };
  }

  // Refresh balance button — stays on wallet screen, no reload
  const refreshBtn = document.getElementById('btn-refresh-balance');
  if (refreshBtn) {
    refreshBtn.onclick = async (e) => {
      e.stopPropagation();
      refreshBtn.style.opacity = '0.2';
      refreshBtn.style.transition = 'opacity 0.2s';
      try {
        if (DEMO_MODE) {
          renderWalletUI();
        } else {
          await refreshBalances();
        }
      } catch(_) {}
      refreshBtn.style.opacity = '0.45';
    };
  }

  document.getElementById('btn-history').onclick = () => {
    // Simple history toast — could expand to full screen
    if (!state.txHistory.length) { alert('No transactions yet.'); return; }
    const lines = state.txHistory.slice(0, 5).map(t =>
      `${t.type === 'sent' ? '→' : '←'} $${t.amount.toFixed(2)} · ${new Date(t.ts).toLocaleTimeString()}`
    ).join('\n');
    alert('Recent:\n' + lines);
  };

  /* ── Throw screen ── */
  document.getElementById('throw-back').onclick = () => showScreen('wallet');

  /* ── Bet setup screen ── */
  document.getElementById('bet-setup-back').onclick = () => showScreen('wallet');
  document.getElementById('btn-start-pot').onclick  = startPot;

  /* ── Pot screen ── */
  document.getElementById('btn-win').onclick  = () => settleBet(true);
  document.getElementById('btn-lose').onclick = () => settleBet(false);

  /* ── Settled screen ── */
  // Demo mode toggle — checkbox in profile modal
  const demoToggle = document.getElementById('demo-toggle');
  if (demoToggle) {
    demoToggle.checked = DEMO_MODE;
    demoToggle.onchange = () => setDemoMode(demoToggle.checked);
  }

  // My Profile modal — full wiring
  initMyProfile();
  updateSelfAvatar();

  // Handle ?addName=&addAddr= contact share links
  handleContactParams();

  // Demo mode button — prominent on wallet screen
  const demoBtnWallet = document.getElementById('btn-demo-toggle');
  if (demoBtnWallet) {
    demoBtnWallet.onclick = () => setDemoMode(!DEMO_MODE);
  }

  document.getElementById('btn-new-bet').onclick = () => {
    state.bet = { active: false, isHost: false, description: '', amountPer: 5, yesPot: 0, noPot: 0, side: null, hostAddr: null, roomCode: null,
      structure: 'winner-all', escrowKey: null, escrowAddr: null, players: [], total: 0 };
    openBetSetup();
  };
  document.getElementById('btn-settled-home').onclick = () => {
    state.bet.active = false;
    refreshBalances().then(() => showScreen('wallet'));
  };

  /* ── QR screen ── */
  document.getElementById('qr-back').onclick = () => showScreen('wallet');
  document.getElementById('btn-copy-addr').onclick = () => {
    if (!state.account) return;
    navigator.clipboard?.writeText(state.account.address);
    document.getElementById('btn-copy-addr').textContent = '1 — ✓ ADDRESS COPIED!';
    document.getElementById('fund-copied-toast').classList.remove('hidden');
    setTimeout(() => document.getElementById('btn-copy-addr').textContent = '1 — COPY MY WALLET ADDRESS', 2000);
  };

  document.getElementById('btn-open-tempo').onclick = () => {
    window.open('https://wallet.tempo.xyz', '_blank');
  };

  document.getElementById('btn-copy-pk').onclick = () => {
    const pk = _storedPK || localStorage.getItem('throw_pk') || '';
    navigator.clipboard?.writeText(pk);
    document.getElementById('btn-copy-pk').textContent = 'Copied!';
    setTimeout(() => document.getElementById('btn-copy-pk').textContent = 'Copy Backup Key', 2000);
  };

  /* ── Tempo Points modal ── */
  document.getElementById('tempo-points-badge').onclick = openPointsModal;
  document.getElementById('points-modal-close').onclick = closePointsModal;
  document.getElementById('points-modal').onclick = (e) => {
    if (e.target === document.getElementById('points-modal')) closePointsModal();
  };

  /* ── Share on X ── */
  document.getElementById('btn-share-x').onclick = () => {
    const won = document.getElementById('settled-result').classList.contains('win');
    const desc = state.bet.description || 'a bet';
    const pot  = state.bet.total > 0 ? ` $${state.bet.total.toFixed(2)} pot.` : '';
    const msg  = won
      ? `Just won ${desc} on THROW 🏆${pot} Digital cash, no login. ${X_HANDLE}`
      : `Just settled ${desc} on THROW 🤝${pot} Digital cash, no login. ${X_HANDLE}`;
    shareOnX(msg);
  };

  document.getElementById('btn-install-share-x').onclick = () => {
    shareOnX(`THROW — throw digital cash at your friends like real money 💵 No login. $50 max. Built on Tempo. ${X_HANDLE}`);
  };

  /* ── Splash screen ── */
  document.getElementById('btn-splash-enter').onclick = () => {
    if (!isMobile() && !isStandalone()) {
      // Desktop: show install QR
      showScreen('install');
    } else if (!isStandalone()) {
      // Mobile browser — show install-first instructions
      showScreen('install-first');
    } else {
      // Already in PWA — go straight to setup
      showScreen('setup');
    }
  };

  /* ── Demo wallet (splash) ── */
  const demoBtnSplash = document.getElementById('btn-splash-demo');
  if (demoBtnSplash) {
    demoBtnSplash.onclick = async () => {
      demoBtnSplash.textContent = 'Loading…';
      demoBtnSplash.disabled = true;
      try {
        // Reuse existing wallet if one exists — keeps address stable across sessions
        let acc = await loadWallet();
        if (!acc) {
          acc = await generateWallet();
          saveHandle('DEMO');
          saveWallet(acc);
        }
        setDemoMode(true);
        await initWallet(acc, false);
      } catch(e) {
        demoBtnSplash.textContent = 'Try Demo Wallet';
        demoBtnSplash.disabled = false;
      }
    };
  }

  /* ── Install first screen ── */
  document.getElementById('btn-already-installed').onclick = () => {
    // They say they installed — if now in PWA show first-scan, else setup
    if (isStandalone()) {
      showScreen('first-scan');
      // do NOT auto-start — iOS requires user gesture
    } else {
      showScreen('setup');
    }
  };

  /* ── First scan screen ── */
  document.getElementById('btn-first-scan-start').onclick = () => startFirstScan();
  document.getElementById('btn-first-scan-manual').onclick = () => {
    stopFirstScan();
    showScreen('setup');
  };

  /* ── Install screen ── */
  document.getElementById('btn-install-anyway').onclick = () => showScreen('setup');
  renderInstallQR();

  /* ── TX flash dismiss ── */
  document.getElementById('tx-flash').onclick = hideTxFlash;



  /* ══════════════════════════════════════════════════════════════════
     ROUTING — single decision tree, runs once, no fall-through
     ══════════════════════════════════════════════════════════════════ */
  await (async () => {
    // Check for gifted wallet in sessionStorage (set when browser→PWA handoff happens)
    let giftPK   = _giftPK;
    let giftName = _giftName;
    if (!giftPK) {
      try {
        giftPK   = sessionStorage.getItem('throw_gift_pk');
        giftName = sessionStorage.getItem('throw_gift_name');
        if (giftPK) {
          sessionStorage.removeItem('throw_gift_pk');
          sessionStorage.removeItem('throw_gift_name');
        }
      } catch(e) {}
    }

    if (giftPK && !isStandalone()) {
      // Browser: has a gifted wallet URL but not installed as PWA yet
      // Show install instructions — URL params preserved so PWA launch picks them up
      showScreen('install-first');
      return;
    }

    if (giftPK && isStandalone()) {
      // PWA launched with gifted wallet — import it
      try {
        const acc = await importWallet(giftPK);
        if (giftName) saveHandle(giftName);
        saveWallet(acc);
        if (_giftFromAddr && _giftFromName) upsertContact(_giftFromName, _giftFromAddr);
        window.history.replaceState({}, '', window.location.pathname);
        await initWallet(acc, true);
      } catch(e) {
        console.warn('Gift import failed:', e);
        showScreen('setup');
      }
      return;
    }

    // Normal load — check for existing wallet
    const saved = await loadWallet();
    if (saved) {
      // Returning user — resolve sponsor (venue GPS first, global fallback)
      // Run GPS check in background, don't block wallet load on it
      resolveActiveSponsor().then(sponsor => {
        if (sponsor) setSponsor(sponsor);
      }).catch(() => {});
      // Show splash only if we have a cached sponsor (GPS check is async — splash fires after)
      const _cachedSponsor = (() => {
        try { return JSON.parse(localStorage.getItem('throw_active_sponsor') || 'null'); } catch(_) { return null; }
      })();
      if (_cachedSponsor?.name) {
        setSponsor(_cachedSponsor);
        // Cancel hard-kill timer — we control boot loader hide ourselves
        clearTimeout(_bootKillTimer);
        // Hide boot loader, then show sponsor splash
        hideBootLoader();
        await showSponsorSplash(_cachedSponsor);
      }
      await initWallet(saved);
      return;
    }

    // No wallet yet
    if (isStandalone()) {
      // Installed PWA, first time — go to setup
      showScreen('setup');
    } else if (isMobile()) {
      // Mobile browser — prompt to install
      showScreen('install-first');
    } else {
      // Desktop browser — show splash/install page
      showScreen('splash');
    }
  })().catch(e => {
    console.error('Routing error:', e);
    showScreen(isStandalone() ? 'setup' : 'splash');
  }).finally(() => {
    // Delay boot-loader hide slightly so showScreen's setTimeout fires first
    // (showScreen uses a 0-30ms setTimeout to add .active — we wait 60ms to be safe)
    setTimeout(() => { hideBootLoader(); renderCrew(); }, 60);
  });

  /* ── Balance refresh every 30s ── */
  setInterval(() => {
    if (state.account && currentScreen === 'wallet') refreshBalances();
  }, 30000);

});

/* ═══════════════════════════════════════════════════════════════════════
   MERCHANT MODE
   ═════════════════════════════════════════════════════════════════════ */

const merchant = {
  mode: 'customer',   // 'customer' | 'merchant'
  bizName: '',
  items: [],          // [{name, price}]
  todayTotal: 0,
  throwCount: 0,
};

/* ── Mode toggle buttons ── */
function initModePicker() {
  document.getElementById('mode-btn-customer').onclick = () => setMode('customer');
  document.getElementById('mode-btn-merchant').onclick = () => setMode('merchant');
}

function setMode(mode) {
  merchant.mode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`mode-btn-${mode}`).classList.add('active');
}

/* ── After wallet created/imported — route based on mode ── */
async function routeAfterWallet(account, isNew = true) {
  try {
    if (merchant.mode === 'merchant') {
      document.getElementById('merchant-addr-display').textContent =
        '••••' + account.address.slice(-4).toUpperCase();
      showScreen('merchant-setup');
    } else {
      await initWallet(account, isNew);
    }
  } catch(e) {
    console.error('routeAfterWallet error:', e);
    showScreen('wallet');
  }
}

/* ── Merchant setup ── */
function initMerchantSetup() {
  renderMerchantItems();

  document.getElementById('btn-add-item').onclick = () => {
    document.getElementById('add-item-form').classList.remove('hidden');
    document.getElementById('new-item-name').focus();
  };

  document.getElementById('btn-save-item').onclick = () => {
    const name  = document.getElementById('new-item-name').value.trim();
    const price = parseInt(document.getElementById('new-item-price').value);
    if (!name) return;
    merchant.items.push({ name, price });
    document.getElementById('new-item-name').value = '';
    document.getElementById('add-item-form').classList.add('hidden');
    renderMerchantItems();
  };

  document.getElementById('btn-merchant-open').onclick = () => {
    const biz = document.getElementById('merchant-biz-name').value.trim();
    merchant.bizName = biz || 'MERCHANT';
    openMerchantDashboard();
  };
}

function renderMerchantItems() {
  const list = document.getElementById('merchant-items-list');
  list.innerHTML = merchant.items.map((item, i) =>
    `<div class="merchant-item-row">
      <span class="item-name">${item.name}</span>
      <span class="item-price">$${item.price}</span>
      <button class="item-remove" onclick="merchant.items.splice(${i},1);renderMerchantItems()">&#10005;</button>
    </div>`
  ).join('');
}

/* ── Open merchant dashboard ── */
function openMerchantDashboard() {
  document.getElementById('merchant-biz-display').textContent =
    merchant.bizName.toUpperCase();
  renderMerchantMenu();
  showScreen('merchant');
  listenForIncomingThrows();
}

function renderMerchantMenu() {
  const menu = document.getElementById('merchant-menu');
  if (!merchant.items.length) {
    menu.innerHTML = '<p class="menu-empty">No menu items — customers can scan your QR to throw any amount.</p>';
    return;
  }
  menu.innerHTML = merchant.items.map(item =>
    `<button class="merchant-item-btn" onclick="showMerchantQR('${item.name}', ${item.price})">
      <span class="mitem-name">${item.name}</span>
      <span class="mitem-price">$${item.price}</span>
      <span class="mitem-fee">customer pays $${item.price} · you get $${(item.price - 0.10).toFixed(2)}</span>
    </button>`
  ).join('');
}

/* ── QR panel for merchant ── */
function showMerchantQR(label, amount) {
  const addr = state.account?.address;
  if (!addr) return;
  const panel = document.getElementById('merchant-qr-panel');
  panel.classList.remove('hidden');
  document.getElementById('merchant-qr-label').textContent =
    label ? `${label} — $${amount}` : 'Scan to throw';

  // Encode address (+ optional amount) so customer THROW app can pre-fill
  const payload = amount
    ? `throw:${addr}?amount=${amount}`
    : `throw:${addr}`;

  const canvas = document.getElementById('merchant-qr-canvas');
  if (typeof QRCode !== 'undefined') {
    QRCode.toCanvas(canvas, payload, {
      width: 240, margin: 1,
      color: { light: '#ffffff', dark: '#000000' },
    });
  }
}

/* ── Listen for incoming throws via BroadcastChannel ── */
function listenForIncomingThrows() {
  const ch = new BroadcastChannel('throw_channel');
  ch.onmessage = (e) => {
    if (e.data?.type === 'throw_received' && e.data?.to === state.account?.address) {
      recordIncomingThrow(e.data.amount, e.data.from);
    }
  };
}

function recordIncomingThrow(amount, from) {
  merchant.todayTotal += amount;
  merchant.throwCount++;
  document.getElementById('merchant-total-display').textContent =
    `$${merchant.todayTotal.toFixed(2)}`;
  document.getElementById('merchant-throw-count').textContent =
    `${merchant.throwCount} throw${merchant.throwCount !== 1 ? 's' : ''} received`;

  // Add to feed
  const feed = document.getElementById('merchant-feed');
  document.getElementById('merchant-feed-empty')?.remove();
  const entry = document.createElement('div');
  entry.className = 'feed-entry';
  entry.innerHTML = `
    <span class="feed-from">&#8593; $${amount.toFixed(2)}</span>
    <span class="feed-addr">${from.slice(0,6)}\u2026${from.slice(-4)}</span>
    <span class="feed-time">${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span>
  `;
  feed.prepend(entry);
}

