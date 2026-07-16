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
      // QoS 1 + retain so late-connecting devices still get the credit
      c.publish('throw5/wallet/' + toAddr.toLowerCase() + '/credit', msg, { qos: 1, retain: true }, () => {
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

  // Poker state
  poker: null,
};

/* ═══════════════════════════════════════════════════════════════════════
   3. SCREEN ROUTER
   ═════════════════════════════════════════════════════════════════════ */
let currentScreen = 'setup';
let _screenTimer = null;

function showScreen(id) {
  // Hard-cancel in-flight transitions so rapid taps don't stack glitchy fades
  if (_screenTimer) { clearTimeout(_screenTimer); _screenTimer = null; }
  if (id !== 'qr') { try { stopFundBalancePoll(); } catch(_) {} }
  document.querySelectorAll('.screen.active, .screen.exit').forEach(el => {
    el.classList.remove('active', 'exit');
  });
  const next = document.getElementById('screen-' + id);
  if (!next) return;
  // Double rAF = paint-clean enter (avoids opacity flicker)
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      next.classList.add('active');
      currentScreen = id;
      if (id === 'first-scan') {
        stopFirstScan();
        const startBtn = document.getElementById('btn-first-scan-start');
        if (startBtn) { startBtn.style.display = ''; startBtn.textContent = 'Tap to Open Camera'; }
        const status = document.getElementById('first-scan-status');
        if (status) status.textContent = '';
      }
      if (id === 'wallet') renderCrew();
    });
  });
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
  try { renderDemoBanner(); } catch(_) {}

  // Brand-new empty pocket → Load for tonight story (skip if we already left wallet)
  if (isNew && !DEMO_MODE && (state.total || 0) < 1) {
    setTimeout(() => {
      if (currentScreen === 'wallet' && (state.total || 0) < 1) {
        openAddCashScreen();
        showToast('Load up to $' + CAP_USD + ' for tonight');
      }
    }, 650);
  }

  // Deep link: /?fund=1 opens the fund screen after wallet is ready
  try {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('fund') === '1') {
      sp.delete('fund');
      const q = sp.toString();
      window.history.replaceState({}, '', window.location.pathname + (q ? '?' + q : ''));
      setTimeout(() => openAddCashScreen(), 200);
    }
  } catch(_) {}

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

  // Pull-to-refresh for PWA (no browser chrome to pull)
  initPullToRefresh();
}

function initPullToRefresh() {
  let startY = 0, pulling = false;
  const threshold = 72; // px drag needed
  let indicator = null;

  const getIndicator = () => {
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'ptr-indicator';
      indicator.style.cssText = 'position:fixed;top:0;left:0;right:0;height:0;background:linear-gradient(180deg,rgba(0,224,176,0.18) 0%,transparent 100%);display:flex;align-items:flex-end;justify-content:center;padding-bottom:6px;transition:height 0.1s;z-index:9999;pointer-events:none;overflow:hidden;';
      indicator.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(0,224,176,0.7)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0;transition:opacity 0.2s"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
      document.body.appendChild(indicator);
    }
    return indicator;
  };

  document.addEventListener('touchstart', e => {
    if (window.scrollY === 0 && e.touches[0].clientY < 80) {
      startY = e.touches[0].clientY;
      pulling = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 0) {
      const ind = getIndicator();
      const h = Math.min(dy * 0.5, threshold);
      ind.style.height = h + 'px';
      const icon = ind.querySelector('svg');
      if (icon) icon.style.opacity = dy > threshold ? '1' : String(dy / threshold);
      if (dy > threshold) ind.querySelector('svg')?.setAttribute('stroke', 'rgba(0,224,176,1)');
    }
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (!pulling) return;
    pulling = false;
    const dy = e.changedTouches[0].clientY - startY;
    if (indicator) { indicator.style.height = '0'; }
    if (dy > threshold) {
      setTimeout(() => location.reload(), 150);
    }
  }, { passive: true });
}

