/* ── THROW ROOM ENGINE ──────────────────────────────────────────────────
   Peer discovery via MQTT over WebSocket (HiveMQ public broker)
   Room = throw_room_{4-digit-code}
   Each peer broadcasts: { addr, heading, ts, name }
   ─────────────────────────────────────────────────────────────────────── */

const MQTT_BROKER  = 'wss://broker.emqx.io:8084/mqtt';
const ROOM_PREFIX  = 'throw5/room/';
const PEER_TTL_MS  = 8000; // remove peer if silent for 8s

const room = {
  client:   null,
  code:     null,        // 4-digit string
  peers:    {},          // addr -> { addr, heading, ts, name }
  myHeading: 0,
  headingInterval: null,
  onPeersChange: null,   // callback(peers)
  onThrowReceived: null, // callback({from, amount, addr})
  onBetOpen: null,       // callback(betData) — fired on player phones when host opens a bet
  onBetJoin: null,       // callback({addr, name, amount, side}) — fired on host when player throws in
  onBetSettled: null,    // callback({hostWon, pot, structure}) — fired on player phones at settlement
};

/* ── Generate a random 4-digit room code ── */
function generateRoomCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

/* ── Connect + join room ── */
async function joinRoom(code, myAddr, myName, onPeers, onThrowReceived, callbacks) {
  room.code             = code;
  room.onPeersChange    = onPeers;
  room.onThrowReceived  = onThrowReceived;
  if (callbacks) {
    if (callbacks.onBetOpen)    room.onBetOpen    = callbacks.onBetOpen;
    if (callbacks.onBetJoin)    room.onBetJoin    = callbacks.onBetJoin;
    if (callbacks.onBetSettled) room.onBetSettled = callbacks.onBetSettled;
  }

  return new Promise((resolve, reject) => {
    const clientId = 'throw_' + Math.random().toString(36).slice(2, 10);

    // mqtt.js is loaded globally via <script>
    room.client = mqtt.connect(MQTT_BROKER, {
      clientId,
      clean: true,
      connectTimeout: 8000,
      reconnectPeriod: 3000,
    });

    room.client.on('connect', () => {
      const topic = ROOM_PREFIX + code + '/+';
      room.client.subscribe(topic, () => {
        // Start broadcasting heading
        startHeadingBroadcast(myAddr, myName);
        resolve(code);
      });
    });

    room.client.on('message', (topic, message) => {
      try {
        const data = JSON.parse(message.toString());
        const subtopic = topic.split('/').pop(); // 'presence' | 'throw'

        if (subtopic === 'presence') {
          if (data.addr === myAddr) return; // ignore self
          room.peers[data.addr] = { ...data, ts: Date.now() };
          cleanStale();
          room.onPeersChange && room.onPeersChange(getPeers());
        }

        if (subtopic === 'throw' && data.to === myAddr) {
          room.onThrowReceived && room.onThrowReceived(data);
        }

        if (subtopic === 'bet') {
          if (data.event === 'bet_open' && data.hostAddr !== myAddr) {
            room.onBetOpen && room.onBetOpen(data);
          }
          if (data.event === 'bet_join' && data.hostAddr === myAddr) {
            // Only the host processes join events addressed to them
            room.onBetJoin && room.onBetJoin(data);
          }
          if (data.event === 'bet_settled' && data.hostAddr !== myAddr) {
            room.onBetSettled && room.onBetSettled(data);
          }
        }
      } catch (_) {}
    });

    room.client.on('error', (e) => {
      console.warn('[ROOM] MQTT error:', e.message);
      reject(e);
    });
  });
}

/* ── Leave room ── */
function leaveRoom() {
  if (room.headingInterval) clearInterval(room.headingInterval);
  if (room.client) { room.client.end(); room.client = null; }
  room.code  = null;
  room.peers = {};
}

