/* ── THROW ROOM ENGINE ──────────────────────────────────────────────────
   Peer discovery via MQTT over WebSocket (HiveMQ public broker)
   Room = throw_room_{4-digit-code}
   Each peer broadcasts: { addr, heading, ts, name }
   ─────────────────────────────────────────────────────────────────────── */

const MQTT_BROKER  = 'wss://broker.hivemq.com:8884/mqtt';
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
};

/* ── Generate a random 4-digit room code ── */
function generateRoomCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

/* ── Connect + join room ── */
async function joinRoom(code, myAddr, myName, onPeers, onThrowReceived) {
  room.code             = code;
  room.onPeersChange    = onPeers;
  room.onThrowReceived  = onThrowReceived;

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
