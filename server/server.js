// HFAC signaling server.
//
// Responsibilities:
//   - room lifecycle: create (duo = max 2, group = max 8), join, leave
//   - 8-digit numeric room codes
//   - relaying SDP offers/answers and ICE candidates between peers
//   - serving a tiny landing page at /j/<code> so a shared link can open the app
//
// Call audio never touches this server — it flows peer-to-peer via WebRTC.

'use strict';

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;
const MAX_GROUP = 8;
const CODE_LENGTH = 8;

// ---- abuse limits ---------------------------------------------------------
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 500); // global active-room cap
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_HOURS || 12) * 3_600_000;
const JOIN_LIMIT = { max: 10, windowMs: 60_000 }; // join attempts per IP
const CREATE_LIMIT = { max: 20, windowMs: 3_600_000 }; // room creations per IP
const MSG_LIMIT = { max: 300, windowMs: 10_000 }; // messages per connection
const MAX_PAYLOAD_BYTES = 64 * 1024; // SDP blobs are ~10 KB

/** @type {Map<string, Room>} code -> room */
const rooms = new Map();

let nextClientId = 1;

class Room {
  constructor(code, mode) {
    this.code = code;
    this.mode = mode; // 'duo' | 'group'
    this.createdAt = Date.now();
    /** @type {Map<string, import('ws').WebSocket>} clientId -> socket */
    this.members = new Map();
    /** @type {Map<string, string>} clientId -> display name */
    this.names = new Map();
  }

  get capacity() {
    return this.mode === 'duo' ? 2 : MAX_GROUP;
  }
}

// Sliding-window rate limiter: prunes stale timestamps, rejects when full.
function allow(timestamps, { max, windowMs }) {
  const now = Date.now();
  while (timestamps.length && now - timestamps[0] > windowMs) timestamps.shift();
  if (timestamps.length >= max) return false;
  timestamps.push(now);
  return true;
}

/** @type {Map<string, {join: number[], create: number[]}>} */
const ipHistory = new Map();

function ipBucket(ip) {
  let bucket = ipHistory.get(ip);
  if (!bucket) {
    bucket = { join: [], create: [] };
    ipHistory.set(ip, bucket);
  }
  return bucket;
}

// Behind Render/other proxies the client address is in x-forwarded-for.
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// Forget quiet IPs so the history map can't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of ipHistory) {
    const last = Math.max(b.join[b.join.length - 1] || 0, b.create[b.create.length - 1] || 0);
    if (now - last > CREATE_LIMIT.windowMs) ipHistory.delete(ip);
  }
}, 600_000);

// Expire ancient rooms.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL_MS) {
      console.log(`room ${code} expired`);
      for (const member of room.members.values()) {
        send(member, { type: 'error', reason: 'room expired' });
        member.close(4000, 'room expired');
      }
      rooms.delete(code);
    }
  }
}, 60_000);

function newRoomCode() {
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += crypto.randomInt(0, 10);
    if (!rooms.has(code)) return code;
  }
  throw new Error('could not allocate a room code');
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, exceptId) {
  for (const [id, ws] of room.members) {
    if (id !== exceptId) send(ws, obj);
  }
}

