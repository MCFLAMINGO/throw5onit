/* ── THROW PWA ── app.js ─────────────────────────────────────────────── */
/* Tempo chain ID 4217 | pathUSD + USDC | viem bundled locally (no CDN) */

/* ═══════════════════════════════════════════════════════════════════════
   0. IMPORTS (local bundle — eliminates CDN XSS/supply-chain risk)
   ═════════════════════════════════════════════════════════════════════ */

// viem.bundle.js is loaded as a classic <script> before this file.
// It exposes all viem exports on window.__viem__
let viemLib = null;
async function getViem() {
  if (viemLib) return viemLib;
  // Try window.__viem__ (IIFE bundle)
  if (typeof window.__viem__ !== 'undefined') {
    viemLib = window.__viem__;
    return viemLib;
  }
  // Fallback: dynamic import from local file
  try {
    viemLib = await import('./viem.bundle.js');
    return viemLib;
  } catch(e) {
    console.error('[THROW] viem bundle failed to load:', e);
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
const TREASURY_ADDR = '0x0000000000000000000000000000000000000001'; // TODO: replace with real Tempo treasury wallet
// Tiered service fee by throw amount
const THROW_FEE_TABLE = {
  1: 0.10, 5: 0.15, 10: 0.20, 15: 0.25, 20: 0.30,
  25: 0.35, 30: 0.40, 35: 0.45, 40: 0.50, 45: 0.50, 50: 1.00
};
function getThrowFee(amount) {
  return THROW_FEE_TABLE[amount] ?? 0.10;
}

// Tempo DEX — fee is swapped through AMM so we earn the 0.3% LP fee on our own volume
const TEMPO_DEX_ADDR = '0xDEc0000000000000000000000000000000000000';

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
    players:    [],   // { addr, amount }
    total:      0,
  },

  // Throw state
  throwAmount: 5,
  throwMethod: 'gesture',

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
  const { generatePrivateKey, privateKeyToAccount } = await getViem();
  const pk = generatePrivateKey();
  return { privateKey: pk, ...privateKeyToAccount(pk) };
}