/* ── Broadcast our heading every 1s ── */
function startHeadingBroadcast(addr, name) {
  if (room.headingInterval) clearInterval(room.headingInterval);

  // Start compass
  if ('AbsoluteOrientationSensor' in window) {
    try {
      const sensor = new AbsoluteOrientationSensor({ frequency: 5 });
      sensor.addEventListener('reading', () => {
        // Convert quaternion to compass heading
        const q = sensor.quaternion;
        const heading = Math.round(
          Math.atan2(2*(q[3]*q[2]+q[0]*q[1]), 1-2*(q[1]*q[1]+q[2]*q[2])) * (180/Math.PI) + 360
        ) % 360;
        room.myHeading = heading;
      });
      sensor.start();
    } catch (_) {}
  } else if ('ondeviceorientationabsolute' in window) {
    window.addEventListener('deviceorientationabsolute', (e) => {
      if (e.alpha !== null) room.myHeading = Math.round(e.alpha);
    }, true);
  } else {
    window.addEventListener('deviceorientation', (e) => {
      if (e.alpha !== null) room.myHeading = Math.round(e.alpha);
    }, true);
  }

  room.headingInterval = setInterval(() => {
    publishPresence(addr, name);
  }, 1000);

  // Publish immediately
  publishPresence(addr, name);
}

function publishPresence(addr, name) {
  if (!room.client || !room.code) return;
  const msg = JSON.stringify({
    addr,
    name: name || addr.slice(0, 6),
    heading: room.myHeading,
    ts: Date.now(),
  });
  room.client.publish(ROOM_PREFIX + room.code + '/presence', msg, { qos: 0 });
}

/* ── Publish a throw to a specific peer ── */
function publishThrow(from, to, amount) {
  if (!room.client || !room.code) return;
  const msg = JSON.stringify({ from, to, amount, ts: Date.now() });
  room.client.publish(ROOM_PREFIX + room.code + '/throw', msg, { qos: 1 });
}

/* ── Bet pub/sub helpers ── */

// Host calls this after opening a bet
function publishBetOpen(hostAddr, betData) {
  if (!room.client || !room.code) return;
  const msg = JSON.stringify({
    event:       'bet_open',
    hostAddr,
    escrow:      betData.escrowAddr,
    description: betData.description,
    amountPer:   betData.amountPer,
    structure:   betData.structure,
    roomCode:    room.code,
    ts:          Date.now(),
  });
  room.client.publish(ROOM_PREFIX + room.code + '/bet', msg, { qos: 1, retain: true });
}

// Player calls this after sending money to escrow
function publishBetJoin(hostAddr, playerAddr, playerName, amount, side, roomCode) {
  const code = roomCode || room.code;
  if (!code) return;
  const msg = JSON.stringify({
    event:      'bet_join',
    hostAddr,
    addr:       playerAddr,
    name:       playerName,
    amount,
    side,
    ts:         Date.now(),
  });
  const topic = ROOM_PREFIX + code + '/bet';
  // Use existing room client if ready, otherwise spin up one-shot client
  if (room.client && room.code === code) {
    room.client.publish(topic, msg, { qos: 1 });
  } else {
    _globalPublish(topic, msg, { qos: 1 });
  }
}

// Host calls this when settling
function publishBetSettled(hostAddr, hostWon, pot, structure, yesWon) {
  if (!room.client || !room.code) return;
  const msg = JSON.stringify({
    event:     'bet_settled',
    hostAddr,
    hostWon,
    yesWon:    (yesWon !== undefined) ? yesWon : hostWon,
    pot,
    structure,
    ts:        Date.now(),
  });
  const betTopic = ROOM_PREFIX + room.code + '/bet';
  // Publish settlement first; delay the retained-clear so any player whose
  // subscription just came live receives the message before the empty
  // retained payload overwrites it on the broker.
  room.client.publish(betTopic, msg, { qos: 1 }, () => {
    setTimeout(() => {
      if (room.client) room.client.publish(betTopic, '', { qos: 1, retain: true });
    }, 600);
  });
}

/* ── Find best target based on compass heading ── */
function findTarget(myHeading) {
  const peers = getPeers();
  if (!peers.length) return null;

  // Best target = peer whose heading is ~180° opposite to mine (facing me)
  let best = null, bestScore = -1;

  for (const p of peers) {
    const diff = Math.abs(((p.heading - myHeading + 540) % 360) - 180);
    // diff=0 means exactly facing each other, score = 180-diff (higher=better)
    const score = 180 - diff;
    if (score > bestScore) { bestScore = score; best = p; }
  }

  // Only target if reasonably facing (within 60° of directly opposite)
  return bestScore > 120 ? best : (peers.length === 1 ? peers[0] : null);
}