function leaveRoom(ws) {
  const room = ws.room;
  if (!room) return;
  room.members.delete(ws.clientId);
  room.names.delete(ws.clientId);
  ws.room = null;
  broadcast(room, { type: 'peer-left', id: ws.clientId });
  if (room.members.size === 0) {
    rooms.delete(room.code);
    console.log(`room ${room.code} closed (empty)`);
  }
}

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create': {
      if (ws.room) return send(ws, { type: 'error', reason: 'already in a room' });
      if (rooms.size >= MAX_ROOMS) return send(ws, { type: 'error', reason: 'server is full' });
      if (!allow(ipBucket(ws.ip).create, CREATE_LIMIT)) {
        return send(ws, { type: 'error', reason: 'too many rooms created, try later' });
      }
      const mode = msg.mode === 'duo' ? 'duo' : 'group';
      const room = new Room(newRoomCode(), mode);
      rooms.set(room.code, room);
      ws.room = room;
      room.members.set(ws.clientId, ws);
      room.names.set(ws.clientId, String(msg.name || 'Guest').slice(0, 32));
      send(ws, { type: 'created', code: room.code, mode, selfId: ws.clientId });
      console.log(`room ${room.code} created (${mode}) by ${ws.clientId}`);
      break;
    }

    case 'join': {
      if (ws.room) return send(ws, { type: 'error', reason: 'already in a room' });
      if (!allow(ipBucket(ws.ip).join, JOIN_LIMIT)) {
        return send(ws, { type: 'error', reason: 'too many join attempts, slow down' });
      }
      const code = String(msg.code || '').replace(/\D/g, '');
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'error', reason: 'room not found' });
      if (room.members.size >= room.capacity) {
        return send(ws, { type: 'error', reason: 'room is full' });
      }
      const name = String(msg.name || 'Guest').slice(0, 32);
      const peers = [...room.members.keys()].map((id) => ({
        id,
        name: room.names.get(id),
      }));
      ws.room = room;
      room.members.set(ws.clientId, ws);
      room.names.set(ws.clientId, name);
      send(ws, { type: 'joined', code, mode: room.mode, selfId: ws.clientId, peers });
      broadcast(room, { type: 'peer-joined', id: ws.clientId, name }, ws.clientId);
      console.log(`${ws.clientId} joined room ${code} (${room.members.size}/${room.capacity})`);
      break;
    }

    case 'signal': {
      // Relay SDP / ICE to one peer in the same room.
      const room = ws.room;
      if (!room) return;
      const target = room.members.get(String(msg.to));
      if (target) {
        send(target, {
          type: 'signal',
          from: ws.clientId,
          name: room.names.get(ws.clientId),
          data: msg.data,
        });
      }
      break;
    }

    case 'leave':
      leaveRoom(ws);
      break;

    default:
      send(ws, { type: 'error', reason: `unknown message type: ${msg.type}` });
  }
}

// ---------------------------------------------------------------------------
// HTTP: health check + join landing page (for shared links / QR codes)
// ---------------------------------------------------------------------------

// GitHub's "latest release" download link is stable across versions as long
// as the asset filename is always the same (release.yml uploads "hfac.apk"
// alongside the versioned one specifically for this URL).
const APK_DOWNLOAD_URL =
  process.env.APK_DOWNLOAD_URL ||
  'https://github.com/axyz070202/hfac/releases/latest/download/hfac.apk';