async function importWallet(pk) {
  const { privateKeyToAccount } = await getViem();
  if (!pk.startsWith('0x')) pk = '0x' + pk;
  const acc = privateKeyToAccount(pk);
  return { privateKey: pk, ...acc };
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
  await refreshBalances();
  renderCrew();
  showScreen('wallet');
  if (isNew) {
    // First time — give user 600ms to land on wallet screen, then offer backup
    setTimeout(() => offerBackup(acc), 600);
  }
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

// Check if backup has been done — used to re-prompt if still missing
function hasBackedUp() {
  try { if (localStorage.getItem('throw_backed_up')) return true; } catch(e) {}
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
  try {
    const { createPublicClient, http } = await getViem();
    const client = createPublicClient({
      transport: http(TEMPO_RPC),
    });

    // Both pathUSD and USDC.e use 6 decimals (TIP-20 standard)
    const [pathBal, usdcBal] = await Promise.all([
      client.readContract({ address: PATHUSD_ADDR, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr] }),
      client.readContract({ address: USDC_ADDR,    abi: ERC20_ABI, functionName: 'balanceOf', args: [addr] }),
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
}

/* ═══════════════════════════════════════════════════════════════════════
   6. SEND TRANSACTION (ERC-20 transfer on Tempo)
   ═════════════════════════════════════════════════════════════════════ */
async function sendStablecoin(toAddr, usdAmount) {
  const { createWalletClient, createPublicClient, http, parseUnits } = await getViem();

  // $0.10 service fee goes to treasury FIRST, recipient gets net amount
  const fee = getThrowFee(usdAmount);
  const netAmount = Math.max(0, usdAmount - fee);
  const totalNeeded = usdAmount; // sender pays full amount (fee + net)

  if (TREASURY_ADDR && TREASURY_ADDR !== '0x0000000000000000000000000000000000000001') {
    // Send fee to treasury (silently — user sees full $X throw)
    try { await _sendToken(USDC_ADDR, 6, TREASURY_ADDR, fee); } catch (_) {}
  }

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

async function _sendToken(tokenAddr, decimals, toAddr, usdAmount) {
  const { createWalletClient, createPublicClient, http, parseUnits } = await getViem();

  const tempoChain = {
    id: 4217,
    name: 'Tempo',
    nativeCurrency: { name: 'Tempo', symbol: 'TEMPO', decimals: 18 },
    rpcUrls: { default: { http: [TEMPO_RPC] } },
  };

  const walletClient = createWalletClient({
    account: state.account,
    chain: tempoChain,
    transport: http(TEMPO_RPC),
  });
  const publicClient = createPublicClient({
    chain: tempoChain,
    transport: http(TEMPO_RPC),
  });

  const amount = parseUnits(usdAmount.toFixed(decimals > 6 ? 6 : decimals), decimals);

  const hash = await walletClient.writeContract({
    address: tokenAddr,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [toAddr, amount],
  });

  await publicClient.waitForTransactionReceipt({ hash });

  // Log history
  state.txHistory.unshift({ type: 'sent', amount: usdAmount, to: toAddr, hash, ts: Date.now() });
  await refreshBalances();
  return hash;
}

/* ═══════════════════════════════════════════════════════════════════════
   7. GESTURE ENGINE (accelerometer-based throw)
   ═════════════════════════════════════════════════════════════════════ */
const gesture = {
  listening:   false,
  startTime:   0,
  samples:     [],
  maxAccel:    0,
  onThrow:     null, // callback
};

async function requestMotionPermission() {
  if (typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function') {
    const perm = await DeviceMotionEvent.requestPermission();
    return perm === 'granted';
  }
  return true; // Android / non-iOS
}

function startGestureCapture(onThrow) {
  gesture.listening = true;
  gesture.samples   = [];
  gesture.maxAccel  = 0;
  gesture.onThrow   = onThrow;
  gesture.startTime = Date.now();
  window.addEventListener('devicemotion', onMotion);
}

function stopGestureCapture() {
  gesture.listening = false;
  window.removeEventListener('devicemotion', onMotion);
}

function onMotion(e) {
  if (!gesture.listening) return;
  const a = e.acceleration || e.accelerationIncludingGravity;
  if (!a) return;

  const mag = Math.sqrt((a.x||0)**2 + (a.y||0)**2 + (a.z||0)**2);
  gesture.samples.push(mag);
  if (mag > gesture.maxAccel) gesture.maxAccel = mag;

  // Detect throw: sharp spike > 18 m/s² then drop
  if (mag > 18 && gesture.samples.length > 3) {
    const last = gesture.samples[gesture.samples.length - 2];
    if (last > 15) {
      stopGestureCapture();
      gesture.onThrow && gesture.onThrow();
    }
  }

  // Timeout safety
  if (Date.now() - gesture.startTime > 8000) {
    stopGestureCapture();
  }
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

function getSonicAudioCtx() {
  if (!sonicAudioCtx) sonicAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return sonicAudioCtx;
}

// Encode amount as sequence of tones (base + (digit * 200Hz))
async function sonicSend(amount) {
  const ctx = getSonicAudioCtx();
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
  const ctx = getSonicAudioCtx();
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

/* ═══════════════════════════════════════════════════════════════════════
   10b. ROOM ENGINE WIRING
   ═════════════════════════════════════════════════════════════════════ */

async function enterRoom(code) {
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
      }
    );
    state.inRoom   = true;
    state.roomCode = code;
    updateRoomBar();
    updateRoomUI();
  } catch (e) {
    alert('Could not join room. Check your connection.');
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
   12. THROW SCREEN LOGIC
   ═════════════════════════════════════════════════════════════════════ */
function openThrowScreen() {
  if (state.total < 0.01) {
    showScreen('qr');
    const addr = state.account?.address || '';
    renderQR(addr);
    const pk = _storedPK || localStorage.getItem('throw_pk') || 'Not found';
    document.getElementById('backup-key-display').textContent = pk;
    return;
  }
  // If contacts exist, pulse the crew row to direct attention there
  const contacts = getContacts();
  if (contacts.length > 0) {
    const row = document.getElementById('crew-row');
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.add('crew-pulse');
      setTimeout(() => row.classList.remove('crew-pulse'), 1200);
    }
    return;
  }
  // No contacts — go add a friend first
  showScreen('dock');
}

function setupThrowScreen() {
  // Amount buttons
  const qbtns = document.querySelectorAll('.throw-ui .qbtn');
  qbtns.forEach(b => {
    const a = parseFloat(b.dataset.amount);
    b.style.opacity = '';
    b.style.pointerEvents = '';
    const canAfford = state.total === 0 || a <= state.total; // allow if balance not loaded yet
    if (!canAfford) { b.style.opacity = '0.35'; b.style.pointerEvents = 'none'; }
    b.classList.toggle('active', a === state.throwAmount);
    b.onclick = () => {
      const a = parseFloat(b.dataset.amount);
      if (a > state.total && state.total > 0) return;
      state.throwAmount = a;
      document.getElementById('throw-amount-display').textContent = '$' + a;
      qbtns.forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const fee = getThrowFee(a);
      const net = (a - fee).toFixed(2);
      document.getElementById('throw-fee-line').textContent = `$${fee.toFixed(2)} fee — recipient gets $${net}`;
    };
  });

  // Method tabs
  document.querySelectorAll('.throw-ui .mtab').forEach(t => {
    t.onclick = () => {
      const m = t.dataset.method;
      state.throwMethod = m;
      document.querySelectorAll('.throw-ui .mtab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      document.querySelectorAll('.throw-ui .method-panel').forEach(p => p.classList.remove('active'));
      document.getElementById('panel-' + m).classList.add('active');
      activateThrowMethod(m);
    };
  });

  // Init default method
  activateThrowMethod(state.throwMethod);
}

function activateThrowMethod(method) {
  if (method === 'gesture') setupGestureThrow();
  if (method === 'nfc')     setupNFCThrow();
  if (method === 'sonic')   setupSonicThrow();
}

/* — Gesture throw — */
function setupGestureThrow() {
  const zone = document.getElementById('gesture-zone');
  zone.classList.remove('ready', 'charging', 'fired');

  zone.ontouchstart = zone.onmousedown = () => {
    // Must call requestPermission synchronously inside the touch handler — no await before it
    const permPromise = (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function')
      ? DeviceMotionEvent.requestPermission()
      : Promise.resolve('granted');

    permPromise.then(perm => {
      if (perm !== 'granted') {
        zone.querySelector('.gesture-hint').textContent = 'Allow motion in Settings';
        return;
      }
      zone.classList.add('charging');
      zone.querySelector('.gesture-hint').textContent = 'Flick toward friend!';
      startGestureCapture(async () => {
        zone.classList.remove('charging');
        zone.classList.add('fired');
        zone.querySelector('.gesture-hint').textContent = 'Thrown! ✓';
        const toAddr = state.currentTarget?.addr || null;
        await executeThrow(toAddr);
      });
    }).catch(() => {
      zone.querySelector('.gesture-hint').textContent = 'Motion blocked — tap Allow';
    });
  };
  zone.ontouchend = zone.onmouseup = () => {
    if (!zone.classList.contains('fired')) {
      stopGestureCapture();
      zone.classList.remove('charging');
      zone.classList.add('ready');
      zone.querySelector('.gesture-hint').textContent = 'Hold + flick toward friend';
    }
  };
}

/* — NFC throw — */
async function setupNFCThrow() {
  const data = {
    type:   'throw',
    amount: state.throwAmount,
    from:   state.account.address,
    ts:     Date.now(),
  };
  const ok = await startNFCWrite(data);
  if (!ok) {
    document.querySelector('#panel-nfc p').textContent = 'NFC not available — use Gesture or Sonic';
  } else {
    document.querySelector('#panel-nfc p').textContent = 'Dock phones back-to-back';
    // After write, wait for confirmation via BroadcastChannel or NFC ack
    bcSend('throw_pending', data);
  }
}

/* — Sonic throw — */
function setupSonicThrow() {
  // Auto-send on entering sonic panel
  setTimeout(() => {
    sonicSend(state.throwAmount);
    bcSend('throw_pending', { type: 'throw', amount: state.throwAmount, from: state.account.address, ts: Date.now() });
  }, 500);
}

/* ── Execute the actual blockchain transaction ── */
async function executeThrow(toAddr) {
  if (!toAddr) {
    alert('No target found. Point your phone at a friend in the room.');
    return;
  }

  showTxFlash('🤌', '$' + state.throwAmount, 'Throwing…');

  try {
    playThrowAnimation();
    await sendStablecoin(toAddr, state.throwAmount);
    // Notify recipient via room
    if (state.inRoom) {
      publishThrow(state.account.address, toAddr, state.throwAmount);
    }
    points.add(state.throwAmount);
    showTxFlash('✅', '$' + state.throwAmount, 'Thrown!');
    setTimeout(() => showScreen('wallet'), 1800);
  } catch (e) {
    hideTxFlash();
    alert('Transaction failed: ' + e.message);
    showScreen('wallet');
  }
}

async function executeRain() {
  const targets = getAllTargets();
  if (!targets.length) { alert('No one in the room to throw to.'); return; }
  const splitAmount = Math.floor((state.throwAmount / targets.length) * 100) / 100;
  if (splitAmount < 0.01) { alert('Amount too small to split.'); return; }

  showTxFlash('💸', 'RAIN', 'Making it rain…');
  try {
    for (const t of targets) {
      await sendStablecoin(t.addr, splitAmount);
      publishThrow(state.account.address, t.addr, splitAmount);
    }
    points.add(state.throwAmount);
    showTxFlash('💸', 'RAIN', 'Money everywhere!');
    setTimeout(() => showScreen('wallet'), 1800);
  } catch (e) {
    hideTxFlash();
    alert('Rain failed: ' + e.message);
    showScreen('wallet');
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   13. CATCH SCREEN LOGIC
   ═════════════════════════════════════════════════════════════════════ */
function openCatchScreen() {
  showScreen('catch');
  setupCatchScreen();
}

let _catchPollInterval = null;

function setupCatchScreen() {
  const orb    = document.getElementById('catch-orb');
  const status = document.getElementById('catch-status');
  orb.classList.remove('live', 'caught');
  status.textContent = 'Listening for incoming…';

  // Broadcast our address so thrower can target us
  bcSend('catcher_ready', { addr: state.account.address });
  // Also deliver to any pending throw resolver
  if (catcherResolve) {
    catcherResolve(state.account.address);
    catcherResolve = null;
  }

  orb.classList.add('live');

  // Poll chain every 3s while on catch screen — detects real on-chain arrival
  // (BroadcastChannel only works same-device; this handles cross-device throws)
  if (_catchPollInterval) clearInterval(_catchPollInterval);
  const startBal = state.total;
  _catchPollInterval = setInterval(async () => {
    if (currentScreen !== 'catch') { clearInterval(_catchPollInterval); _catchPollInterval = null; return; }
    await refreshBalances();
    if (state.total > startBal + 0.005) {
      clearInterval(_catchPollInterval); _catchPollInterval = null;
      const received = (state.total - startBal).toFixed(2);
      onMoneyReceived(parseFloat(received), 'on-chain');
    }
  }, 3000);

  // Listen for method tabs
  document.querySelectorAll('.catch-ui .mtab').forEach(t => {
    t.onclick = () => {
      document.querySelectorAll('.catch-ui .mtab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const m = t.dataset.catchmethod;
      if (m === 'sonic') {
        status.textContent = 'Listening for sonic signal…';
        sonicListen(amt => onMoneyReceived(amt));
      } else if (m === 'nfc') {
        status.textContent = 'Dock phones back-to-back…';
        startNFCRead(payload => {
          if (payload.type === 'throw') onMoneyReceived(payload.amount, payload.from);
        });
      } else {
        status.textContent = 'Listening for throw…';
      }
    };
  });
}

function onMoneyReceived(amount, from) {
  const orb    = document.getElementById('catch-orb');
  const status = document.getElementById('catch-status');
  orb.classList.remove('live');
  orb.classList.add('caught');
  status.textContent = '$' + amount.toFixed(2) + ' is on the way!';

  moneyRain();
  state.txHistory.unshift({ type: 'received', amount, from: from || '?', ts: Date.now() });

  setTimeout(async () => {
    await refreshBalances();
    showScreen('wallet');
  }, 2000);
}

/* ═══════════════════════════════════════════════════════════════════════
   14. BET SETUP (HOST)
   ═════════════════════════════════════════════════════════════════════ */
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

  // Generate ephemeral escrow keypair for this bet
  const { generatePrivateKey, privateKeyToAccount } = await getViem();
  const escrowPK   = generatePrivateKey();
  const escrowAcct = privateKeyToAccount(escrowPK);

  Object.assign(state.bet, {
    active:      true,
    isHost:      true,
    description: desc,
    escrowKey:   escrowPK,
    escrowAddr:  escrowAcct.address,
    players:     [],
    total:       0,
  });

  // Broadcast bet to any listeners on same network / same device
  bcSend('bet_open', {
    escrow:      state.bet.escrowAddr,
    description: state.bet.description,
    amountPer:   state.bet.amountPer,
    structure:   state.bet.structure,
  });

  showScreen('pot');
  renderPotScreen();
}

function renderPotScreen() {
  document.getElementById('pot-bet-text').textContent  = state.bet.description;
  document.getElementById('pot-struct-badge').textContent = {
    'winner-all':  'WINNER TAKES ALL',
    'flip':        'THE FLIP',
    'round-robin': 'ROUND ROBIN',
  }[state.bet.structure];
  document.getElementById('pot-total').textContent = '$' + state.bet.total.toFixed(2);
  renderPotPlayers();
}

function renderPotPlayers() {
  const el = document.getElementById('pot-players');
  el.innerHTML = state.bet.players.map(p =>
    `<div class="pot-player-chip">${shortAddr(p.addr)} +$${p.amount}</div>`
  ).join('');
}

function addPlayerToPot(fromAddr, amount) {
  state.bet.players.push({ addr: fromAddr, amount });
  state.bet.total += amount;
  document.getElementById('pot-total').textContent = '$' + state.bet.total.toFixed(2);
  renderPotPlayers();
  moneyRain(3);
}

/* ─── SETTLE ─── */
async function settleBet(hostWon) {
  if (!state.bet.active || !state.bet.isHost) return;

  const { createWalletClient, createPublicClient, http, parseUnits, privateKeyToAccount } = await getViem();

  const escrowAcct = privateKeyToAccount(state.bet.escrowKey);
  const tempoChain = {
    id: 4217,
    name: 'Tempo',
    nativeCurrency: { name: 'Tempo', symbol: 'TEMPO', decimals: 18 },
    rpcUrls: { default: { http: [TEMPO_RPC] } },
  };

  const wc = createWalletClient({ account: escrowAcct, chain: tempoChain, transport: http(TEMPO_RPC) });
  const pc = createPublicClient({ chain: tempoChain, transport: http(TEMPO_RPC) });

  const pot     = state.bet.total;
  const players = state.bet.players;
  const hostAddr = state.account.address;

  showTxFlash('⚖️', '$' + pot.toFixed(2), 'Settling…');

  let results = [];

  try {
    if (state.bet.structure === 'winner-all') {
      if (hostWon) {
        // All pot to host
        await _escrowSend(wc, pc, hostAddr, pot);
        results = [{ addr: hostAddr, amount: pot, type: 'win' }];
      } else {
        // Split pot among players
        const share = pot / (players.length || 1);
        for (const p of players) {
          await _escrowSend(wc, pc, p.addr, share);
          results.push({ addr: p.addr, amount: share, type: 'win' });
        }
      }
    } else if (state.bet.structure === 'flip') {
      // Host gets their stake back * 2 if won; players get theirs if host lost
      const hostStake = state.bet.amountPer;
      if (hostWon) {
        await _escrowSend(wc, pc, hostAddr, Math.min(hostStake * 2, pot));
        const rem = Math.max(0, pot - hostStake * 2);
        if (rem > 0.001 && players.length) {
          const sh = rem / players.length;
          for (const p of players) await _escrowSend(wc, pc, p.addr, sh);
        }
      } else {
        // Players get their stake * 2 up to pot
        let remaining = pot;
        for (const p of players) {
          const pay = Math.min(p.amount * 2, remaining / players.length);
          await _escrowSend(wc, pc, p.addr, pay);
          remaining -= pay;
          results.push({ addr: p.addr, amount: pay, type: 'win' });
        }
        if (remaining > 0.001) await _escrowSend(wc, pc, hostAddr, remaining);
      }
    } else {
      // Round robin — everyone on losing side pays everyone on winning side proportionally
      // Simplified: host = one side, players = other side
      if (hostWon) {
        await _escrowSend(wc, pc, hostAddr, pot);
      } else {
        const sh = pot / (players.length || 1);
        for (const p of players) await _escrowSend(wc, pc, p.addr, sh);
      }
    }

    bcSend('bet_settled', { hostWon, pot, structure: state.bet.structure });

    showSettledScreen(hostWon, pot, results);
    state.bet.active = false;

  } catch (e) {
    hideTxFlash();
    alert('Settlement failed: ' + e.message);
  }
}

async function _escrowSend(wc, pc, toAddr, usdAmount) {
  if (usdAmount < 0.001) return;
  const { parseUnits } = await getViem();
  // Send from escrow — prefer pathUSD (check balance first)
  // For simplicity, send USDC (6 decimals) from escrow
  const amount = parseUnits(usdAmount.toFixed(6), 6);
  const hash = await wc.writeContract({
    address: USDC_ADDR, abi: ERC20_ABI, functionName: 'transfer', args: [toAddr, amount],
  });
  await pc.waitForTransactionReceipt({ hash });
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
    escrowAddr:  betData.escrow,
  });

  showScreen('player-bet');
  document.getElementById('player-bet-desc').textContent = betData.description;
  const netAmt = (betData.amountPer - 0.10).toFixed(2);
  document.getElementById('player-bet-amount').textContent = '$' + netAmt + ' in the pot';
  document.getElementById('player-bet-status').textContent = `Throw $${betData.amountPer} — $0.10 fee, $${netAmt} lands in pot`;
  document.getElementById('player-bet-status').textContent = 'Hold + flick at host phone to join';

  setupPlayerBetThrow();
}

function setupPlayerBetThrow() {
  const zone = document.getElementById('bet-throw-zone');
  zone.classList.remove('charging', 'fired');

  zone.ontouchstart = zone.onmousedown = async () => {
    const granted = await requestMotionPermission();
    if (!granted) { alert('Motion needed'); return; }
    zone.classList.add('charging');
    startGestureCapture(async () => {
      zone.classList.remove('charging');
      zone.classList.add('fired');
      document.getElementById('player-bet-status').textContent = 'Throwing…';
      try {
        await sendStablecoin(state.bet.escrowAddr, state.bet.amountPer);
        bcSend('player_threw', { addr: state.account.address, amount: state.bet.amountPer - 0.10 });
        document.getElementById('player-bet-status').textContent = '✅ You\'re in! Waiting for host to settle…';
      } catch (e) {
        document.getElementById('player-bet-status').textContent = '❌ Failed: ' + e.message;
      }
    });
  };
  zone.ontouchend = zone.onmouseup = () => {
    if (!zone.classList.contains('fired')) {
      stopGestureCapture();
      zone.classList.remove('charging');
    }
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   16. TX FLASH + ANIMATIONS
   ═════════════════════════════════════════════════════════════════════ */
function showTxFlash(icon, amount, label) {
  document.getElementById('tx-icon').textContent   = icon;
  document.getElementById('tx-amount').textContent = amount;
  document.getElementById('tx-label').textContent  = label;
  document.getElementById('tx-flash').classList.remove('hidden');
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
    // Another device opened a bet — pop up player flow
    // Only if we're not the host
    if (!state.bet.isHost && state.account) {
      openPlayerBet(payload);
    }
  }

  if (type === 'player_threw') {
    // Host receives player throw notification
    if (state.bet.isHost && currentScreen === 'pot') {
      addPlayerToPot(payload.addr, payload.amount);
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
function upsertContact(name, addr) {
  const contacts = getContacts();
  const idx = contacts.findIndex(c => c.addr.toLowerCase() === addr.toLowerCase());
  const entry = { name: name.toUpperCase().slice(0,6), addr, lastThrow: Date.now(), ts: Date.now() };
  if (idx >= 0) {
    contacts[idx] = { ...contacts[idx], name: entry.name, lastThrow: entry.lastThrow };
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
  contactOverlayAmount = 5;
  document.getElementById('contact-overlay-avatar').textContent = name.slice(0,2);
  document.getElementById('contact-overlay-avatar').style.background = addrToColor(addr);
  document.getElementById('contact-overlay-name').textContent = name;
  document.getElementById('contact-overlay-addr').textContent = addr.slice(0,6) + '…' + addr.slice(-4);
  document.querySelectorAll('.contact-overlay-amounts .qbtn').forEach(b => {
    b.classList.toggle('active', parseFloat(b.dataset.camount) === 5);
  });
  updateContactFeeLine();
  // Reset gesture zone
  const cgz2 = document.getElementById('contact-gesture-zone');
  if (cgz2) {
    cgz2.classList.remove('charging', 'fired');
    const h = document.getElementById('contact-gesture-hint');
    if (h) h.textContent = 'Hold + flick to throw';
  }
  // Grey out amounts over balance
  document.querySelectorAll('.contact-overlay-amounts .qbtn').forEach(b => {
    const a = parseFloat(b.dataset.camount);
    const cantAfford = state.total > 0 && a > state.total;
    b.style.opacity = cantAfford ? '0.35' : '';
    b.style.pointerEvents = cantAfford ? 'none' : '';
  });
  document.getElementById('contact-overlay').classList.remove('hidden');
}
function closeContactOverlay() {
  document.getElementById('contact-overlay').classList.add('hidden');
  contactOverlayTarget = null;
}
function updateContactFeeLine() {
  const fee = getThrowFee(contactOverlayAmount);
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
  // Gesture zone in contact overlay
  const cgz = document.getElementById('contact-gesture-zone');
  const cgHint = document.getElementById('contact-gesture-hint');
  cgz.ontouchstart = cgz.onmousedown = () => {
    const permPromise = (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function')
      ? DeviceMotionEvent.requestPermission()
      : Promise.resolve('granted');
    permPromise.then(perm => {
      if (perm !== 'granted') { cgHint.textContent = 'Allow motion in Settings'; return; }
      cgz.classList.add('charging');
      cgHint.textContent = 'Flick!';
      startGestureCapture(async () => {
        cgz.classList.remove('charging');
        cgz.classList.add('fired');
        cgHint.textContent = 'Thrown! ✓';
        const target = contactOverlayTarget;
        const amount = contactOverlayAmount;
        closeContactOverlay();
        showTxFlash('🤌', '$' + amount, 'Throwing to ' + target.name + '…');
        try {
          playThrowAnimation();
          await sendStablecoin(target.addr, amount);
          touchContact(target.addr);
          points.add(amount);
          showTxFlash('✅', '$' + amount, 'Thrown to ' + target.name + '!');
          await refreshBalances();
          setTimeout(() => { hideTxFlash(); showScreen('wallet'); }, 1800);
        } catch(e) {
          hideTxFlash();
          alert('Throw failed: ' + e.message);
          showScreen('wallet');
        }
      });
    }).catch(() => { cgHint.textContent = 'Motion blocked — tap Allow'; });
  };
  cgz.ontouchend = cgz.onmouseup = () => {
    if (!cgz.classList.contains('fired')) {
      stopGestureCapture();
      cgz.classList.remove('charging');
      cgHint.textContent = 'Hold + flick to throw';
    }
  };

  // NFC button in contact overlay
  const nfcBtn = document.getElementById('btn-contact-nfc');
  if (nfcBtn) {
    nfcBtn.onclick = async () => {
      if (!contactOverlayTarget) return;
      const target = contactOverlayTarget;
      const amount = contactOverlayAmount;
      nfcBtn.textContent = 'Tap phones...';
      const data = { type: 'throw', amount, from: state.account.address, ts: Date.now() };
      const ok = await startNFCWrite(data);
      if (!ok) {
        nfcBtn.innerHTML = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12C2 6.48 6.48 2 12 2s10 4.48 10 10-4.48 10-10 10S2 17.52 2 12z"/><path d="M8 12a4 4 0 0 1 4-4"/><path d="M12 16a4 4 0 0 0 4-4"/></svg><span>NFC</span>';
        alert('NFC not available on this device');
        return;
      }
      bcSend('throw_pending', data);
      closeContactOverlay();
      showTxFlash('🤌', '$' + amount, 'Throwing via NFC…');
      try {
        playThrowAnimation();
        await sendStablecoin(target.addr, amount);
        touchContact(target.addr);
        points.add(amount);
        showTxFlash('✅', '$' + amount, 'Thrown to ' + target.name + '!');
        await refreshBalances();
        setTimeout(() => { hideTxFlash(); showScreen('wallet'); }, 1800);
      } catch(e) { hideTxFlash(); alert('Throw failed: ' + e.message); showScreen('wallet'); }
    };
  }

  // Sonic button in contact overlay
  const sonicBtn = document.getElementById('btn-contact-sonic');
  if (sonicBtn) {
    sonicBtn.onclick = async () => {
      if (!contactOverlayTarget) return;
      const target = contactOverlayTarget;
      const amount = contactOverlayAmount;
      closeContactOverlay();
      showTxFlash('🤌', '$' + amount, 'Throwing via Sonic…');
      sonicSend(amount);
      bcSend('throw_pending', { type: 'throw', amount, from: state.account.address, ts: Date.now() });
      try {
        playThrowAnimation();
        await sendStablecoin(target.addr, amount);
        touchContact(target.addr);
        points.add(amount);
        showTxFlash('✅', '$' + amount, 'Thrown to ' + target.name + '!');
        await refreshBalances();
        setTimeout(() => { hideTxFlash(); showScreen('wallet'); }, 1800);
      } catch(e) { hideTxFlash(); alert('Throw failed: ' + e.message); showScreen('wallet'); }
    };
  }

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

  const { generatePrivateKey, privateKeyToAccount } = await getViem();
  const pk  = generatePrivateKey();
  const acc = privateKeyToAccount(pk);

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

document.addEventListener('DOMContentLoaded', async () => {

  /* ── Handle gifted wallet URL params ── */
  const _urlParams = new URLSearchParams(window.location.search);
  const _giftPK       = _urlParams.get('pk');
  const _giftName     = _urlParams.get('name');
  const _giftFromAddr = _urlParams.get('fromAddr') || '';
  const _giftFromName = _urlParams.get('fromName') || '';
  const _hasGiftedPK  = !!_giftPK;

  if (_hasGiftedPK) {
    if (!isStandalone()) {
      // In Safari browser — show install instructions.
      // CRITICAL: do NOT strip URL params — iOS saves the current URL as the PWA launch URL.
      // When she adds to home screen and opens the PWA, it launches with ?pk=...&name=... intact.
      const splash = document.getElementById('screen-splash');
      if (splash) splash.classList.remove('active');
      setTimeout(() => showScreen('install-first'), 50);
      // Skip all further wallet init — return early after DOMContentLoaded setup
    }
    // If in PWA — fall through to normal gifted wallet import below
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
  document.getElementById('btn-catch').onclick  = openCatchScreen;
  document.getElementById('btn-open-bet').onclick = openBetSetup;
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
  document.getElementById('btn-make-it-rain').onclick = executeRain;
  document.getElementById('btn-qr-receive').onclick = () => openAddCashScreen();
  document.getElementById('btn-load-cash').onclick  = () => openAddCashScreen();
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

  /* ── Catch screen ── */
  document.getElementById('catch-back').onclick = () => {
    stopSonicListen();
    stopNFC();
    if (_catchPollInterval) { clearInterval(_catchPollInterval); _catchPollInterval = null; }
    showScreen('wallet');
  };

  /* ── Bet setup screen ── */
  document.getElementById('bet-setup-back').onclick = () => showScreen('wallet');
  document.getElementById('btn-start-pot').onclick  = startPot;

  /* ── Pot screen ── */
  document.getElementById('btn-win').onclick  = () => settleBet(true);
  document.getElementById('btn-lose').onclick = () => settleBet(false);

  /* ── Settled screen ── */
  document.getElementById('btn-new-bet').onclick = () => {
    state.bet = { active: false, isHost: false, description: '', amountPer: 5,
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

  /* ── Voice ── */
  setupVoice();

  /* ── Restore session / initial screen routing ── */
  document.getElementById('btn-splash-enter').onclick = () => {}; // neutralize — we handle routing

  // Check for gifted wallet — URL params (PWA) or sessionStorage (after install from browser)
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

  if (giftPK && isStandalone()) {
    // PWA with gifted wallet — import it directly
    try {
      const acc = await importWallet(giftPK);
      if (giftName) saveHandle(giftName);
      saveWallet(acc);
      // Auto-add the friend who invited you
      if (_giftFromAddr && _giftFromName) upsertContact(_giftFromName, _giftFromAddr);
      window.history.replaceState({}, '', window.location.pathname);
      await initWallet(acc, true); // new gifted wallet — offer backup
    } catch(e) {
      console.warn('Gift import failed:', e);
      showScreen('splash');
    }
  } else if (!_hasGiftedPK) {
    // Normal load — check for saved wallet
    const saved = await loadWallet();
    if (saved) {
      await initWallet(saved);
    } else if (isStandalone()) {
      // PWA, no wallet yet — show first-scan screen (user must tap to start camera on iOS)
      showScreen('first-scan');
    } else {
      // Browser, no wallet — show splash normally
      document.getElementById('screen-splash').classList.add('active');
      document.getElementById('btn-splash-enter').onclick = () => {
        if (!isMobile()) {
          showScreen('install');
        } else {
          showScreen('install-first');
        }
      };
    }
  }
  // Render crew row
  renderCrew();

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
  if (merchant.mode === 'merchant') {
    document.getElementById('merchant-addr-display').textContent =
      '\u2022\u2022\u2022\u2022' + account.address.slice(-4).toUpperCase();
    showScreen('merchant-setup');
  } else {
    await initWallet(account, isNew);
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