/* ── Find all targets for make-it-rain ── */
function getAllTargets() {
  return getPeers();
}

/* ── Helpers ── */
function getPeers() {
  return Object.values(room.peers);
}

function cleanStale() {
  const now = Date.now();
  for (const addr in room.peers) {
    if (now - room.peers[addr].ts > PEER_TTL_MS) delete room.peers[addr];
  }
}

function getRoomCode() { return room.code; }
function getMyHeading() { return room.myHeading; }
function isInRoom()     { return !!room.code; }

/* ── GLOBAL BET DISCOVERY (cross-device, no room code needed) ── */

// Global retained topic — any phone tapping BET gets this instantly
const GLOBAL_BET_TOPIC = 'throw5/bets/open';

// Global MQTT client for bet discovery (separate from room client)
let globalBetClient = null;

// Host publishes the bet globally (retained) so any phone can discover it
function publishGlobalBet(betData) {
  const msg = JSON.stringify({
    escrow:      betData.escrowAddr,
    description: betData.description,
    amountPer:   betData.amountPer,
    structure:   betData.structure,
    roomCode:    betData.roomCode,
    hostAddr:    betData.hostAddr,
    ts:          Date.now(),
  });
  // Publish on the room client if available (host is already in room)
  if (room.client) {
    room.client.publish(GLOBAL_BET_TOPIC, msg, { qos: 1, retain: true });
  } else {
    // Fallback: spin up a one-shot client
    _globalPublish(GLOBAL_BET_TOPIC, msg, { qos: 1, retain: true });
  }
}

// Player calls this — subscribes to global topic, calls cb(betData) within 500ms if bet active
function scanForBets(cb, timeoutMs) {
  timeoutMs = timeoutMs || 5000;
  if (globalBetClient) {
    try { globalBetClient.end(true); } catch(_) {}
    globalBetClient = null;
  }
  const clientId = 'throw_scan_' + Math.random().toString(36).slice(2, 10);
  globalBetClient = mqtt.connect(MQTT_BROKER, {
    clientId,
    clean: true,
    connectTimeout: 8000,
    reconnectPeriod: 0,
  });
  let fired = false;
  const timer = setTimeout(() => {
    if (!fired) { fired = true; cb(null); }
    stopScanForBets();
  }, timeoutMs);

  globalBetClient.on('connect', () => {
    globalBetClient.subscribe(GLOBAL_BET_TOPIC, { qos: 1 });
  });
  globalBetClient.on('message', (_topic, message) => {
    if (fired) return;
    const raw = message.toString();
    if (!raw) return; // empty = cleared retained
    try {
      const data = JSON.parse(raw);
      if (data.escrow && data.description) {
        fired = true;
        clearTimeout(timer);
        stopScanForBets();
        cb(data);
      }
    } catch(_) {}
  });
  globalBetClient.on('error', () => {
    if (!fired) { fired = true; clearTimeout(timer); cb(null); }
    stopScanForBets();
  });
}

function stopScanForBets() {
  if (globalBetClient) {
    try { globalBetClient.end(true); } catch(_) {}
    globalBetClient = null;
  }
}

// Host calls after settling — clears retained message so new players don't see stale bet
function clearGlobalBet() {
  // Publish empty retained message to clear
  if (room.client) {
    room.client.publish(GLOBAL_BET_TOPIC, '', { qos: 1, retain: true });
  } else {
    _globalPublish(GLOBAL_BET_TOPIC, '', { qos: 1, retain: true });
  }
}

function _globalPublish(topic, msg, opts) {
  const clientId = 'throw_pub_' + Math.random().toString(36).slice(2, 10);
  const c = mqtt.connect(MQTT_BROKER, { clientId, clean: true, connectTimeout: 6000, reconnectPeriod: 0 });
  c.on('connect', () => {
    // Ensure QoS 1 minimum so we wait for PUBACK before tearing down the client.
    // Brief hold after callback so broker can relay to any subscribers.
    const safeOpts = { ...opts, qos: Math.max((opts && opts.qos) || 0, 1) };
    c.publish(topic, msg, safeOpts, (err) => {
      if (err) console.warn('[ROOM] _globalPublish failed:', err.message);
      setTimeout(() => { try { c.end(true); } catch(_) {} }, 300);
    });
  });
  c.on('error', () => { try { c.end(true); } catch(_) {} });
}