function joinPage(code) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join HFAC room</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;
       flex-direction:column;align-items:center;justify-content:center;min-height:100vh;
       gap:1.25rem;margin:0;padding:2rem 1rem;
       background:radial-gradient(circle at 50% 0%,#1c2436,#0b0e14 60%);color:#e8eaf0}
  .card{background:#151a26;border:1px solid #262e42;border-radius:1.1rem;padding:2rem 1.75rem;
        max-width:26rem;width:100%;text-align:center;
        box-shadow:0 20px 60px -20px rgba(0,0,0,.6)}
  .kicker{font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:#7c8bb0;margin-bottom:.4rem}
  .code{font-size:2.4rem;letter-spacing:.3rem;font-weight:700;font-variant-numeric:tabular-nums;
        color:#fff;margin:0 0 1.5rem}
  ol{text-align:left;color:#b6bdd1;font-size:.92rem;line-height:1.6;margin:0 0 1.5rem;padding-left:1.2rem}
  ol li{margin-bottom:.3rem}
  a.btn{display:block;text-decoration:none;padding:.85rem 1.4rem;border-radius:.7rem;
        font-weight:600;font-size:.95rem;margin-bottom:.7rem;transition:opacity .15s}
  a.btn:active{opacity:.75}
  a.primary{background:#5b8def;color:#fff}
  a.secondary{background:#232b3d;color:#e8eaf0;border:1px solid #333d54}
  .hint{color:#7c8bb0;font-size:.8rem;margin-top:.75rem}
  footer{color:#525a72;font-size:.78rem;letter-spacing:.02em}
</style></head><body>
<div class="card">
  <div class="kicker">HFAC room</div>
  <div class="code">${code}</div>
  <ol>
    <li>Don't have HFAC yet? Download &amp; install it below.</li>
    <li>Then come back and tap <strong>Open in HFAC app</strong>.</li>
    <li>No app? Just enter the code above manually once it's installed.</li>
  </ol>
  <a class="btn primary" href="${APK_DOWNLOAD_URL}">⬇ Download HFAC (Android)</a>
  <a class="btn secondary" href="hfac://join/${code}">Open in HFAC app</a>
  <p class="hint">Or scan this page's QR code from inside the app.</p>
</div>
<footer>Powered by Nightfury</footer>
</body></html>`;
}

// General invite/landing page — no room attached, just "come get the app".
// Meant to be shared directly (e.g. the bare server URL, a bio link, a QR
// code on a poster) rather than generated per-room.
function invitePage() {
  const features = [
    ['🎧', 'Media-channel audio', 'Calls run on the same high-quality audio path as music, not the muffled voice-call channel.'],
    ['🔊', 'Full Bluetooth quality', 'Bluetooth earphones get full A2DP fidelity output instead of low-quality call-mode audio.'],
    ['🔒', 'End-to-end encrypted', 'Every call is peer-to-peer with DTLS-SRTP encryption, plus a safety code to verify it.'],
    ['🔗', 'Instant rooms', 'Start a 1-to-1 or group call and invite others by link, QR code, or an 8-digit number.'],
  ];
  const featureHtml = features
    .map(
      ([icon, title, desc]) => `
    <div class="feature">
      <div class="feature-icon">${icon}</div>
      <div>
        <div class="feature-title">${title}</div>
        <div class="feature-desc">${desc}</div>
      </div>
    </div>`
    )
    .join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HFAC — High Fidelity Audio Calls</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;
       flex-direction:column;align-items:center;min-height:100vh;margin:0;
       padding:3rem 1.25rem 2rem;gap:2rem;
       background:radial-gradient(circle at 50% 0%,#1c2436,#0b0e14 60%);color:#e8eaf0}
  .hero{text-align:center;max-width:28rem}
  h1{font-size:2.4rem;margin:0 0 .5rem;letter-spacing:-.02em}
  .tagline{color:#9aa4c2;font-size:1.05rem;margin:0}
  .card{background:#151a26;border:1px solid #262e42;border-radius:1.1rem;padding:1.75rem;
        max-width:28rem;width:100%;box-shadow:0 20px 60px -20px rgba(0,0,0,.6)}
  .feature{display:flex;gap:.9rem;align-items:flex-start;margin-bottom:1.25rem}
  .feature:last-child{margin-bottom:0}
  .feature-icon{font-size:1.4rem;line-height:1.6rem}
  .feature-title{font-weight:600;font-size:.95rem;color:#fff;margin-bottom:.15rem}
  .feature-desc{color:#9aa4c2;font-size:.85rem;line-height:1.45}
  a.btn{display:block;text-decoration:none;padding:1rem 1.4rem;border-radius:.7rem;
        font-weight:600;font-size:1rem;text-align:center;max-width:28rem;width:100%;
        background:#5b8def;color:#fff;transition:opacity .15s}
  a.btn:active{opacity:.75}
  .platform-note{color:#7c8bb0;font-size:.8rem;text-align:center}
  footer{color:#525a72;font-size:.78rem;letter-spacing:.02em;margin-top:auto}
</style></head><body>
<div class="hero">
  <h1>HFAC</h1>
  <p class="tagline">High Fidelity Audio Calls — internet calling on the media
  audio channel, not the muffled voice-call one.</p>
</div>
<div class="card">${featureHtml}</div>
<a class="btn" href="${APK_DOWNLOAD_URL}">⬇ Download HFAC for Android</a>
<p class="platform-note">Android only, for now.</p>
<footer>Powered by Nightfury</footer>
</body></html>`;
}

// ---------------------------------------------------------------------------
// ICE configuration (/ice): STUN always; TURN when configured.
//
// The app fetches this at call start so TURN credentials are never baked into
// the APK and can be rotated server-side. Two TURN sources are supported:
//   - Metered (managed):  METERED_DOMAIN + METERED_API_KEY  -> fetched and
//     cached briefly (Metered issues expiring credentials)
//   - Static (e.g. own coturn): TURN_URLS (comma-separated) + TURN_USERNAME +
//     TURN_CREDENTIAL
// ---------------------------------------------------------------------------

const STUN_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];
const ICE_CACHE_MS = 10 * 60_000;
let iceCache = { at: 0, servers: null };

async function iceServers() {
  const { METERED_DOMAIN, METERED_API_KEY, TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL } =
    process.env;

  if (METERED_DOMAIN && METERED_API_KEY) {
    const now = Date.now();
    if (iceCache.servers && now - iceCache.at < ICE_CACHE_MS) return iceCache.servers;
    const resp = await fetch(
      `https://${METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`
    );
    if (!resp.ok) throw new Error(`metered credentials: HTTP ${resp.status}`);
    const body = await resp.json();
    const turn = Array.isArray(body) ? body : body.iceServers || [];
    iceCache = { at: now, servers: [...STUN_SERVERS, ...turn] };
    return iceCache.servers;
  }

  if (TURN_URLS) {
    return [
      ...STUN_SERVERS,
      { urls: TURN_URLS.split(','), username: TURN_USERNAME, credential: TURN_CREDENTIAL },
    ];
  }

  return STUN_SERVERS;
}

// TEMPORARY - booleans only, never echoes secret values back over HTTP.
// Remove once the Metered dynamic-credentials path is confirmed working.
let lastIceError = null;
function iceDebugInfo() {
  const { METERED_DOMAIN, METERED_API_KEY, TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL } =
    process.env;
  return {
    hasMeteredDomain: Boolean(METERED_DOMAIN),
    hasMeteredApiKey: Boolean(METERED_API_KEY),
    hasTurnUrls: Boolean(TURN_URLS),
    hasTurnUsername: Boolean(TURN_USERNAME),
    hasTurnCredential: Boolean(TURN_CREDENTIAL),
    lastError: lastIceError,
  };
}

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const joinMatch = url.pathname.match(/^\/j\/(\d{8})$/);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(invitePage());
  } else if (joinMatch) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(joinPage(joinMatch[1]));
  } else if (url.pathname === '/ice') {
    iceServers()
      .then((servers) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        const body = { iceServers: servers };
        if (url.searchParams.has('debug')) body.debug = iceDebugInfo();
        res.end(JSON.stringify(body));
      })
      .catch((err) => {
        lastIceError = `${new Date().toISOString()} ${err.message}`;
        console.error('ice config error:', err.message);
        // Degrade to STUN-only rather than failing the call attempt.
        res.writeHead(200, { 'content-type': 'application/json' });
        const body = { iceServers: STUN_SERVERS };
        if (url.searchParams.has('debug')) body.debug = iceDebugInfo();
        res.end(JSON.stringify(body));
      });
  } else if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

// ---------------------------------------------------------------------------
// WebSocket signaling
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  maxPayload: MAX_PAYLOAD_BYTES,
});

wss.on('connection', (ws, req) => {
  ws.clientId = String(nextClientId++);
  ws.room = null;
  ws.isAlive = true;
  ws.ip = clientIp(req);
  ws.msgTimes = [];

  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (raw) => {
    if (!allow(ws.msgTimes, MSG_LIMIT)) {
      ws.close(4001, 'message rate exceeded');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, { type: 'error', reason: 'invalid JSON' });
    }
    try {
      handleMessage(ws, msg);
    } catch (err) {
      console.error('handler error:', err);
      send(ws, { type: 'error', reason: 'internal error' });
    }
  });
  ws.on('close', () => leaveRoom(ws));
});

// Drop dead connections so rooms don't fill up with ghosts.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

httpServer.listen(PORT, () => {
  console.log(`HFAC signaling server on :${PORT}`);
  console.log(`  ws endpoint:   ws://<host>:${PORT}/ws`);
  console.log(`  join pages:    http://<host>:${PORT}/j/<code>`);
});
