// End-to-end smoke test for the signaling server: spawns the real server on a
// test port and drives it with real WebSocket clients.
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.TEST_PORT || 8791;
const BASE = `http://127.0.0.1:${PORT}`;

const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: { ...process.env, PORT },
});
srv.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
srv.stderr.on('data', (d) => process.stderr.write('[srv-err] ' + d));

const results = [];
const sockets = [];
function check(name, cond) {
  results.push([name, cond]);
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name);
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    sockets.push(ws);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    ws.msgs = [];
    ws.waiter = null;
    ws.on('message', (m) => {
      const obj = JSON.parse(m);
      if (ws.waiter) {
        const w = ws.waiter;
        ws.waiter = null;
        w(obj);
      } else {
        ws.msgs.push(obj);
      }
    });
    ws.next = () =>
      new Promise((r) => {
        if (ws.msgs.length) r(ws.msgs.shift());
        else ws.waiter = r;
      });
  });
}

async function main() {
  await new Promise((r) => setTimeout(r, 800)); // let the server boot

  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  check('health ok', health.ok === true);

  const a = await connect();
  a.send(JSON.stringify({ type: 'create', mode: 'duo', name: 'Alice' }));
  const created = await a.next();
  check('created with 8-digit code', created.type === 'created' && /^\d{8}$/.test(created.code));
  check('created includes ice servers',
    Array.isArray(created.iceServers) && created.iceServers.length > 0);

  const page = await fetch(`${BASE}/j/${created.code}`).then((r) => r.text());
  check('join page has code + deep link',
    page.includes(created.code) && page.includes('hfac://join/'));

  const b = await connect();
  b.send(JSON.stringify({ type: 'join', code: created.code, name: 'Bob' }));
  const joined = await b.next();
  check('joined with peer list',
    joined.type === 'joined' && joined.peers.length === 1 && joined.peers[0].name === 'Alice');

  const peerJoined = await a.next();
  check('creator notified of peer', peerJoined.type === 'peer-joined' && peerJoined.name === 'Bob');

  b.send(JSON.stringify({ type: 'signal', to: created.selfId, data: { sdp: 'fake-offer' } }));
  const sig = await a.next();
  check('signal relayed',
    sig.type === 'signal' && sig.data.sdp === 'fake-offer' && sig.from === joined.selfId);

  const c = await connect();
  c.send(JSON.stringify({ type: 'join', code: created.code, name: 'Carol' }));
  const full = await c.next();
  check('duo room rejects third member', full.type === 'error' && full.reason === 'room is full');

  const d = await connect();
  d.send(JSON.stringify({ type: 'join', code: '00000000', name: 'Nobody' }));
  const notFound = await d.next();
  check('unknown room rejected', notFound.type === 'error' && notFound.reason === 'room not found');

  const ice = await fetch(`${BASE}/ice`).then((r) => r.json());
  check('ice config returns servers', Array.isArray(ice.iceServers) && ice.iceServers.length > 0);

  // Hammer GET /ice until its own (separate, tighter) per-IP limiter trips.
  let iceLimited = false;
  for (let i = 0; i < 10 && !iceLimited; i++) {
    const r = await fetch(`${BASE}/ice`);
    iceLimited = r.status === 429;
  }
  check('GET /ice is rate limited', iceLimited);

  // Hammer join until the per-IP limiter trips (all test clients share one IP).
  const bot = await connect();
  let limited = false;
  for (let i = 0; i < 12 && !limited; i++) {
    bot.send(JSON.stringify({ type: 'join', code: '99999999', name: 'Bot' }));
    const r = await bot.next();
    limited = r.type === 'error' && /too many join attempts/.test(r.reason);
  }
  check('join attempts are rate limited', limited);

  return results.filter(([, ok]) => !ok).length;
}

main()
  .then((failures) => {
    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
    for (const ws of sockets) ws.close();
    srv.kill();
    // Give sockets/child a beat to tear down before exiting (avoids libuv
    // teardown assertions on Windows).
    setTimeout(() => process.exit(failures === 0 ? 0 : 1), 500);
  })
  .catch((err) => {
    console.error(err);
    srv.kill();
    setTimeout(() => process.exit(1), 500);
  });
