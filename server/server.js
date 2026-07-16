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

/** @type {Map<string, Room>} code -> room */
const rooms = new Map();

let nextClientId = 1;

class Room {
  constructor(code, mode) {
    this.code = code;
    this.mode = mode; // 'duo' | 'group'
    /** @type {Map<string, import('ws').WebSocket>} clientId -> socket */
    this.members = new Map();
    /** @type {Map<string, string>} clientId -> display name */
    this.names = new Map();
  }

  get capacity() {
    return this.mode === 'duo' ? 2 : MAX_GROUP;
  }
}

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

function joinPage(code) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join HFAC room</title>
<style>
  body{font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;
       justify-content:center;min-height:90vh;gap:1rem;background:#111;color:#eee;margin:0}
  .code{font-size:2.5rem;letter-spacing:.35rem;font-weight:700}
  a.btn{background:#4c8bf5;color:#fff;text-decoration:none;padding:.8rem 1.6rem;border-radius:.6rem}
  p{color:#999;max-width:26rem;text-align:center;padding:0 1rem}
</style></head><body>
<div>HFAC room code</div>
<div class="code">${code}</div>
<a class="btn" href="hfac://join/${code}">Open in HFAC app</a>
<p>If nothing happens, open the HFAC app and enter the code manually,
or scan this page's QR code from inside the app.</p>
</body></html>`;
}

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const joinMatch = url.pathname.match(/^\/j\/(\d{8})$/);
  if (joinMatch) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(joinPage(joinMatch[1]));
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

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  ws.clientId = String(nextClientId++);
  ws.room = null;
  ws.isAlive = true;

  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (raw) => {
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