// Subscribe to global sponsor broadcast channel (throw/sponsor, retained)
// Called at page load — no wallet required. Gets retained message from broker immediately.
function subscribeSponsorChannel() {
  try {
    const clientId = 'throw_spn_' + Math.random().toString(36).slice(2, 8);
    const c = mqtt.connect(MQTT_BROKER, { clientId, clean: true, connectTimeout: 8000, reconnectPeriod: 0 });
    c.on('connect', () => {
      c.subscribe('throw/sponsor', { qos: 0 });
      c.subscribe('throw/ads/inventory', { qos: 1 });
      c.subscribe('throw/venues', { qos: 1 });
    });
    c.on('message', (topic, msg) => {
      try {
        const raw = msg.toString();
        if (!raw) return;
        const data = JSON.parse(raw);
        if (topic === 'throw/ads/inventory') {
          try { localStorage.setItem('throw_ads_inventory', JSON.stringify(data)); } catch(_) {}
          if (data.network) {
            try { localStorage.setItem('throw_ad_network_cfg', JSON.stringify(data.network)); } catch(_) {}
          }
          // Refresh active sponsor from new inventory if we have GPS cache
          resolveActiveSponsor().then(sp => { if (sp) setSponsor(sp); }).catch(() => {});
          return;
        }
        if (topic === 'throw/venues') {
          const venues = Array.isArray(data) ? data : (data.venues || []);
          try { localStorage.setItem('throw_venues', JSON.stringify(venues)); } catch(_) {}
          return;
        }
        // Legacy throw/sponsor
        const sp  = data.sponsor  || null;
        const all = data.sponsors || (sp ? [sp] : []);
        _allSponsors = all;
        try { localStorage.setItem('throw_active_sponsor', JSON.stringify(sp)); } catch(_) {}
        try { localStorage.setItem('throw_all_sponsors',   JSON.stringify(all)); } catch(_) {}
        if (data.network) {
          try { localStorage.setItem('throw_ad_network_cfg', JSON.stringify(data.network)); } catch(_) {}
        }
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
  c.on('connect', () => c.subscribe(topic, { qos: 1 }));
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
            // Clear the retained message so it doesn't re-credit on next app open
            try { c.publish('throw5/wallet/' + myAddrLc + '/credit', '', { qos: 1, retain: true }); } catch(_) {}
          }
          // Show flash notification
          showTxFlash('💸', '$' + amt.toFixed(2), fromName + ' threw you $' + amt.toFixed(2) + '!');
          moneyRain();
          setTimeout(() => hideTxFlash(), 3000);
          state.txHistory.unshift({ type: 'received', amount: amt, from: fromName, ts: Date.now() });
          // Reset bet state + THROW button so player can bet again
          if (state.bet?.active && !state.bet?.isHost) {
            state.bet.active = false;
            state.bet.joined = false;
            state.bet.joinedEscrow = null;
            clearPendingBetButton();
          }
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
      // Someone claimed a throw you sent
      if (data.event === 'claim_claimed' && toMatch) {
        const amt = parseFloat(data.amount) || 0;
        showTxFlash('✅', '$' + amt.toFixed(2), 'They pocketed your throw');
        moneyRain(6);
        markOutgoingClaimClaimed(data.claimId, data.by);
        setTimeout(() => hideTxFlash(), 2500);
      }
      // Mutual contact add — someone scanned our QR, auto-add them back
      if (data.event === 'contact_added' && toMatch && data.fromAddr && data.fromName) {
        upsertContact(data.fromName, data.fromAddr);
        showToast('👋 ' + data.fromName + ' added you — added back!');
      }
      // Texas Hold'em invite — subscribe to table topic so poker_start reaches this phone
      if (data.event === 'poker_invite' && toMatch && data.roomCode) {
        acceptPokerInvite(data);
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
let _allSponsors   = [];    // all active sponsors for strip rotation
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
  // If sponsor splash is currently visible, update its logo live
  const splashScreen = document.getElementById('screen-sponsor-splash');
  const logoEl = document.getElementById('spsplash-logo');
  if (splashScreen && splashScreen.classList.contains('active') && logoEl && sponsor?.logoUrl) {
    logoEl.innerHTML = `<img src="${sponsor.logoUrl}" alt="${sponsor.name || ''}" />`;
    const nameEl = document.getElementById('spsplash-name');
    const tagEl  = document.getElementById('spsplash-tagline');
    if (nameEl && sponsor.name) nameEl.textContent = sponsor.name;
    if (tagEl  && sponsor.tagline) tagEl.textContent = sponsor.tagline;
  }
}

// Render sponsor logo in orb background
function renderOrbSponsor() {
  const bg = document.getElementById('orb-sponsor-bg');
  if (!bg) return;
  if (_activeSponsor?.logoUrl) {
    bg.innerHTML = `<img src="${_activeSponsor.logoUrl}" alt="${_activeSponsor.name}" draggable="false" />`;
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

    // Build item list — all active sponsors + house brand separators
    const items = [];
    const rotation = _allSponsors.length > 0 ? _allSponsors : (_activeSponsor ? [_activeSponsor] : []);
    if (rotation.length > 0) {
      rotation.forEach(sp => {
        for (let i = 0; i < 2; i++) items.push({ ...sp, paid: true });
      });
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
        // Name label under logo
        const lbl = document.createElement('div');
        lbl.className = 'sponsor-item-label';
        lbl.textContent = item.name || '';
        el.appendChild(lbl);
      } else {
        el.textContent = item.text || item.name?.slice(0,3) || '$';
      }
      // Click = tracked CPC (direct sold) or house — never open raw without tracking
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openSponsorClick(item, 'strip');
      });
      track.appendChild(el);
    });

    // CSS animation for smooth infinite scroll — tile height is 106px, no gap
    const totalItems = items.length;
    const itemH = 106; // matches CSS .sponsor-item height
    const totalH = totalItems * itemH;
    track.style.animation = 'none';
    track.style.transform = 'translateY(0)';
    // Use CSS animation on the track
    // ~3s per tile so it reads like a slow deliberate wheel
    track.style.animation = `stripScroll ${totalItems * 3}s linear infinite`;
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

// Log sponsor analytics event via MQTT (+ ads analytics for /ads dashboard)
function logSponsorEvent(type, item) {
  const payload = {
    event:     (type === 'click' || type === 'impression') ? type : 'sponsor_event',
    type,
    id:        item?.id || item?.name || 'house',
    sponsor:   item?.name || 'house',
    paid:      !!item?.paid,
    src:       item?._clickSrc || 'app',
    addr:      state.account?.address || 'anon',
    ts:        Date.now(),
  };
  try {
    const c = mqtt.connect(MQTT_BROKER, {
      clientId: 'sa_' + Math.random().toString(36).slice(2, 8),
      clean: true, connectTimeout: 4000, reconnectPeriod: 0,
    });
    c.on('connect', () => {
      c.publish('throw/sponsor/analytics', JSON.stringify(payload), { qos: 0 });
      c.publish('throw/ads/analytics', JSON.stringify(payload), { qos: 0 }, () => {
        try { c.end(true); } catch(_) {}
      });
    });
  } catch(_) {}
  try {
    fetch('/api/ads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch(_) {}
}

function openSponsorClick(item, src) {
  if (!item || item.text) return;
  item._clickSrc = src || 'strip';
  logSponsorEvent('click', item);
  const dest = item.url || item.clickUrl;
  if (!dest) return;
  const tracked = '/api/ads/click?id=' + encodeURIComponent(item.id || item.name || 'ad')
    + '&src=' + encodeURIComponent(src || 'strip')
    + '&url=' + encodeURIComponent(dest);
  window.open(tracked, '_blank', 'noopener');
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

// ── GPS + inventory ad resolution ─────────────────────────────────────────
// Priority: venue/geo sold inventory → legacy venues → global MQTT sponsor → Coinzilla fill

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
  const now = Date.now();
  const scored = [];
  for (const zone of inventory.zones) {
    if (zone.status && zone.status !== 'active') continue;
    const ads = (zone.ads || []).filter(a => a && a.name && a.status !== 'paused' && (!a.endsAt || a.endsAt > now));
    if (!ads.length) continue;
    let score = 0;
    let dist = null;
    if (zone.type === 'global') {
      score = 10;
    } else if ((zone.type === 'geo' || zone.type === 'venue') && zone.lat != null && zone.lng != null && lat != null && lng != null) {
      dist = haversineDistMi(lat, lng, Number(zone.lat), Number(zone.lng));
      const radius = Number(zone.radiusMi) || (zone.type === 'venue' ? 0.25 : 25);
      if (dist > radius) continue;
      score = zone.type === 'venue' ? 100 - dist * 10 : 70 - dist;
    } else if (zone.type === 'geo' || zone.type === 'venue') {
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
        venueId: zone.type === 'venue' ? (zone.venueId || zone.id) : undefined,
        paid: true,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
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

function mountCoinzillaFill(zoneId) {
  if (!zoneId) return;
  let host = document.getElementById('coinzilla-fill');
  if (!host) {
    host = document.createElement('div');
    host.id = 'coinzilla-fill';
    host.style.cssText = 'width:100%;max-width:320px;margin:10px auto 0;min-height:0';
    const arena = document.querySelector('#screen-wallet .action-grid');
    if (arena && arena.parentNode) arena.parentNode.insertBefore(host, arena);
    else {
      const wallet = document.getElementById('screen-wallet');
      if (wallet) wallet.appendChild(host);
      else document.body.appendChild(host);
    }
  }
  if (host.dataset.zone === String(zoneId) && host.childNodes.length) return;
  host.dataset.zone = String(zoneId);
  host.innerHTML = '';
  const unit = document.createElement('div');
  unit.className = 'coinzilla';
  unit.setAttribute('data-zone', String(zoneId));
  host.appendChild(unit);
  if (!document.getElementById('coinzilla-lib')) {
    const s = document.createElement('script');
    s.id = 'coinzilla-lib';
    s.async = true;
    s.src = 'https://coinzillatag.com/lib/display.js';
    document.head.appendChild(s);
  }
  try {
    window.coinzilla_display = window.coinzilla_display || [];
    window.coinzilla_display.push({ zone: String(zoneId) });
  } catch(_) {}
}

function clearCoinzillaFill() {
  const host = document.getElementById('coinzilla-fill');
  if (host) { host.innerHTML = ''; delete host.dataset.zone; }
}

async function resolveActiveSponsor() {
  let lat = null, lng = null;
  try {
    const pos = await new Promise((res, rej) =>
      navigator.geolocation.getCurrentPosition(res, rej, { timeout: 3000, maximumAge: 60000 })
    );
    lat = pos.coords.latitude;
    lng = pos.coords.longitude;
    try { localStorage.setItem('throw_last_geo', JSON.stringify({ lat, lng, ts: Date.now() })); } catch(_) {}
  } catch(_) {
    try {
      const cached = JSON.parse(localStorage.getItem('throw_last_geo') || 'null');
      if (cached && Date.now() - cached.ts < 30 * 60 * 1000) {
        lat = cached.lat; lng = cached.lng;
      }
    } catch(_) {}
  }

  try {
    const inv = JSON.parse(localStorage.getItem('throw_ads_inventory') || 'null');
    const picked = pickAdsFromInventory(inv, lat, lng);
    if (picked.length) {
      _allSponsors = picked;
      clearCoinzillaFill();
      logSponsorEvent('impression', picked[0]);
      return picked[0];
    }
  } catch(_) {}

  if (lat != null && lng != null) {
    const venue = getNearbyVenueSponsor(lat, lng);
    if (venue) { clearCoinzillaFill(); return venue; }
  }

  try {
    const sp = JSON.parse(localStorage.getItem('throw_active_sponsor') || 'null');
    if (sp?.name) { clearCoinzillaFill(); return sp; }
  } catch(_) {}

  try {
    const net = JSON.parse(localStorage.getItem('throw_ad_network_cfg') || 'null');
    if (net?.fillWhenEmpty !== false && net?.zoneId) {
      mountCoinzillaFill(net.zoneId);
    } else {
      fetch('/api/ads' + (lat != null ? ('?lat=' + lat + '&lng=' + lng) : ''))
        .then(r => r.json())
        .then(data => {
          if (data?.network?.enabled && data.network.zoneId && data.network.fillWhenEmpty !== false) {
            try { localStorage.setItem('throw_ad_network_cfg', JSON.stringify(data.network)); } catch(_) {}
            mountCoinzillaFill(data.network.zoneId);
          }
        })
        .catch(() => {});
    }
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

  // Empty / low pocket → push Load for tonight
  const loadBtn = document.getElementById('btn-load-tonight');
  if (loadBtn) {
    const empty = (state.total || 0) < 1;
    loadBtn.classList.toggle('hidden', !empty || currentScreen !== 'wallet');
    // Always bind
    loadBtn.onclick = () => openAddCashScreen();
  }
  updateFundBalanceChip();
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

// Escrow deposit — full face amount, no 1% throw fee.
// Poker rake / bet fees are taken at settlement from the pot, not on each throw-in.
async function sendEscrowDeposit(escrowAddr, usdAmount) {
  if (!escrowAddr) throw new Error('Escrow address missing');
  if (!(usdAmount > 0)) return null;
  if (DEMO_MODE) {
    if (state.total < usdAmount) throw new Error('Insufficient demo balance');
    state.total   = Math.max(0, state.total - usdAmount);
    state.pathUSD = state.total;
    try { localStorage.setItem('throw_demo_balance', state.total.toFixed(6)); } catch(_) {}
    renderWalletUI();
    return '0xESCROW' + Math.random().toString(16).slice(2, 12).toUpperCase();
  }
  let tokenAddr;
  if (state.usdc >= usdAmount) {
    tokenAddr = USDC_ADDR;
  } else if (state.pathUSD >= usdAmount) {
    tokenAddr = PATHUSD_ADDR;
  } else if ((state.pathUSD + state.usdc) >= usdAmount) {
    if (state.usdc > 0.001) {
      await _sendToken(USDC_ADDR, 6, escrowAddr, state.usdc);
      const remainder = usdAmount - state.usdc;
      if (remainder > 0.001) await _sendToken(PATHUSD_ADDR, 6, escrowAddr, remainder);
      return;
    }
    tokenAddr = PATHUSD_ADDR;
  } else {
    throw new Error('Insufficient balance');
  }
  return await _sendToken(tokenAddr, 6, escrowAddr, usdAmount);
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
let _throwInFlight = false;
async function executeProximityThrow(target) {
  if (_throwInFlight) return;
  if (!target || !target.addr) {
    showToast('Select a friend first');
    return;
  }

  _throwInFlight = true;
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
    showToast('Throw failed: ' + (e.message || String(e)));
    showScreen('wallet');
  } finally {
    _throwInFlight = false;
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

  // Haptic feedback — escalating rhythm on catch
  try { if (navigator.vibrate) navigator.vibrate([30,40,50,40,80,40,100,30,150,20,200]); } catch(_) {}

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
    const netAmt = state.bet.amountPer - getThrowFee(state.bet.amountPer);

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
  // Clear any inline styles set during join flow so CSS classes take over cleanly
  btn.style.background  = '';
  btn.style.boxShadow   = '';
  btn.style.opacity     = '';
  btn.style.pointerEvents = '';
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
      const startBtn = document.getElementById('btn-start-pot');
      if (startBtn) startBtn.textContent = (c.dataset.struct === 'texas-holdem') ? 'Set Up Table' : 'Open the Pot';
    };
  });
  // Reset button label on open
  const startBtn = document.getElementById('btn-start-pot');
  if (startBtn) startBtn.textContent = (state.bet.structure === 'texas-holdem') ? 'Set Up Table' : 'Open the Pot';
}

async function startPot() {
  // Texas Hold'em branches off into its own setup flow
  if (state.bet.structure === 'texas-holdem') {
    openPokerSetup().catch(e => {
      console.error('openPokerSetup failed', e);
      alert('Could not open table: ' + (e.message || e));
    });
    return;
  }
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

  // Enter MQTT bet room in background — always subscribe to betRoomCode regardless
  // of whether we're already in a general proximity room, so bet_join messages reach host
  const onBetJoin = (data) => {
    addPlayerToPot(data.addr, data.name || data.addr.slice(0,6), data.amount, data.side);
  };
  enterRoom(betRoomCode, { onBetJoin }).catch(() => {});

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

  // Deduct host stake and seed pot display (both demo and live)
  if (DEMO_MODE) {
    const stake = state.bet.amountPer;
    state.total   = Math.max(0, state.total - stake);
    state.pathUSD = state.total;
    try { localStorage.setItem('throw_demo_balance', state.total.toFixed(6)); } catch(_) {}
    renderWalletUI();
    addPlayerToPot(state.account.address, 'You (host)', stake, 'yes');
  } else {
    // Live: send host stake to escrow so pot is correctly seeded
    const stake = state.bet.amountPer;
    try {
      await sendStablecoin(state.bet.escrowAddr, stake);
      state.bet.total = stake - getThrowFee(stake);
      addPlayerToPot(state.account.address, 'You (host)', state.bet.total, 'yes');
      await refreshBalances();
    } catch(e) {
      alert('Could not open bet: ' + (e.shortMessage || e.message));
      state.bet.active = false;
      try { localStorage.removeItem('throw_active_bet'); } catch(_) {}
      return;
    }
  }

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

      const myAddrLc = state.account?.address?.toLowerCase();
      const payTo = (addr, amount) => {
        // Credit locally if it's any address on THIS device (host or player)
        if (addr.toLowerCase() === myAddrLc) {
          state.total   = (state.total || 0) + amount;
          state.pathUSD = state.total;
          try { localStorage.setItem('throw_demo_balance', state.total.toFixed(6)); } catch(_) {}
          renderWalletUI();
        }
        // Also fire MQTT so other devices get credited
        _demoCreditGlobal(addr, amount, fakeHash());
        return Promise.resolve();
      };

      // Exclude host from player payout list (host added to players for pot display only)
      const nonHostPlayers = players.filter(p => p.addr.toLowerCase() !== hostAddr.toLowerCase());
      const payoutPlayers  = nonHostPlayers.length > 0 ? nonHostPlayers : players;

      if (state.bet.structure === 'winner-all') {
        if (hostWon) {
          await payTo(hostAddr, pot);
          results = [{ addr: hostAddr, amount: pot, type: 'win' }];
        } else {
          const share = pot / (payoutPlayers.length || 1);
          for (const p of payoutPlayers) {
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
          const share = Math.min(state.bet.amountPer * 2, pot / (payoutPlayers.length || 1));
          for (const p of payoutPlayers) {
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
          const sh = pot / (payoutPlayers.length || 1);
          for (const p of payoutPlayers) {
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

      // Exclude host from payout list — host was seeded to pot display only
      const nonHostPlayers = players.filter(p => p.addr.toLowerCase() !== hostAddr.toLowerCase());
      const payoutPlayers  = nonHostPlayers.length > 0 ? nonHostPlayers : players;

      // Fee: per-participant including host (all 3 put money in)
      const potFee = getBetFee(state.bet.amountPer) * players.length;
      const potNet = Math.max(0, pot - potFee);
      if (potFee >= 0.001) {
        try { await _escrowSendExact(state.bet.escrowKey, USDC_ADDR, TREASURY_ADDR, potFee); } catch(_) {}
      }
      // Refill EXECUTOR with 2% of the bet fee so it stays funded from live volume.
      try { await _refillExecutor(state.bet.escrowKey, potFee); } catch(_) {}

      if (state.bet.structure === 'winner-all') {
        if (hostWon) {
          await _escrowSend(wc, pc, hostAddr, potNet);
          results = [{ addr: hostAddr, amount: potNet, type: 'win' }];
        } else {
          const share = potNet / (payoutPlayers.length || 1);
          for (const p of payoutPlayers) {
            await _escrowSend(wc, pc, p.addr, share);
            results.push({ addr: p.addr, amount: share, type: 'win' });
          }
        }
      } else if (state.bet.structure === 'flip') {
        const hostStake = state.bet.amountPer;
        if (hostWon) {
          await _escrowSend(wc, pc, hostAddr, Math.min(hostStake * 2, potNet));
          results = [{ addr: hostAddr, amount: Math.min(hostStake * 2, potNet), type: 'win' }];
        } else {
          // Players each win up to 2× their stake; dust goes to treasury not host
          const share = Math.min(state.bet.amountPer * 2, potNet / (payoutPlayers.length || 1));
          for (const p of payoutPlayers) {
            await _escrowSend(wc, pc, p.addr, share);
            results.push({ addr: p.addr, amount: share, type: 'win' });
          }
          // Burn any remaining dust to treasury
          const dust = potNet - share * payoutPlayers.length;
          if (dust > 0.001) { try { await _escrowSendExact(state.bet.escrowKey, USDC_ADDR, TREASURY_ADDR, dust); } catch(_) {} }
        }
      } else {
        // Round-robin
        if (hostWon) {
          await _escrowSend(wc, pc, hostAddr, potNet);
          results = [{ addr: hostAddr, amount: potNet, type: 'win' }];
        } else {
          const sh = potNet / (payoutPlayers.length || 1);
          for (const p of payoutPlayers) {
            await _escrowSend(wc, pc, p.addr, sh);
            results.push({ addr: p.addr, amount: sh, type: 'win' });
          }
        }
      }
    }

    publishBetSettled(state.account.address, hostWon, pot, state.bet.structure);
    clearGlobalBet();
    const nonHostCount = state.bet.players.filter(p => p.addr.toLowerCase() !== state.account.address.toLowerCase()).length;
    bcSend('bet_settled', { hostWon, yesWon: hostWon, pot, structure: state.bet.structure, playerCount: nonHostCount || state.bet.players.length, amountPer: state.bet.amountPer });
    try { localStorage.removeItem('throw_active_bet'); } catch(_) {}

    showSettledScreen(hostWon, pot, results);
    state.bet.active = false;

    // Auto-refill agent wallets if needed — non-blocking, best-effort
    fetch('/api/refill-agents', { method: 'POST' }).catch(() => {});

  } catch (e) {
    hideTxFlash();
    // Always clear the retained global bet so scanners stop glowing — even on failure
    try { clearGlobalBet(); } catch(_) {}
    try { localStorage.removeItem('throw_active_bet'); } catch(_) {}
    state.bet.active = false;
    alert('Settlement failed: ' + (e.shortMessage || e.message));
  }
}

// Post the unsigned transfer intent to the Vercel sponsor endpoint, which
// co-signs as EXECUTOR feePayer (EXECUTOR holds pathUSD; the fresh escrow
// wallet does not, so it cannot pay Tempo's state-creation fee on its own).
async function _sponsorTransfer(fromPK, tokenAddr, toAddr, usdAmount) {
  const res = await fetch('/api/sponsor-tx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fromPK,
      to: toAddr,
      tokenAddr,
      amount: Number(usdAmount).toFixed(6),
    }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch(_) { body = { error: text }; }
  if (!res.ok || body.error) {
    throw new Error(body.error || ('sponsor-tx HTTP ' + res.status));
  }
  return body.hash;
}

// Read-only balance probe (still via ethers — no tx signing needed).
async function _escrowBalances(escrowPK) {
  const { ethers } = await getViem();
  const provider = new ethers.JsonRpcProvider(TEMPO_RPC);
  const wallet   = new ethers.Wallet(escrowPK, provider);
  const abi      = ['function balanceOf(address) view returns (uint256)'];
  const usdc = new ethers.Contract(USDC_ADDR,    abi, provider);
  const path = new ethers.Contract(PATHUSD_ADDR, abi, provider);
  const [u, p] = await Promise.all([usdc.balanceOf(wallet.address), path.balanceOf(wallet.address)]);
  return { addr: wallet.address, usdcRaw: u, pathRaw: p, usdc: Number(u)/1e6, path: Number(p)/1e6 };
}

// Exact token send from escrow by PK — used for fee / dust collection.
// Uses sponsor endpoint so the escrow wallet does not need pathUSD for gas.
async function _escrowSendExact(escrowPK, tokenAddr, toAddr, usdAmount) {
  if (usdAmount < 0.0001) return;
  return await _sponsorTransfer(escrowPK, tokenAddr, toAddr, usdAmount);
}

// Full payout from escrow — prefer USDC, fall back to pathUSD for the remainder.
// Each leg is routed through the sponsor endpoint so EXECUTOR covers gas.
async function _escrowSend(wc, pc, toAddr, usdAmount) {
  if (usdAmount < 0.0001) return;
  const escrowPK = wc._escrowPK || wc.account?._privateKey || wc._pk;
  if (!escrowPK) throw new Error('escrow private key missing');

  const bal = await _escrowBalances(escrowPK);
  let remaining = usdAmount;
  const hashes  = [];

  // USDC first (up to what's available, minus the 0.0455% headroom — the
  // endpoint clamps the raw amount, but picking the right token here avoids
  // sending a second leg we don't need).
  const usdcSendable = bal.usdc / (1 + 0.000455);
  if (usdcSendable >= 0.001 && remaining > 0) {
    const take = Math.min(usdcSendable, remaining);
    if (take >= 0.001) {
      hashes.push(await _sponsorTransfer(escrowPK, USDC_ADDR, toAddr, take));
      remaining -= take;
    }
  }

  // pathUSD for the remainder.
  if (remaining >= 0.001) {
    const pathSendable = bal.path / (1 + 0.000455);
    if (pathSendable >= 0.001) {
      const take = Math.min(pathSendable, remaining);
      if (take >= 0.001) {
        hashes.push(await _sponsorTransfer(escrowPK, PATHUSD_ADDR, toAddr, take));
      }
    }
  }

  return hashes[0];
}

// Refill EXECUTOR wallet from the escrow (after bet fees are collected to treasury).
// Keeps EXECUTOR self-funded from per-bet volume.
const EXECUTOR_ADDR = '0xca550eDD527C353F1Bb88619fb58eb65d7c222d4';
async function _refillExecutor(escrowPK, throwFee) {
  if (!throwFee || throwFee < 0.001) return;
  const refillAmt = Math.round(throwFee * 0.02 * 1e6) / 1e6;
  if (refillAmt < 0.001) return;
  try {
    // Prefer pathUSD (native fee token EXECUTOR uses)
    const bal = await _escrowBalances(escrowPK);
    const token = bal.path >= refillAmt ? PATHUSD_ADDR : USDC_ADDR;
    await _sponsorTransfer(escrowPK, token, EXECUTOR_ADDR, refillAmt);
  } catch (e) {
    console.warn('[THROW] executor refill failed:', e && (e.shortMessage || e.message));
  }
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

  // Always reset bet button state after settlement
  state.bet.joined      = false;
  state.bet.joinedEscrow = null;
  state.bet.isHost      = false;
  clearPendingBetButton();
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
    const netAmt  = state.bet.amountPer - getThrowFee(state.bet.amountPer);
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
              state.bet.joined = false;
              state.bet.joinedEscrow = null;
              clearPendingBetButton(); // resets inline styles + restores THROW button
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

// Make it rain — throw the selected amount at EVERY peer in the room (casino tip energy)
let _raining = false;
async function executeMakeItRain() {
  if (_raining) return;
  const amount = state.throwAmount || 5;
  const targets = (typeof getAllTargets === 'function' ? getAllTargets() : null)
    || state.roomPeers
    || [];
  const peers = (targets || []).filter(t => t && t.addr && t.addr.toLowerCase() !== (state.account?.address || '').toLowerCase());
  if (!peers.length) {
    showToast('Need 2+ friends in the room to make it rain');
    return;
  }
  const totalNeeded = amount * peers.length;
  if ((state.total || 0) < totalNeeded) {
    showToast('Need $' + totalNeeded.toFixed(2) + ' to rain on ' + peers.length + ' people');
    return;
  }

  _raining = true;
  const btn = document.getElementById('btn-make-it-rain');
  if (btn) { btn.disabled = true; btn.textContent = 'RAINING…'; }
  moneyRain(Math.min(24, 6 + peers.length * 3));
  showTxFlash('💸', '$' + amount + ' × ' + peers.length, 'Making it rain…');

  let ok = 0;
  const fromAddr = state.account.address;
  for (const peer of peers) {
    try {
      await sendStablecoin(peer.addr, amount);
      notifyReceiverDirect(peer.addr, amount);
      if (state.inRoom) publishThrow(fromAddr, peer.addr, amount);
      touchContact(peer.addr);
      points.add(amount);
      ok++;
    } catch (e) {
      console.warn('[THROW] rain failed for', peer.addr, e && (e.shortMessage || e.message));
    }
  }

  hideTxFlash();
  if (ok > 0) {
    showTxFlash('✅', '$' + (amount * ok).toFixed(2), 'Rained on ' + ok + ' pocket' + (ok === 1 ? '' : 's') + '!');
    moneyRain(10);
  } else {
    showToast('Rain failed — check balance');
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = '💸 Make It Rain';
  }
  _raining = false;
  setTimeout(() => { hideTxFlash(); showScreen('wallet'); }, 1800);
  if (!DEMO_MODE) { try { await refreshBalances(); } catch(_) {} }
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
      // Demo: credit winnings directly — don't rely on MQTT round-trip
      if (DEMO_MODE && won) {
        const pot = payload.pot || 0;
        const playerCount = payload.playerCount || 1;
        const amountPer   = payload.amountPer   || 0;
        let payout = 0;
        if (payload.structure === 'winner-all') {
          payout = pot / playerCount;
        } else if (payload.structure === 'flip') {
          payout = Math.min(amountPer * 2, pot / playerCount);
        } else {
          payout = pot / playerCount;
        }
        if (payout > 0) {
          state.total   = (state.total || 0) + payout;
          state.pathUSD = state.total;
          try { localStorage.setItem('throw_demo_balance', state.total.toFixed(6)); } catch(_) {}
          renderWalletUI();
        }
      }
      state.bet.active = false;
      state.bet.joined = false;
      state.bet.joinedEscrow = null;
      clearPendingBetButton();
      setTimeout(() => refreshBalances(), 1000);
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
   18b. THROW-TO-ANYONE + CLAIM LINKS
   ═════════════════════════════════════════════════════════════════════ */

let _claimUi = { claimId: null, preview: null, lastCreated: null };

function setAnyoneStatus(msg) {
  const el = document.getElementById('throw-anyone-status');
  if (el) el.textContent = msg || '';
}

function openClaimShareModal(claim) {
  const modal = document.getElementById('claim-share-modal');
  if (!modal) return;
  document.getElementById('claim-share-amt').textContent = '$' + Number(claim.amount).toFixed(2);
  document.getElementById('claim-share-url').textContent = claim.url;
  const canvas = document.getElementById('claim-qr-canvas');
  if (canvas && typeof QRCode !== 'undefined') {
    QRCode.toCanvas(canvas, claim.url, { width: 200, margin: 1, color: { light: '#ffffff', dark: '#000000' } }, () => {});
  }
  modal.classList.remove('hidden');
  _claimUi.lastCreated = claim;
}

function closeClaimShareModal() {
  document.getElementById('claim-share-modal')?.classList.add('hidden');
}

async function executeThrowToAnyone() {
  if (!state.account?.address) { showToast('Wallet not ready'); return; }
  const amount = state.throwAmount || 5;
  if ((state.total || 0) < amount) { showToast('Not enough balance'); return; }
  const hint = (document.getElementById('throw-anyone-input')?.value || '').trim();
  const btn = document.getElementById('btn-throw-anyone');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  setAnyoneStatus('Locking cash in a claim pot…');
  try {
    moneyRain(8);
    showTxFlash('💸', '$' + amount, hint ? ('Throwing to ' + hint + '…') : 'Creating claim link…');
    const claim = await createOpenClaim({
      amount,
      fromAddr: state.account.address,
      fromName: getHandle() || state.account.address.slice(0, 6),
      toHint: hint || null,
      memo: 'THROW claim',
    });
    // Backup publish via API
    try {
      fetch('/api/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', ...claim.record }),
      }).catch(() => {});
    } catch(_) {}
    hideTxFlash();
    setAnyoneStatus('Link ready — share it. Money waits until they tap.');
    openClaimShareModal(claim);
    const shared = await shareClaimLink(claim);
    if (shared === 'copied') showToast('Claim link copied');
    else if (shared === 'shared') showToast('Shared — waiting for them to claim');
  } catch (e) {
    hideTxFlash();
    setAnyoneStatus('Failed: ' + (e.message || e));
    showToast('Claim failed: ' + (e.message || e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'LINK'; }
  }
}

async function openClaimScreen(claimId) {
  claimId = claimId || readPendingClaimId();
  if (!claimId) return false;
  stashPendingClaimId(claimId);
  _claimUi.claimId = claimId;
  showScreen('claim');
  const amtEl = document.getElementById('claim-amount');
  const fromEl = document.getElementById('claim-from');
  const status = document.getElementById('claim-status');
  const btn = document.getElementById('btn-claim-pocket');
  if (status) status.textContent = 'Finding your cash…';
  if (btn) btn.disabled = true;

  let preview = null;
  try {
    const res = await fetch('/api/claim?id=' + encodeURIComponent(claimId));
    if (res.ok) {
      const data = await res.json();
      preview = data.claim;
    }
  } catch(_) {}
  if (!preview) {
    try { preview = await fetchClaimRecord(claimId); } catch(_) {}
  }
  _claimUi.preview = preview;
  if (!preview) {
    if (amtEl) amtEl.textContent = '—';
    if (fromEl) fromEl.textContent = 'Claim not found or already pocketed';
    if (status) status.textContent = 'Ask them to throw again.';
    return true;
  }
  const amount = Number(preview.netAmount || preview.amount) || 0;
  if (amtEl) amtEl.textContent = '$' + amount.toFixed(2);
  if (fromEl) fromEl.textContent = (preview.fromName || 'Someone') + ' threw this at you';
  if (status) status.textContent = preview.toHint ? ('For: ' + preview.toHint) : 'Ready when you are';
  if (btn) {
    btn.disabled = false;
    btn.textContent = state.account ? 'Put in my pocket' : 'Create wallet & claim';
  }
  return true;
}

async function executeClaimPocket() {
  const claimId = _claimUi.claimId || readPendingClaimId();
  if (!claimId) return;
  const btn = document.getElementById('btn-claim-pocket');
  const status = document.getElementById('claim-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Claiming…'; }
  if (status) status.textContent = 'Moving cash into your pocket…';

  try {
    // Ensure wallet exists
    if (!state.account) {
      const acc = await generateWallet();
      await initWallet(acc, true);
      // initWallet navigates to wallet — come back
      showScreen('claim');
    }
    const result = await redeemOpenClaim(claimId, state.account.address);
    clearPendingClaimId();
    moneyRain(12);
    showTxFlash('🏆', '$' + Number(result.amount).toFixed(2), 'In your pocket');
    if (status) status.textContent = 'Done.';
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try { navigator.vibrate([30,40,50,40,80,40,100,30,150]); } catch(_) {}
    }
    setTimeout(() => {
      hideTxFlash();
      showScreen('wallet');
      try { refreshBalances(); } catch(_) {}
    }, 1600);
  } catch (e) {
    if (status) status.textContent = 'Failed: ' + (e.message || e);
    if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
    showToast('Claim failed: ' + (e.message || e));
  }
}

function wireClaimAndAnyoneUI() {
  const anyoneBtn = document.getElementById('btn-throw-anyone');
  if (anyoneBtn) anyoneBtn.onclick = () => executeThrowToAnyone();

  const pickBtn = document.getElementById('btn-pick-contact');
  if (pickBtn) pickBtn.onclick = async () => {
    setAnyoneStatus('Opening contacts…');
    const c = await pickDeviceContact();
    if (!c) {
      setAnyoneStatus('Contacts picker unavailable — type a phone or email');
      document.getElementById('throw-anyone-input')?.focus();
      return;
    }
    const hint = c.tel || c.email || c.name;
    const input = document.getElementById('throw-anyone-input');
    if (input) input.value = hint;
    setAnyoneStatus('Selected ' + (c.name || hint) + ' — tap LINK');
  };

  const qrBtn = document.getElementById('btn-claim-qr');
  if (qrBtn) qrBtn.onclick = async () => {
    if (_claimUi.lastCreated) openClaimShareModal(_claimUi.lastCreated);
    else await executeThrowToAnyone();
  };

  const nfcBtn = document.getElementById('btn-nfc-write');
  if (nfcBtn) {
    if (!('NDEFReader' in window)) nfcBtn.style.display = 'none';
    nfcBtn.onclick = async () => {
      try {
        let claim = _claimUi.lastCreated;
        if (!claim) {
          setAnyoneStatus('Creating claim for NFC…');
          claim = await createOpenClaim({
            amount: state.throwAmount || 5,
            fromAddr: state.account.address,
            fromName: getHandle() || state.account.address.slice(0, 6),
            toHint: 'NFC',
          });
          _claimUi.lastCreated = claim;
        }
        setAnyoneStatus('Hold phone to NFC tag…');
        await nfcWriteClaimUrl(claim.url);
        setAnyoneStatus('Wrote claim to tag');
        showToast('NFC tag ready');
      } catch (e) {
        setAnyoneStatus(e.message || 'NFC failed');
      }
    };
  }

  const pushBtn = document.getElementById('btn-enable-push');
  if (pushBtn) pushBtn.onclick = async () => {
    const res = await enableThrowPush();
    if (res.ok) {
      setAnyoneStatus('Notifications on — we can ping you when cash moves');
      showToast('Notifications enabled');
    } else {
      setAnyoneStatus('Notifications: ' + (res.reason || 'unavailable'));
    }
  };

  document.getElementById('btn-claim-share-now')?.addEventListener('click', async () => {
    if (_claimUi.lastCreated) await shareClaimLink(_claimUi.lastCreated);
  });
  document.getElementById('btn-claim-share-copy')?.addEventListener('click', async () => {
    if (!_claimUi.lastCreated) return;
    try {
      await navigator.clipboard.writeText(_claimUi.lastCreated.url);
      showToast('Copied');
    } catch(_) {}
  });
  document.getElementById('btn-claim-share-close')?.addEventListener('click', closeClaimShareModal);

  document.getElementById('btn-claim-pocket')?.addEventListener('click', () => executeClaimPocket());
  document.getElementById('btn-claim-later')?.addEventListener('click', () => {
    showScreen(state.account ? 'wallet' : 'splash');
  });

  // Handle claim_claimed notifications on credit topic
  // (subscribeDemoCredits already listens — extend via message hook below if needed)
}

async function maybeOpenClaimAfterWallet() {
  const id = readPendingClaimId();
  if (!id) return false;
  return openClaimScreen(id);
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
  nameEl.value = ''; // clear so user can't accidentally tap again

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

  // If address already in contacts — go straight to their card
  const existing = getContacts().find(c => c.addr.toLowerCase() === addr.toLowerCase());
  if (existing) {
    status.textContent = '✅ Already in your crew!';
    setTimeout(() => {
      showScreen('wallet');
      openContactOverlay(existing);
    }, 800);
    return;
  }

  // New contact — ask for a name then add
  const name = (prompt('What is their name? (up to 6 chars)') || '').trim();
  if (!name) { status.textContent = 'Scan cancelled.'; return; }
  upsertContact(name, addr);

  // Ping the scanned address so THEIR device auto-adds us back
  const myAddr = state.account?.address;
  const myName = (getHandle() || myAddr?.slice(0,6) || '').toUpperCase().slice(0,6);
  if (myAddr) _notifyContactAdded(addr, myAddr, myName);

  status.textContent = '✅ Docked with ' + name.toUpperCase().slice(0,6) + '!';
  setTimeout(() => {
    showScreen('wallet');
    const newContact = getContacts().find(c => c.addr.toLowerCase() === addr.toLowerCase());
    if (newContact) openContactOverlay(newContact);
  }, 1000);
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

let _fundPollTimer = null;
let _fundArrivalToasted = false;

function stopFundBalancePoll() {
  if (_fundPollTimer) { clearInterval(_fundPollTimer); _fundPollTimer = null; }
}

function fundChipText(total, cap) {
  const t = Number(total) || 0;
  const c = Number(cap) || CAP_USD;
  const room = Math.max(0, c - t);
  if (t < 0.01) return 'Empty pocket — load up to $' + c;
  if (t >= 1) return 'Loaded $' + t.toFixed(2) + ' — ready to throw';
  return 'On you now: $' + t.toFixed(2) + ' · room for $' + room.toFixed(2);
}

function buildReceiveShareUrl(origin, name, addr) {
  return String(origin || '') + '/?addName=' + encodeURIComponent(name || '') +
    '&addAddr=' + encodeURIComponent(addr || '');
}

function updateFundBalanceChip() {
  const chip = document.getElementById('fund-balance-chip');
  if (!chip) return;
  chip.textContent = fundChipText(state.total, CAP_USD);
  const done = document.getElementById('btn-fund-done');
  if (done) done.classList.toggle('hidden', (state.total || 0) < 1);
}

function openAddCashScreen() {
  showScreen('qr');
  _fundArrivalToasted = false;
  const addr = state.account?.address || '';
  renderQR(addr);
  const pk = _storedPK || localStorage.getItem('throw_pk') || 'Not found';
  const pkEl = document.getElementById('backup-key-display');
  if (pkEl) pkEl.textContent = pk;
  updateFundBalanceChip();
  // Poll while funding so Tempo → THROW deposits show up without manual refresh
  stopFundBalancePoll();
  _fundPollTimer = setInterval(async () => {
    if (currentScreen !== 'qr') { stopFundBalancePoll(); return; }
    try {
      if (!DEMO_MODE) await refreshBalances();
      updateFundBalanceChip();
      if ((state.total || 0) >= 1 && !_fundArrivalToasted) {
        _fundArrivalToasted = true;
        showToast('Cash landed — $' + state.total.toFixed(2) + ' ready');
        if (typeof navigator !== 'undefined' && navigator.vibrate) {
          try { navigator.vibrate([40, 40, 80]); } catch(_) {}
        }
      }
    } catch(_) {}
  }, 4000);
}

async function shareReceiveLink() {
  const addr = state.account?.address;
  if (!addr) return;
  const name = getHandle() || addr.slice(0, 6);
  const url = buildReceiveShareUrl(location.origin, name, addr);
  const text = 'Throw me cash on THROW — I\'m ' + name + '. ' + url;
  if (navigator.share) {
    try { await navigator.share({ title: 'Throw me cash', text, url }); return; } catch(e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast('Receive link copied');
  } catch(_) {
    showToast(addr);
  }
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

  // Claim deep link /c/ID or ?claim= — stash before routing so catch works after wallet create
  try {
    const earlyClaim = parseClaimIdFromLocation();
    if (earlyClaim) stashPendingClaimId(earlyClaim);
  } catch(_) {}

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
  const rainBtn = document.getElementById('btn-make-it-rain');
  if (rainBtn) rainBtn.onclick = () => executeMakeItRain();
  document.getElementById('btn-qr-receive').onclick = () => openAddCashScreen();
  document.getElementById('btn-load-cash').onclick  = () => openAddCashScreen();
  const _loadTonight = document.getElementById('btn-load-tonight');
  if (_loadTonight) _loadTonight.onclick = () => openAddCashScreen();

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

  document.getElementById('btn-pwa-refresh').onclick = () => {
    const btn = document.getElementById('btn-pwa-refresh');
    btn.style.opacity = '1';
    btn.style.transition = 'transform 0.6s ease';
    btn.style.transform = 'rotate(360deg)';
    setTimeout(() => { window.location.reload(true); }, 400);
  };

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
  try { wireClaimAndAnyoneUI(); } catch(e) { console.warn('claim UI wire failed', e); }

  /* ── Bet setup screen ── */
  document.getElementById('bet-setup-back').onclick = () => showScreen('wallet');
  document.getElementById('btn-start-pot').onclick  = startPot;

  // Poker wiring
  const pokerBack = document.getElementById('poker-setup-back');
  if (pokerBack) pokerBack.onclick = () => { try { leavePokerRoom(); } catch(_) {} showScreen('bet-setup'); };
  const pokerTableBack = document.getElementById('poker-table-back');
  if (pokerTableBack) pokerTableBack.onclick = () => {
    if (confirm('Leave the table?')) {
      try { leavePokerRoom(); } catch(_) {}
      showScreen('wallet');
    }
  };
  const pokerStart = document.getElementById('btn-poker-start');
  if (pokerStart) pokerStart.onclick = () => {
    startPokerGame(state.poker?.seats || [], state.poker?.roomCode).catch(e => {
      console.error('startPokerGame failed', e);
      alert('Could not start: ' + (e.message || e));
      pokerStart.disabled = false;
      pokerStart.textContent = 'Start Game';
    });
  };
  const pokerAdv = document.getElementById('btn-poker-advance');
  if (pokerAdv) pokerAdv.onclick = onPokerAdvanceClick;
  const pokerPayout = document.getElementById('btn-poker-payout');
  if (pokerPayout) pokerPayout.onclick = onPokerPayoutClick;
  const pokerJoinSelf = document.getElementById('poker-join-self');
  if (pokerJoinSelf) pokerJoinSelf.onchange = () => renderPokerSetup();
  loadPokerTablePrefs();
  const voiceToggle = document.getElementById('btn-poker-voice-toggle');
  if (voiceToggle) voiceToggle.onclick = () => {
    _pokerVoiceOn = !_pokerVoiceOn;
    applyPokerTableMode();
    if (_pokerVoiceOn) pokerSpeak('Voice on');
  };
  const centerToggle = document.getElementById('btn-poker-center-toggle');
  if (centerToggle) centerToggle.onclick = () => {
    _pokerTableCenter = !_pokerTableCenter;
    applyPokerTableMode();
  };
  const vSetup = document.getElementById('poker-table-voice');
  const cSetup = document.getElementById('poker-table-center');
  if (vSetup) vSetup.onchange = () => { _pokerVoiceOn = !!vSetup.checked; applyPokerTableMode(); };
  if (cSetup) cSetup.onchange = () => { _pokerTableCenter = !!cSetup.checked; applyPokerTableMode(); };

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

  /* ── QR / Load for tonight screen ── */
  const qrBack = document.getElementById('qr-back');
  if (qrBack) qrBack.onclick = () => {
    stopFundBalancePoll();
    showScreen('wallet');
  };

  const copyAddrBtn = document.getElementById('btn-copy-addr');
  if (copyAddrBtn) copyAddrBtn.onclick = () => {
    if (!state.account) return;
    navigator.clipboard?.writeText(state.account.address);
    copyAddrBtn.textContent = '✓ Address copied';
    const toast = document.getElementById('fund-copied-toast');
    if (toast) toast.classList.remove('hidden');
    setTimeout(() => { copyAddrBtn.textContent = 'Copy my address'; }, 2000);
  };

  const openTempo = document.getElementById('btn-open-tempo');
  if (openTempo) openTempo.onclick = () => {
    // Tempo Wallet: fiat onramp + bridge, then user sends to THROW address
    window.open('https://wallet.tempo.xyz', '_blank', 'noopener');
  };

  const shareRecv = document.getElementById('btn-share-receive');
  if (shareRecv) shareRecv.onclick = () => shareReceiveLink();

  const fundDemo = document.getElementById('btn-fund-demo');
  if (fundDemo) fundDemo.onclick = () => {
    setDemoMode(true);
    updateFundBalanceChip();
    showToast('Demo $50 loaded — throw like cash');
    setTimeout(() => { stopFundBalancePoll(); showScreen('wallet'); }, 600);
  };

  const fundDone = document.getElementById('btn-fund-done');
  if (fundDone) fundDone.onclick = () => {
    stopFundBalancePoll();
    showScreen('wallet');
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
      resolveActiveSponsor().then(sponsor => {
        if (sponsor) setSponsor(sponsor);
      }).catch(() => {});
      // Get cached sponsor — if empty, wait up to 1.5s for MQTT retained message
      let _cachedSponsor = (() => {
        try { return JSON.parse(localStorage.getItem('throw_active_sponsor') || 'null'); } catch(_) { return null; }
      })();
      _allSponsors = (() => {
        try { return JSON.parse(localStorage.getItem('throw_all_sponsors') || '[]'); } catch(_) { return []; }
      })();
      if (!_cachedSponsor?.name) {
        // Poll for up to 3s for MQTT retained message to arrive
        await new Promise(resolve => {
          const start = Date.now();
          const poll = setInterval(() => {
            if (_activeSponsor?.name || Date.now() - start > 3000) {
              clearInterval(poll);
              resolve();
            }
          }, 100);
        });
        _cachedSponsor = _activeSponsor || (() => {
          try { return JSON.parse(localStorage.getItem('throw_active_sponsor') || 'null'); } catch(_) { return null; }
        })();
      }
      // Show splash on every session open (not just cold cache)
      const splashShownThisSession = sessionStorage.getItem('throw_splash_shown');
      if (_cachedSponsor?.name && !splashShownThisSession) {
        sessionStorage.setItem('throw_splash_shown', '1');
        setSponsor(_cachedSponsor);
        clearTimeout(_bootKillTimer);
        hideBootLoader();
        await showSponsorSplash(_cachedSponsor);
      }
      await initWallet(saved);
      try {
        if (await maybeOpenClaimAfterWallet()) return;
      } catch(e) { console.warn('claim open failed', e); }
      return;
    }

    // No wallet yet — if claim link, show claim screen (wallet created on pocket tap)
    const pendingClaim = readPendingClaimId();
    if (pendingClaim) {
      hideBootLoader();
      try { await openClaimScreen(pendingClaim); return; } catch(_) {}
    }
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


/* ═══════════════════════════════════════════════════════════════════════
   22. TEXAS HOLD'EM POKER ENGINE
   Real cards at the table · phone bets · shared escrow pot · make-it-rain energy
   ═════════════════════════════════════════════════════════════════════ */

const POKER_STARTING_STACK = 50;
const POKER_SB = 1;
const POKER_BB = 2;
const POKER_MAX_SEATS = 6;

let _pokerSelectedWinnerAddr = null;
let _pokerSeenActionKeys = new Set();

function pokerTopic(roomCode) {
  return 'throw5/room/' + roomCode + '/poker';
}

function pokerHaptic() {
  try { if (navigator.vibrate) navigator.vibrate([30,40,50,40,80,40,100,30,150,20,200]); } catch(_) {}
}

/* ── Table voice + center-of-table display ──
   Real cards stay physical. This phone is the glowing pot in the middle
   that calls blinds, turns, and actions out loud. */
let _pokerVoiceOn = true;
let _pokerTableCenter = true;
let _pokerSpeakChain = Promise.resolve();

function pokerSeatName(seat) {
  if (!seat) return 'Player';
  const n = (seat.name || '').trim();
  if (!n || n.toUpperCase() === 'YOU') {
    // Prefer a friendlier call if it's local
    try {
      const h = typeof getHandle === 'function' ? getHandle() : '';
      if (h) return h;
    } catch(_) {}
  }
  return n || (seat.addr ? seat.addr.slice(2, 6).toUpperCase() : 'Player');
}

function setPokerAnnounce(line, speak) {
  const el = document.getElementById('poker-announce-line');
  if (el) {
    el.textContent = line || '';
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 700);
  }
  if (speak) pokerSpeak(line);
}

function pokerSpeak(text) {
  if (!_pokerVoiceOn || !text) return;
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  // Only the table phone (host / center mode) talks — avoids a chorus
  const p = state.poker;
  if (p && !p.isHost && !_pokerTableCenter) return;

  _pokerSpeakChain = _pokerSpeakChain.then(() => new Promise(resolve => {
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      u.rate = 1.02;
      u.pitch = 1;
      u.volume = 1;
      // Prefer a clear English voice when available
      try {
        const voices = window.speechSynthesis.getVoices() || [];
        const en = voices.find(v => /en[-_]US/i.test(v.lang) && /Google|Samantha|Daniel|Alex/i.test(v.name))
          || voices.find(v => /^en/i.test(v.lang));
        if (en) u.voice = en;
      } catch(_) {}
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
      // Safety resolve if engine stalls
      setTimeout(resolve, Math.min(8000, 900 + String(text).length * 60));
    } catch(_) { resolve(); }
  }));
}

function applyPokerTableMode() {
  const screen = document.getElementById('screen-poker-table');
  if (screen) screen.classList.toggle('table-center', !!_pokerTableCenter);
  const vBtn = document.getElementById('btn-poker-voice-toggle');
  const cBtn = document.getElementById('btn-poker-center-toggle');
  if (vBtn) {
    vBtn.classList.toggle('on', !!_pokerVoiceOn);
    vBtn.textContent = _pokerVoiceOn ? '🔊 Voice' : '🔇 Voice';
  }
  if (cBtn) {
    cBtn.classList.toggle('on', !!_pokerTableCenter);
    cBtn.textContent = _pokerTableCenter ? '✦ Table' : '○ Table';
  }
  try {
    localStorage.setItem('throw_poker_voice', _pokerVoiceOn ? '1' : '0');
    localStorage.setItem('throw_poker_center', _pokerTableCenter ? '1' : '0');
  } catch(_) {}
}

function loadPokerTablePrefs() {
  try {
    const v = localStorage.getItem('throw_poker_voice');
    const c = localStorage.getItem('throw_poker_center');
    if (v != null) _pokerVoiceOn = v === '1';
    if (c != null) _pokerTableCenter = c === '1';
  } catch(_) {}
  const vSetup = document.getElementById('poker-table-voice');
  const cSetup = document.getElementById('poker-table-center');
  if (vSetup) vSetup.checked = _pokerVoiceOn;
  if (cSetup) cSetup.checked = _pokerTableCenter;
}

function announcePokerTurn(seat, currentBet) {
  const name = pokerSeatName(seat);
  const callAmt = Math.max(0, (currentBet || 0) - (seat.bet || 0));
  let line;
  if (callAmt <= 0) line = name + ', your action — check or bet';
  else line = name + ', your bet — ' + callAmt + ' to call';
  setPokerAnnounce(line, true);
}

function announcePokerAction(data, seat) {
  const name = pokerSeatName(seat);
  const a = data.action;
  let line = name + ' ';
  if (a === 'fold') line += 'folds';
  else if (a === 'check') line += 'checks';
  else if (a === 'call') line += 'calls' + (data.amount ? (' ' + data.amount) : '');
  else if (a === 'raise') line += 'raises to ' + (seat?.bet || data.amount || '');
  else line += a;
  setPokerAnnounce(line, true);
}

function announcePokerStreet(street, pot) {
  const label = (street || '').toUpperCase();
  let line = label;
  if (street === 'flop') line = 'Flop. Pot is ' + pot;
  else if (street === 'turn') line = 'Turn. Pot is ' + pot;
  else if (street === 'river') line = 'River. Pot is ' + pot;
  else if (street === 'showdown') line = 'Showdown. Pot is ' + pot + '. Host picks the winner.';
  else if (street === 'preflop') line = 'Preflop. Pot is ' + pot;
  setPokerAnnounce(line, true);
}

function announcePokerBlinds(seats, sbIdx, bbIdx, sbAmt, bbAmt) {
  const sb = seats[sbIdx];
  const bb = seats[bbIdx];
  const parts = [];
  if (sb) parts.push(pokerSeatName(sb) + ', small blind ' + sbAmt);
  if (bb && bbIdx !== sbIdx) parts.push(pokerSeatName(bb) + ', big blind ' + bbAmt);
  const line = parts.join('. ') + '. Real cards — deal them out.';
  setPokerAnnounce(line, true);
}


function isMyPokerTurn() {
  const p = state.poker;
  if (!p || !p.seats || !p.seats.length) return false;
  const seat = p.seats[p.currentSeat];
  if (!seat || !p.myAddr) return false;
  return seat.addr.toLowerCase() === p.myAddr.toLowerCase();
}

function _pokerActionKey(data) {
  return [data.event, data.seatIdx, data.action, data.amount, data.ts].join('|');
}

async function openPokerSetup() {
  const myAddr = state.account?.address;
  if (!myAddr) { alert('Wallet not ready'); return; }

  // Create a fresh escrow wallet for the pot — same model as regular bets.
  // Without this, live blinds/calls/raises have nowhere to land.
  let roomCode;
  try {
    if (!DEMO_MODE) {
      const { ethers } = await getViem();
      const escrowWallet = ethers.Wallet.createRandom();
      Object.assign(state.bet, {
        active: true,
        isHost: true,
        description: "Texas Hold'em",
        structure: 'texas-holdem',
        escrowKey: escrowWallet.privateKey,
        escrowAddr: escrowWallet.address,
        hostAddr: myAddr,
        amountPer: POKER_STARTING_STACK,
        players: [],
        total: 0,
      });
      roomCode = escrowWallet.address.slice(2, 8).toUpperCase();
      try {
        localStorage.setItem('throw_active_bet', JSON.stringify({
          active: true,
          isHost: true,
          description: "Texas Hold'em",
          structure: 'texas-holdem',
          escrowKey: escrowWallet.privateKey,
          escrowAddr: escrowWallet.address,
          hostAddr: myAddr,
          roomCode,
          amountPer: POKER_STARTING_STACK,
          players: [],
          total: 0,
        }));
      } catch(_) {}
    } else {
      // Demo still needs a stable room code + placeholder escrow addr for invites
      roomCode = Math.random().toString(16).slice(2, 8).toUpperCase();
      Object.assign(state.bet, {
        active: true,
        isHost: true,
        description: "Texas Hold'em",
        structure: 'texas-holdem',
        escrowKey: null,
        escrowAddr: '0xDEMO' + roomCode.toLowerCase().padEnd(40, '0'),
        hostAddr: myAddr,
        amountPer: POKER_STARTING_STACK,
        players: [],
        total: 0,
      });
    }
  } catch (e) {
    alert('Could not open table: ' + (e.message || e));
    return;
  }

  state.bet.roomCode = roomCode;
  _pokerSeenActionKeys = new Set();
  _pokerSelectedWinnerAddr = null;

  state.poker = {
    seats: [],
    pot: 0,
    street: 'preflop',
    currentSeat: 0,
    dealerIdx: 0,
    sbIdx: 1,
    bbIdx: 2,
    roomCode,
    isHost: true,
    myAddr,
    structure: 'texas-holdem',
    demo: !!DEMO_MODE,
    currentBet: POKER_BB,
    lastRaiser: null,
    escrowAddr: state.bet.escrowAddr,
  };

  showScreen('poker-setup');
  loadPokerTablePrefs();
  renderPokerSetup();
  enterRoom(roomCode, {}).catch(() => {});
  _subscribePokerTopic(roomCode);
  // Warm TTS voices (Chrome loads them async)
  try { window.speechSynthesis && window.speechSynthesis.getVoices(); } catch(_) {}
}

function renderPokerSetup() {
  const p = state.poker;
  if (!p) return;
  const orbit = document.getElementById('poker-setup-orbit');
  const crewRow = document.getElementById('poker-crew-row');
  const startBtn = document.getElementById('btn-poker-start');
  if (!orbit || !crewRow) return;

  const totalSlots = POKER_MAX_SEATS;
  const radius = 110;
  orbit.innerHTML = '';
  for (let i = 0; i < totalSlots; i++) {
    const angle = (i / totalSlots) * 2 * Math.PI - Math.PI / 2;
    const x = 50 + (radius / 2.2) * Math.cos(angle);
    const y = 50 + (radius / 2.2) * Math.sin(angle);
    const seat = p.seats[i];
    const el = document.createElement('div');
    el.className = 'poker-seat';
    el.style.cssText = `position:absolute;left:${x}%;top:${y}%;transform:translate(-50%,-50%);width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;text-align:center;`;
    if (seat) {
      el.style.background = addrToColor(seat.addr);
      el.style.color = '#fff';
      el.innerHTML = seat.name.slice(0,2);
      const role = i === 0 ? 'D' : (p.seats.length === 2
        ? (i === 0 ? 'D/SB' : 'BB')
        : (i === 1 ? 'SB' : i === 2 ? 'BB' : ''));
      // Preview badges: heads-up dealer is SB
      let badgeRole = '';
      if (p.seats.length === 2) {
        badgeRole = i === 0 ? 'SB' : (i === 1 ? 'BB' : '');
        if (i === 0) badgeRole = 'D'; // show dealer; SB posts from dealer in HU at start
      } else {
        badgeRole = i === 0 ? 'D' : i === 1 ? 'SB' : i === 2 ? 'BB' : '';
      }
      if (badgeRole) {
        const badge = document.createElement('div');
        badge.className = badgeRole === 'D' ? 'dealer-badge' : badgeRole === 'SB' ? 'sb-badge' : 'bb-badge';
        badge.textContent = badgeRole;
        el.appendChild(badge);
      }
      el.onclick = () => {
        p.seats.splice(i, 1);
        renderPokerSetup();
      };
    } else {
      el.style.border = '2px dashed rgba(255,255,255,0.35)';
      el.style.color  = 'rgba(255,255,255,0.5)';
      el.innerHTML = '+';
    }
    orbit.appendChild(el);
  }

  const contacts = getContacts();
  const joinSelf = document.getElementById('poker-join-self')?.checked;
  const selfAddr = state.account?.address;
  const selfName = 'YOU';
  const assigned = new Set(p.seats.map(s => s.addr.toLowerCase()));
  const avail = [];
  if (joinSelf && selfAddr && !assigned.has(selfAddr.toLowerCase())) {
    avail.push({ addr: selfAddr, name: selfName, isSelf: true });
  }
  for (const c of contacts) {
    if (!assigned.has(c.addr.toLowerCase())) avail.push(c);
  }
  crewRow.innerHTML = avail.map(c => {
    const color = addrToColor(c.addr);
    const initials = (c.name || c.addr.slice(2,4)).slice(0,2).toUpperCase();
    return `<button class="crew-avatar" data-addr="${c.addr}" data-name="${c.name || c.addr.slice(0,6)}" style="background:${color};width:48px;height:48px;border-radius:50%;border:none;color:#fff;font-weight:700">${initials}</button>`;
  }).join('');
  crewRow.querySelectorAll('.crew-avatar').forEach(btn => {
    btn.onclick = () => {
      if (p.seats.length >= POKER_MAX_SEATS) return;
      p.seats.push({
        addr: btn.dataset.addr,
        name: btn.dataset.name,
        role: 'player',
        stack: POKER_STARTING_STACK,
        bet: 0,
        folded: false,
      });
      renderPokerSetup();
    };
  });

  if (startBtn) startBtn.disabled = p.seats.length < 2;
}

function _assignPokerBlindIndexes(seatCount) {
  // Standard: dealer=0. Multiway SB=1 BB=2.
  // Heads-up: dealer posts SB, other posts BB.
  if (seatCount === 2) {
    return { dealerIdx: 0, sbIdx: 0, bbIdx: 1 };
  }
  return {
    dealerIdx: 0,
    sbIdx: seatCount >= 2 ? 1 : 0,
    bbIdx: seatCount >= 3 ? 2 : 1,
  };
}

function _invitePokerPlayers(seats, roomCode) {
  const myAddr = state.account?.address || '';
  const hostName = (() => {
    try { return localStorage.getItem('throw_my_name') || getHandle() || myAddr.slice(0, 6); }
    catch(_) { return myAddr.slice(0, 6); }
  })();
  for (const seat of seats) {
    if (!seat?.addr) continue;
    if (seat.addr.toLowerCase() === myAddr.toLowerCase()) continue;
    const payload = JSON.stringify({
      event: 'poker_invite',
      to: seat.addr,
      roomCode,
      escrowAddr: state.bet.escrowAddr || null,
      hostAddr: myAddr,
      hostName,
      seats: seats.map(s => ({ addr: s.addr, name: s.name })),
      blinds: { sb: POKER_SB, bb: POKER_BB },
      stack: POKER_STARTING_STACK,
      demo: !!DEMO_MODE,
      ts: Date.now(),
    });
    try {
      const topic = 'throw5/wallet/' + seat.addr.toLowerCase() + '/credit';
      const clientId = 'poker_inv_' + Math.random().toString(36).slice(2, 8);
      const c = mqtt.connect(MQTT_BROKER, { clientId, clean: true, connectTimeout: 6000, reconnectPeriod: 0 });
      c.on('connect', () => {
        c.publish(topic, payload, { qos: 1 }, () => { try { c.end(true); } catch(_) {} });
      });
      c.on('error', () => { try { c.end(true); } catch(_) {} });
    } catch(_) {}
  }
}

function acceptPokerInvite(data) {
  if (!data?.roomCode) return;
  // Don't clobber an active host table
  if (state.poker?.isHost && state.poker?.street && state.poker.street !== 'settled') return;
  if (state.poker?.roomCode === data.roomCode && !state.poker?.isHost) {
    _subscribePokerTopic(data.roomCode);
    return;
  }

  state.poker = {
    seats: (data.seats || []).map(s => ({
      addr: s.addr,
      name: s.name,
      role: 'player',
      stack: POKER_STARTING_STACK,
      bet: 0,
      folded: false,
      acted: false,
    })),
    pot: 0,
    street: 'waiting',
    currentSeat: 0,
    dealerIdx: 0,
    sbIdx: 1,
    bbIdx: 2,
    roomCode: data.roomCode,
    escrowAddr: data.escrowAddr || null,
    isHost: false,
    myAddr: state.account?.address,
    structure: 'texas-holdem',
    demo: !!DEMO_MODE,
    currentBet: POKER_BB,
    lastRaiser: null,
  };
  Object.assign(state.bet, {
    active: true,
    isHost: false,
    structure: 'texas-holdem',
    description: "Texas Hold'em",
    escrowAddr: data.escrowAddr || null,
    hostAddr: data.hostAddr || null,
    roomCode: data.roomCode,
  });

  _subscribePokerTopic(data.roomCode);
  enterRoom(data.roomCode, {}).catch(() => {});
  showToast((data.hostName || 'Host') + ' seated you at Texas Hold\'em');
  showTxFlash('🃏', '$1/$2', 'Joining table…');
  setTimeout(() => hideTxFlash(), 2000);
}

async function startPokerGame(seats, roomCode) {
  const p = state.poker;
  if (!p || !p.isHost) return;
  if (!seats || seats.length < 2) return;

  const startBtn = document.getElementById('btn-poker-start');
  if (startBtn) {
    startBtn.disabled = true;
    startBtn.textContent = 'Seating crew…';
  }

  // Ensure escrow exists (openPokerSetup should have created it)
  if (!DEMO_MODE && !state.bet.escrowAddr) {
    try {
      const { ethers } = await getViem();
      const w = ethers.Wallet.createRandom();
      state.bet.escrowKey = w.privateKey;
      state.bet.escrowAddr = w.address;
      p.escrowAddr = w.address;
    } catch (e) {
      alert('Could not create pot wallet: ' + (e.message || e));
      if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Start Game'; }
      return;
    }
  }
  p.escrowAddr = state.bet.escrowAddr || p.escrowAddr;
  p.roomCode = roomCode || p.roomCode || state.bet.roomCode;

  // Ping seated phones so they subscribe before poker_start
  _invitePokerPlayers(seats, p.roomCode);
  await new Promise(r => setTimeout(r, 1200));

  const idxs = _assignPokerBlindIndexes(seats.length);
  p.dealerIdx = idxs.dealerIdx;
  p.sbIdx = idxs.sbIdx;
  p.bbIdx = idxs.bbIdx;

  seats.forEach((s, i) => {
    s.role = i === p.dealerIdx ? 'dealer' : i === p.sbIdx ? 'sb' : i === p.bbIdx ? 'bb' : 'player';
    if (seats.length === 2 && i === p.dealerIdx) s.role = 'dealer'; // HU dealer is also SB
    s.bet = 0;
    s.folded = false;
    s.acted = false;
    s.stack = s.stack || POKER_STARTING_STACK;
  });

  const sb = seats[p.sbIdx];
  const bb = seats[p.bbIdx];
  const sbAmt = Math.min(POKER_SB, sb.stack);
  const bbAmt = Math.min(POKER_BB, bb.stack);
  sb.stack -= sbAmt; sb.bet = sbAmt;
  bb.stack -= bbAmt; bb.bet = bbAmt;
  // HU: dealer is SB — if same seat somehow, don't double-post
  if (p.sbIdx === p.bbIdx) {
    // shouldn't happen with _assignPokerBlindIndexes
  }
  p.pot = sbAmt + bbAmt;
  p.currentBet = bbAmt;
  p.street = 'preflop';
  // First action: UTG (seat after BB). Heads-up: SB/dealer acts first preflop.
  p.currentSeat = seats.length === 2 ? p.sbIdx : ((p.bbIdx + 1) % seats.length);
  // Blinds are not aggression — leave lastRaiser null so BB keeps the option
  p.lastRaiser = null;

  // Post blinds — demo already deducted from stacks above for table math;
  // also debit real/demo wallet for seats that are ME.
  const myLc = (p.myAddr || '').toLowerCase();
  const postMine = async (seat, amt) => {
    if (!amt || seat.addr.toLowerCase() !== myLc) return;
    if (DEMO_MODE) {
      state.total = Math.max(0, state.total - amt);
      state.pathUSD = state.total;
      try { localStorage.setItem('throw_demo_balance', state.total.toFixed(6)); } catch(_) {}
      renderWalletUI();
    } else if (p.escrowAddr) {
      try { await sendEscrowDeposit(p.escrowAddr, amt); }
      catch (e) { console.error('poker blind escrow failed', e); }
    }
  };
  await postMine(sb, sbAmt);
  if (p.sbIdx !== p.bbIdx) await postMine(bb, bbAmt);

  _publishPoker({
    event: 'poker_start',
    seats: p.seats,
    pot: p.pot,
    street: p.street,
    currentSeat: p.currentSeat,
    dealerIdx: p.dealerIdx,
    sbIdx: p.sbIdx,
    bbIdx: p.bbIdx,
    currentBet: p.currentBet,
    lastRaiser: p.lastRaiser,
    roomCode: p.roomCode,
    escrowAddr: p.escrowAddr || state.bet.escrowAddr || null,
    ts: Date.now(),
  });

  // Table prefs from setup checkboxes
  const vSetup = document.getElementById('poker-table-voice');
  const cSetup = document.getElementById('poker-table-center');
  if (vSetup) _pokerVoiceOn = !!vSetup.checked;
  if (cSetup) _pokerTableCenter = !!cSetup.checked;

  if (startBtn) startBtn.textContent = 'Start Game';
  showScreen('poker-table');
  applyPokerTableMode();
  announcePokerBlinds(seats, p.sbIdx, p.bbIdx, sbAmt, bbAmt);
  renderPokerTable();
  // Slight delay so blinds finish speaking before first turn call
  setTimeout(() => pokerNextTurn(), _pokerVoiceOn ? 2200 : 200);
}

function pokerNextTurn() {
  const p = state.poker;
  if (!p || !p.isHost) return;
  const seat = p.seats[p.currentSeat];
  if (!seat) return;
  _publishPoker({
    event: 'poker_turn',
    seatIdx: p.currentSeat,
    addr: seat.addr,
    currentBet: p.currentBet,
    pot: p.pot,
    ts: Date.now(),
  });
  announcePokerTurn(seat, p.currentBet);
  renderPokerTable();
}

function pokerHandleAction(action, amount) {
  const p = state.poker;
  if (!p) return;
  if (!isMyPokerTurn()) return;
  const seat = p.seats[p.currentSeat];
  const callAmt = Math.max(0, p.currentBet - seat.bet);
  let add = 0;
  let newStack = seat.stack;

  if (action === 'fold') {
    // no money moves
  } else if (action === 'check') {
    if (callAmt > 0) return;
  } else if (action === 'call') {
    add = Math.min(callAmt, seat.stack);
    newStack = seat.stack - add;
  } else if (action === 'raise') {
    // amount = raise-TO total
    const raiseTo = Math.max(p.currentBet + 1, amount || p.currentBet + 1);
    const total = Math.min(raiseTo - seat.bet, seat.stack);
    if (total <= 0) return;
    add = total;
    newStack = seat.stack - add;
  } else if (action === 'allin') {
    add = seat.stack;
    newStack = 0;
  }

  if (add > 0) {
    if (DEMO_MODE) {
      state.total = Math.max(0, state.total - add);
      state.pathUSD = state.total;
      try { localStorage.setItem('throw_demo_balance', state.total.toFixed(6)); } catch(_) {}
      renderWalletUI();
    } else {
      const escrow = p.escrowAddr || state.bet?.escrowAddr;
      if (!escrow) {
        alert('Pot wallet not set up — cannot send live funds. Return to lobby.');
        return;
      }
      sendEscrowDeposit(escrow, add).catch(e => console.error('poker escrow send failed', e));
    }
  }

  const outAction = (action === 'allin')
    ? ((callAmt > 0 && add <= callAmt) ? 'call' : 'raise')
    : action;

  _publishPoker({
    event: 'poker_action',
    addr: p.myAddr,
    seatIdx: p.currentSeat,
    action: outAction,
    amount: add,
    newStack,
    ts: Date.now(),
  });
}

function _applyAction(data) {
  const p = state.poker;
  if (!p) return;
  const seat = p.seats[data.seatIdx];
  if (!seat) return;
  seat.acted = true;
  if (data.action === 'fold') {
    seat.folded = true;
  } else if (data.action === 'check') {
    // no money move
  } else if (data.action === 'call') {
    seat.bet += data.amount;
    seat.stack = data.newStack;
    p.pot += data.amount;
  } else if (data.action === 'raise') {
    seat.bet += data.amount;
    seat.stack = data.newStack;
    p.pot += data.amount;
    if (seat.bet > p.currentBet) p.currentBet = seat.bet;
    p.lastRaiser = data.seatIdx;
    p.seats.forEach((s, i) => {
      if (i !== data.seatIdx && !s.folded) s.acted = false;
    });
  }

  // Host table phone calls the action out loud
  if (p.isHost) announcePokerAction(data, seat);

  if (p.isHost) {
    const active = p.seats.filter(s => !s.folded);
    if (active.length <= 1) {
      const winner = active[0];
      if (winner) pokerSettle(winner.addr);
      return;
    }

    let next = (p.currentSeat + 1) % p.seats.length;
    let safety = 0;
    while (p.seats[next].folded && safety < p.seats.length) {
      next = (next + 1) % p.seats.length;
      safety++;
    }
    p.currentSeat = next;

    // Street ends when every active player has matched the bet AND acted since last raise
    const everyoneMatched = active.every(s => s.bet === p.currentBet || s.stack === 0);
    const everyoneActed = active.every(s => s.acted);
    if (everyoneMatched && everyoneActed) {
      const nextStreet = p.street === 'preflop' ? 'flop'
        : p.street === 'flop' ? 'turn'
        : p.street === 'turn' ? 'river'
        : 'showdown';
      pokerAdvanceStreet(nextStreet);
      return;
    }
    pokerNextTurn();
  } else {
    renderPokerTable();
  }
}

function pokerAdvanceStreet(street) {
  const p = state.poker;
  if (!p || !p.isHost) return;
  p.seats.forEach(s => { s.bet = 0; s.acted = false; });
  p.currentBet = 0;
  p.street = street;
  p.lastRaiser = null;
  if (street !== 'showdown') {
    // First to act after dealer (postflop). Skip folded.
    let next = (p.dealerIdx + 1) % p.seats.length;
    let safety = 0;
    while (p.seats[next].folded && safety < p.seats.length) {
      next = (next + 1) % p.seats.length;
      safety++;
    }
    p.currentSeat = next;
  }
  _publishPoker({
    event: 'poker_street',
    street,
    pot: p.pot,
    seats: p.seats,
    currentSeat: p.currentSeat,
    currentBet: 0,
    lastRaiser: null,
    dealerIdx: p.dealerIdx,
    sbIdx: p.sbIdx,
    bbIdx: p.bbIdx,
    ts: Date.now(),
  });
  announcePokerStreet(street, p.pot);
  renderPokerTable();
  if (street !== 'showdown') {
    setTimeout(() => pokerNextTurn(), _pokerVoiceOn ? 1600 : 150);
  }
}

async function pokerSettle(winnerAddr) {
  const p = state.poker;
  if (!p || !p.isHost) return;
  const winner = p.seats.find(s => s.addr.toLowerCase() === winnerAddr.toLowerCase());
  if (!winner) return;

  _publishPoker({
    event: 'poker_settle',
    winnerAddr: winner.addr,
    winnerName: winner.name,
    pot: p.pot,
    ts: Date.now(),
  });

  if (DEMO_MODE) {
    const myLc = (p.myAddr || '').toLowerCase();
    if (winner.addr.toLowerCase() === myLc) {
      state.total = (state.total || 0) + p.pot;
      state.pathUSD = state.total;
      try { localStorage.setItem('throw_demo_balance', state.total.toFixed(6)); } catch(_) {}
      renderWalletUI();
    } else {
      // Remote winner — credit via MQTT (don't also credit locally)
      try {
        const fakeHash = '0xPOKER' + Math.random().toString(16).slice(2, 12).toUpperCase();
        _demoCreditGlobal(winner.addr, p.pot, fakeHash);
      } catch(_) {}
    }
  } else {
    const escrowPK = state.bet.escrowKey;
    if (escrowPK) {
      const fee = parseFloat((p.pot * 0.03).toFixed(6));
      const payout = parseFloat((p.pot - fee).toFixed(6));
      const wc = { _escrowPK: escrowPK };
      const pc = {};
      try {
        if (fee > 0.0001) await _escrowSendExact(escrowPK, USDC_ADDR, TREASURY_ADDR, fee);
      } catch (e) { console.warn('poker rake failed', e); }
      try {
        if (payout > 0.001) await _escrowSend(wc, pc, winner.addr, payout);
      } catch (e) { console.warn('poker payout failed', e); }
      try { await _refillExecutor(escrowPK, fee); } catch(_) {}
    } else {
      alert('Escrow key missing — cannot pay out. Start a new table.');
    }
  }

  p.street = 'settled';
  moneyRain(8);
  const winLine = pokerSeatName(winner) + ' wins ' + p.pot;
  setPokerAnnounce(winLine, true);
  showTxFlash('🏆', '$' + p.pot, (winner.name || 'Winner') + ' wins!');
  renderPokerTable();
  try { localStorage.removeItem('throw_active_bet'); } catch(_) {}
}

function renderPokerTable() {
  const p = state.poker;
  if (!p) return;
  applyPokerTableMode();

  const badge = document.getElementById('poker-street-badge');
  if (badge) {
    badge.textContent = (p.street || 'preflop').toUpperCase();
    badge.className = 'poker-street-badge street-' + (p.street || 'preflop');
  }

  const potEl = document.getElementById('poker-pot-total');
  if (potEl) potEl.textContent = '$' + (p.pot || 0);

  const stackText = document.getElementById('poker-stack-text');
  const mySeat = p.seats.find(s => s.addr.toLowerCase() === (p.myAddr || '').toLowerCase());
  if (stackText) {
    if (p.street === 'waiting') stackText.textContent = 'WAITING FOR DEAL…';
    else stackText.textContent = mySeat ? `YOUR STACK: $${(mySeat.stack || 0).toFixed(2)}` : 'SPECTATOR';
  }

  const orbit = document.getElementById('poker-orbit');
  if (orbit) {
    orbit.innerHTML = '';
    const n = p.seats.length || 1;
    const radius = 120;
    p.seats.forEach((seat, i) => {
      const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
      const x = 50 + (radius / 2.2) * Math.cos(angle);
      const y = 50 + (radius / 2.2) * Math.sin(angle);
      const el = document.createElement('div');
      const isCurrent = i === p.currentSeat && p.street !== 'settled' && p.street !== 'showdown' && p.street !== 'waiting';
      const isWinnerPick = _pokerSelectedWinnerAddr && _pokerSelectedWinnerAddr.toLowerCase() === seat.addr.toLowerCase();
      el.className = 'poker-avatar' + (seat.folded ? ' poker-seat-folded' : '') + (isCurrent ? ' poker-seat-active' : '') + (isWinnerPick ? ' poker-seat-winner' : '');
      el.style.cssText = `position:absolute;left:${x}%;top:${y}%;transform:translate(-50%,-50%);width:64px;min-height:64px;text-align:center;`;
      const initials = (seat.name || seat.addr.slice(2,4)).slice(0,2).toUpperCase();
      const color = addrToColor(seat.addr);
      const role = i === p.dealerIdx ? 'D' : i === p.sbIdx ? 'SB' : i === p.bbIdx ? 'BB' : '';
      el.innerHTML = `
        <div style="width:48px;height:48px;border-radius:50%;margin:0 auto;background:${color};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;position:relative">
          ${initials}
          ${role ? `<div class="${role === 'D' ? 'dealer-badge' : role === 'SB' ? 'sb-badge' : 'bb-badge'}">${role}</div>` : ''}
        </div>
        <div style="font-size:10px;margin-top:2px;color:rgba(255,255,255,0.85)">${seat.name || ''}</div>
        <div style="font-size:10px;color:#4a9eff">$${(seat.stack || 0).toFixed(0)}</div>
        ${seat.bet > 0 ? `<div style="font-size:9px;color:#f39c12">bet $${seat.bet}</div>` : ''}
      `;
      if (p.isHost && p.street === 'showdown' && !seat.folded) {
        el.style.cursor = 'pointer';
        el.onclick = () => {
          _pokerSelectedWinnerAddr = seat.addr;
          const btn = document.getElementById('btn-poker-payout');
          if (btn) btn.disabled = false;
          renderPokerTable();
        };
      }
      orbit.appendChild(el);
    });
  }

  const actionArea = document.getElementById('poker-action-area');
  const turnLabel  = document.getElementById('poker-turn-label');
  const btnsWrap   = document.getElementById('poker-action-buttons');
  const raiseRow   = document.getElementById('poker-raise-row');
  if (actionArea && turnLabel && btnsWrap) {
    const showdown = p.street === 'showdown' || p.street === 'settled' || p.street === 'waiting';
    if (showdown) {
      actionArea.style.display = 'none';
      if (raiseRow) raiseRow.style.display = 'none';
    } else {
      actionArea.style.display = '';
      const myTurn  = isMyPokerTurn();
      const curSeat = p.seats[p.currentSeat];
      if (myTurn) {
        actionArea.classList.remove('poker-waiting');
        actionArea.classList.add('poker-your-turn-flash');
        turnLabel.textContent = 'YOUR TURN';
        const callAmt  = Math.max(0, (p.currentBet || 0) - (mySeat?.bet || 0));
        const canCheck = callAmt === 0;
        const myStack  = mySeat?.stack || 0;
        const myBet    = mySeat?.bet || 0;

        if (raiseRow) {
          raiseRow.style.display = 'flex';
          const minRaiseTo = (p.currentBet || 0) + 1;
          raiseRow.querySelectorAll('.poker-raise-chip').forEach(chip => {
            const amt     = parseInt(chip.dataset.raiseamt, 10);
            const visible = amt >= minRaiseTo && amt <= myStack + myBet;
            chip.style.display = visible ? '' : 'none';
            chip.classList.remove('active');
            chip.onclick = () => {
              raiseRow.querySelectorAll('.poker-raise-chip').forEach(c => c.classList.remove('active'));
              chip.classList.add('active');
              p._selectedRaise = amt;
            };
          });
        }

        btnsWrap.innerHTML = '';

        const throwLabel = canCheck ? 'CHECK' : `THROW $${callAmt}`;
        const throwBtn = _mkActionBtn(throwLabel, () => {
          if (canCheck) pokerHandleAction('check');
          else pokerHandleAction('call');
        });
        throwBtn.style.cssText += ';background:var(--accent,#f39c12);font-size:18px;font-weight:800;padding:14px 0;width:100%;';
        btnsWrap.appendChild(throwBtn);

        const raiseBtn = _mkActionBtn('RAISE', () => {
          const raiseTo = p._selectedRaise || ((p.currentBet || 0) + 1);
          pokerHandleAction('raise', raiseTo);
        });
        btnsWrap.appendChild(raiseBtn);

        if (myStack > 0) {
          btnsWrap.appendChild(_mkActionBtn('ALL IN $' + myStack, () => pokerHandleAction('allin')));
        }

        btnsWrap.appendChild(_mkActionBtn('FOLD', () => pokerHandleAction('fold')));

        if (!actionArea._flashed) {
          actionArea._flashed = true;
          pokerHaptic();
          setTimeout(() => { actionArea.classList.remove('poker-your-turn-flash'); actionArea._flashed = false; }, 800);
        }
      } else {
        actionArea.classList.add('poker-waiting');
        actionArea.classList.remove('poker-your-turn-flash');
        turnLabel.textContent = `Waiting for ${curSeat?.name || '\u2026'}`;
        btnsWrap.innerHTML = '';
        if (raiseRow) raiseRow.style.display = 'none';
      }
    }
  }

  const showdownCtl = document.getElementById('poker-showdown-controls');
  if (showdownCtl) {
    const isShowdown = p.street === 'showdown' && p.isHost;
    showdownCtl.style.display = isShowdown ? '' : 'none';
  }
}

function _mkActionBtn(label, onclick) {
  const b = document.createElement('button');
  b.className = 'btn-primary poker-action-btn';
  b.textContent = label;
  b.onclick = onclick;
  return b;
}

function onPokerAdvanceClick() {
  const advBtn = document.getElementById('btn-poker-advance');
  if (!advBtn) return;
  const next = advBtn.dataset.next || 'flop';
  pokerAdvanceStreet(next);
}

function onPokerPayoutClick() {
  if (!_pokerSelectedWinnerAddr) return;
  pokerSettle(_pokerSelectedWinnerAddr);
  _pokerSelectedWinnerAddr = null;
}

/* ── Poker MQTT ── */
let _pokerMqttClient = null;

function _subscribePokerTopic(roomCode) {
  try {
    try { _pokerMqttClient?.end(true); } catch(_) {}
    const clientId = 'poker_' + Math.random().toString(36).slice(2, 9);
    const c = mqtt.connect(MQTT_BROKER, { clientId, clean: true, connectTimeout: 8000, reconnectPeriod: 3000 });
    _pokerMqttClient = c;
    const topic = pokerTopic(roomCode);
    c.on('connect', () => {
      c.subscribe(topic, { qos: 1 });
    });
    c.on('message', (t, payload) => {
      if (t !== topic) return;
      let data;
      try { data = JSON.parse(payload.toString()); } catch { return; }
      _handlePokerMessage(data);
    });
  } catch (e) { console.warn('poker mqtt subscribe failed', e); }
}

function _publishPoker(msg) {
  const p = state.poker;
  if (!p || !p.roomCode) return;
  const topic = pokerTopic(p.roomCode);
  const payload = JSON.stringify(msg);
  try {
    if (_pokerMqttClient && _pokerMqttClient.connected) {
      _pokerMqttClient.publish(topic, payload, { qos: 1 });
    } else {
      const clientId = 'pokerpub_' + Math.random().toString(36).slice(2, 9);
      const c = mqtt.connect(MQTT_BROKER, { clientId, clean: true, connectTimeout: 6000, reconnectPeriod: 0 });
      c.on('connect', () => {
        c.publish(topic, payload, { qos: 1 }, () => { try { c.end(true); } catch(_) {} });
      });
    }
  } catch(_) {}
  // Apply locally immediately (host + actor) so UI doesn't wait on broker echo
  _handlePokerMessage(msg, { local: true });
}

function _handlePokerMessage(data, opts) {
  opts = opts || {};
  const p = state.poker;
  if (!data || !data.event) return;

  if (data.event === 'poker_start') {
    if (!state.poker || !state.poker.isHost) {
      state.poker = {
        seats: data.seats || [],
        pot: data.pot || 0,
        street: data.street || 'preflop',
        currentSeat: data.currentSeat || 0,
        dealerIdx: data.dealerIdx ?? 0,
        sbIdx: data.sbIdx ?? 1,
        bbIdx: data.bbIdx ?? 2,
        roomCode: data.roomCode,
        escrowAddr: data.escrowAddr || null,
        isHost: false,
        myAddr: state.account?.address,
        structure: 'texas-holdem',
        demo: !!DEMO_MODE,
        currentBet: data.currentBet ?? POKER_BB,
        lastRaiser: data.lastRaiser ?? null,
      };
      if (data.escrowAddr) state.bet.escrowAddr = data.escrowAddr;
      if (data.roomCode) state.bet.roomCode = data.roomCode;
      state.bet.structure = 'texas-holdem';
      state.bet.active = true;
      state.bet.isHost = false;
      // Non-host posts blinds they owe into the shared escrow (host already posted theirs)
      try {
        const myLc = (state.account?.address || '').toLowerCase();
        const escrow = data.escrowAddr;
        const seats = data.seats || [];
        let blindDue = 0;
        seats.forEach((s, i) => {
          if (s.addr && s.addr.toLowerCase() === myLc && s.bet > 0) {
            if (i === data.sbIdx || i === data.bbIdx) blindDue += s.bet;
          }
        });
        if (blindDue > 0 && escrow) {
          if (DEMO_MODE) {
            state.total = Math.max(0, (state.total || 0) - blindDue);
            state.pathUSD = state.total;
            try { localStorage.setItem('throw_demo_balance', state.total.toFixed(6)); } catch(_) {}
            renderWalletUI();
          } else {
            sendEscrowDeposit(escrow, blindDue).catch(e => console.error('poker blind deposit failed', e));
          }
        }
      } catch (e) { console.warn('poker blind sync failed', e); }
      showScreen('poker-table');
    } else if (state.poker.isHost) {
      // Host already applied via local publish — ignore echo
      if (!opts.local) return;
    }
    renderPokerTable();
    return;
  }
  if (!p) return;

  if (data.event === 'poker_turn') {
    if (opts.local && p.isHost) {
      // Already at this seat locally
      renderPokerTable();
      return;
    }
    if (!opts.local && p.isHost) return; // echo of our own turn publish
    p.currentSeat = data.seatIdx;
    p.currentBet = data.currentBet;
    p.pot = data.pot;
    const seat = p.seats[p.currentSeat];
    if (seat && !p.isHost) {
      // Player phones show the call on screen; host already spoke
      const name = pokerSeatName(seat);
      setPokerAnnounce(name + ', your action', false);
    }
    renderPokerTable();
    if (data.addr && p.myAddr && data.addr.toLowerCase() === p.myAddr.toLowerCase()) {
      pokerHaptic();
      const actionArea = document.getElementById('poker-action-area');
      if (actionArea) {
        actionArea.classList.add('poker-your-turn-flash');
        setTimeout(() => actionArea.classList.remove('poker-your-turn-flash'), 800);
      }
    }
    return;
  }

  if (data.event === 'poker_action') {
    const key = _pokerActionKey(data);
    if (_pokerSeenActionKeys.has(key)) return;
    // Local apply for the actor (and host if they are the actor / always for host-driven)
    if (opts.local) {
      _pokerSeenActionKeys.add(key);
      _applyAction(data);
      return;
    }
    // Remote: skip echo of our own action (already applied locally)
    if (data.addr && p.myAddr && data.addr.toLowerCase() === p.myAddr.toLowerCase()) return;
    _pokerSeenActionKeys.add(key);
    _applyAction(data);
    return;
  }

  if (data.event === 'poker_street') {
    if (!opts.local && p.isHost) return; // echo
    p.street = data.street;
    p.pot = data.pot;
    if (data.seats) p.seats = data.seats;
    if (data.currentBet != null) p.currentBet = data.currentBet;
    else p.currentBet = 0;
    if (data.currentSeat != null) p.currentSeat = data.currentSeat;
    if ('lastRaiser' in data) p.lastRaiser = data.lastRaiser;
    if (data.dealerIdx != null) p.dealerIdx = data.dealerIdx;
    if (data.sbIdx != null) p.sbIdx = data.sbIdx;
    if (data.bbIdx != null) p.bbIdx = data.bbIdx;
    renderPokerTable();
    return;
  }

  if (data.event === 'poker_settle') {
    if (!opts.local && p.isHost) {
      // Host already handled payout locally
      p.street = 'settled';
      renderPokerTable();
      return;
    }
    p.street = 'settled';
    // Money for remote winners arrives via demo_credit / on-chain escrow — don't double-credit here
    showTxFlash('🏆', '$' + (data.pot || 0), (data.winnerName || 'Winner') + ' wins!');
    moneyRain(6);
    renderPokerTable();
    return;
  }
}

function leavePokerRoom() {
  try { _pokerMqttClient?.end(true); } catch(_) {}
  _pokerMqttClient = null;
  state.poker = null;
  _pokerSelectedWinnerAddr = null;
  _pokerSeenActionKeys = new Set();
  if (state.bet?.structure === 'texas-holdem') {
    state.bet.active = false;
    try { localStorage.removeItem('throw_active_bet'); } catch(_) {}
  }
}
