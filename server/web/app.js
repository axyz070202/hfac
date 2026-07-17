'use strict';

// HFAC web calling client. Ports the same protocol/behavior as the Android
// app (see android/app/src/main/java/com/hfac/calls/{signaling,rtc}/):
// same WS message shapes, same Opus SDP tuning, same safety-code derivation,
// same full-mesh (one RTCPeerConnection per peer) topology. Scoped to
// wired-headphone / speaker use — there is no browser API to control
// Bluetooth audio profile the way the Android app does, so this client does
// not attempt that.

const TARGET_BITRATE_BPS = 128000;

// ---------------------------------------------------------------------------
// Opus SDP tuning — same fmtp rewrite as WebRtcEngine.kt's tuneOpusForQuality.
// ---------------------------------------------------------------------------
function tuneOpusForQuality(sdp) {
  const lines = sdp.split('\r\n');
  const rtpmapIdx = lines.findIndex((l) => l.startsWith('a=rtpmap:') && l.includes('opus/48000'));
  if (rtpmapIdx < 0) return sdp;
  const pt = lines[rtpmapIdx].replace('a=rtpmap:', '').split(' ')[0];
  const fmtpPrefix = `a=fmtp:${pt} `;
  const params =
    'minptime=10;useinbandfec=1;usedtx=0;stereo=1;sprop-stereo=1;' +
    `maxplaybackrate=48000;maxaveragebitrate=${TARGET_BITRATE_BPS}`;
  const fmtpIdx = lines.findIndex((l) => l.startsWith(fmtpPrefix));
  if (fmtpIdx >= 0) lines[fmtpIdx] = fmtpPrefix + params;
  else lines.splice(rtpmapIdx + 1, 0, fmtpPrefix + params);
  return lines.join('\r\n');
}

function fingerprintOf(sdp) {
  const m = /a=fingerprint:\S+ ([0-9A-Fa-f:]+)/.exec(sdp || '');
  return m ? m[1].toUpperCase() : null;
}

// Same derivation as WebRtcEngine.kt's emitSafetyCode: SHA-256 over the
// sorted local+remote DTLS fingerprints. Matching codes on both ends rule
// out a signaling-layer man-in-the-middle.
async function safetyCodeFor(pc) {
  const local = fingerprintOf(pc.localDescription && pc.localDescription.sdp);
  const remote = fingerprintOf(pc.remoteDescription && pc.remoteDescription.sdp);
  if (!local || !remote) return null;
  const material = [local, remote].sort().join('|');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  const bytes = new Uint8Array(buf);
  const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');
  return `${hex(bytes[0])}${hex(bytes[1])}-${hex(bytes[2])}${hex(bytes[3])}`;
}

// ---------------------------------------------------------------------------
// Signaling: same WS protocol as SignalingClient.kt.
// ---------------------------------------------------------------------------
class Signaling {
  constructor() {
    this.ws = null;
    this.handlers = {};
  }

  on(type, fn) {
    this.handlers[type] = fn;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws.onopen = () => this.handlers.open && this.handlers.open();
    this.ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const fn = this.handlers[msg.type];
      if (fn) fn(msg);
    };
    this.ws.onclose = () => this.handlers.closed && this.handlers.closed();
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  createRoom(mode, name) {
    this.send({ type: 'create', mode, name });
  }

  joinRoom(code, name) {
    this.send({ type: 'join', code, name });
  }

  signal(to, data) {
    this.send({ type: 'signal', to, data });
  }

  leave() {
    this.send({ type: 'leave' });
    if (this.ws) this.ws.close();
  }
}

// ---------------------------------------------------------------------------
// Call engine: one RTCPeerConnection per peer (full mesh), mirrors
// WebRtcEngine.kt. The newcomer to a room always sends the offer; existing
// members only ever answer — same glare-free convention as the Android app.
// ---------------------------------------------------------------------------
class CallEngine {
  constructor({ iceServers, localTrack, onSignalOut, onConnected, onDisconnected, onSafetyCode }) {
    this.iceServers = iceServers;
    this.localTrack = localTrack;
    this.onSignalOut = onSignalOut;
    this.onConnected = onConnected;
    this.onDisconnected = onDisconnected;
    this.onSafetyCode = onSafetyCode;
    this.peers = new Map(); // id -> { pc, pending: RTCIceCandidate[], remoteSet }
  }

  getOrCreate(peerId) {
    let link = this.peers.get(peerId);
    if (link) return link;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    link = { pc, pending: [], remoteSet: false };
    this.peers.set(peerId, link);

    pc.addTrack(this.localTrack);

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      this.onSignalOut(peerId, {
        kind: 'candidate',
        candidate: e.candidate.candidate,
        sdpMid: e.candidate.sdpMid,
        sdpMLineIndex: e.candidate.sdpMLineIndex,
      });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        this.onConnected(peerId);
        safetyCodeFor(pc).then((code) => code && this.onSafetyCode(peerId, code));
      } else if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        this.onDisconnected(peerId);
      }
    };

    pc.ontrack = (e) => {
      let audio = document.querySelector(`audio[data-peer="${peerId}"]`);
      if (!audio) {
        audio = document.createElement('audio');
        audio.autoplay = true;
        audio.dataset.peer = peerId;
        document.getElementById('remoteAudios').appendChild(audio);
      }
      audio.srcObject = e.streams[0];
    };

    return link;
  }

  async connectToPeer(peerId) {
    const { pc } = this.getOrCreate(peerId);
    const offer = await pc.createOffer();
    const tuned = { type: offer.type, sdp: tuneOpusForQuality(offer.sdp) };
    await pc.setLocalDescription(tuned);
    this.onSignalOut(peerId, { kind: 'offer', sdp: tuned.sdp });
  }

  async handleSignal(fromPeer, payload) {
    const { pc } = this.getOrCreate(fromPeer);
    if (payload.kind === 'offer') {
      await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
      this.drainCandidates(fromPeer);
      const answer = await pc.createAnswer();
      const tuned = { type: answer.type, sdp: tuneOpusForQuality(answer.sdp) };
      await pc.setLocalDescription(tuned);
      this.onSignalOut(fromPeer, { kind: 'answer', sdp: tuned.sdp });
    } else if (payload.kind === 'answer') {
      await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
      this.drainCandidates(fromPeer);
    } else if (payload.kind === 'candidate') {
      const link = this.peers.get(fromPeer);
      if (!link) return;
      const candidate = new RTCIceCandidate({
        candidate: payload.candidate,
        sdpMid: payload.sdpMid,
        sdpMLineIndex: payload.sdpMLineIndex,
      });
      if (link.remoteSet) link.pc.addIceCandidate(candidate);
      else link.pending.push(candidate);
    }
  }

  drainCandidates(peerId) {
    const link = this.peers.get(peerId);
    link.remoteSet = true;
    link.pending.forEach((c) => link.pc.addIceCandidate(c));
    link.pending = [];
  }

  removePeer(peerId) {
    const link = this.peers.get(peerId);
    if (!link) return;
    link.pc.close();
    this.peers.delete(peerId);
    const audio = document.querySelector(`audio[data-peer="${peerId}"]`);
    if (audio) audio.remove();
  }

  setMuted(muted) {
    this.localTrack.enabled = !muted;
  }

  close() {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
  }
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
(function main() {
  const el = (id) => document.getElementById(id);

  const homeView = el('homeView');
  const callView = el('callView');
  const nameInput = el('nameInput');
  const hifiCheckbox = el('hifiCheckbox');
  const joinCodeInput = el('joinCodeInput');
  const statusText = el('statusText');
  const roomCodeText = el('roomCodeText');
  const participantList = el('participantList');
  const muteBtn = el('muteBtn');

  const params = new URLSearchParams(location.search);
  const prefillCode = params.get('code');
  if (prefillCode) joinCodeInput.value = prefillCode.replace(/\D/g, '').slice(0, 8);

  let signaling = null;
  let engine = null;
  let localStream = null;
  let roomCode = null;
  let muted = false;
  /** peerId -> { name, connected, safety } */
  const participants = new Map();

  function showStatus(msg) {
    statusText.textContent = msg;
  }

  function renderParticipants() {
    participantList.innerHTML = '';
    for (const [id, p] of participants) {
      const row = document.createElement('div');
      row.className = 'participant-row';
      const safety = p.safety ? ` · Safety ${p.safety}` : '';
      row.textContent = `${p.connected ? '🔊' : '⏳'}  ${p.name}${safety}`;
      participantList.appendChild(row);
    }
  }

  async function startCall(iceServers) {
    const constraints = hifiCheckbox.checked
      ? { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }
      : { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    const localTrack = localStream.getAudioTracks()[0];

    engine = new CallEngine({
      iceServers,
      localTrack,
      onSignalOut: (peerId, payload) => signaling.signal(peerId, payload),
      onConnected: (peerId) => {
        const p = participants.get(peerId);
        if (p) {
          p.connected = true;
          renderParticipants();
        }
      },
      onDisconnected: (peerId) => {
        const p = participants.get(peerId);
        if (p) {
          p.connected = false;
          renderParticipants();
        }
      },
      onSafetyCode: (peerId, code) => {
        const p = participants.get(peerId);
        if (p) {
          p.safety = code;
          renderParticipants();
        }
      },
    });
  }

  function enterRoom(code) {
    roomCode = code;
    roomCodeText.textContent = `Room ${code}`;
    homeView.classList.add('hidden');
    callView.classList.remove('hidden');
    showStatus('In call — keep this tab open and the screen on.');
    history.replaceState(null, '', `/call/?code=${code}`);
  }

  function shareLink() {
    return `${location.origin}/j/${roomCode}`;
  }

  el('createDuoBtn').addEventListener('click', () => create('duo'));
  el('createGroupBtn').addEventListener('click', () => create('group'));
  el('joinBtn').addEventListener('click', () => join());

  function name() {
    return nameInput.value.trim() || 'Guest';
  }

  function connectSignaling(onOpenAction) {
    signaling = new Signaling();
    signaling.on('open', onOpenAction);
    signaling.on('created', (msg) => {
      startCall(msg.iceServers).then(() => enterRoom(msg.code));
    });
    signaling.on('joined', (msg) => {
      startCall(msg.iceServers).then(() => {
        enterRoom(msg.code);
        for (const p of msg.peers) {
          participants.set(p.id, { name: p.name, connected: false, safety: null });
          engine.connectToPeer(p.id);
        }
        renderParticipants();
      });
    });
    signaling.on('peer-joined', (msg) => {
      participants.set(msg.id, { name: msg.name, connected: false, safety: null });
      renderParticipants();
    });
    signaling.on('peer-left', (msg) => {
      if (engine) engine.removePeer(msg.id);
      participants.delete(msg.id);
      renderParticipants();
    });
    signaling.on('signal', (msg) => {
      if (engine) engine.handleSignal(msg.from, msg.data);
    });
    signaling.on('error', (msg) => {
      showStatus(`Error: ${msg.reason}`);
      if (!roomCode) alert(msg.reason);
    });
    signaling.on('closed', () => {
      if (!roomCode) return;
      showStatus('Disconnected.');
    });
    signaling.connect();
  }

  function create(mode) {
    connectSignaling(() => signaling.createRoom(mode, name()));
  }

  function join() {
    const code = joinCodeInput.value.replace(/\D/g, '');
    if (code.length !== 8) {
      alert('Enter the 8-digit room code.');
      return;
    }
    connectSignaling(() => signaling.joinRoom(code, name()));
  }

  el('shareBtn').addEventListener('click', async () => {
    const text = `Join my HFAC room!\nCode: ${roomCode}\nLink: ${shareLink()}`;
    if (navigator.share) {
      navigator.share({ text }).catch(() => {});
    } else {
      await navigator.clipboard.writeText(text);
      alert('Copied to clipboard.');
    }
  });

  el('copyBtn').addEventListener('click', async () => {
    await navigator.clipboard.writeText(roomCode);
    alert('Code copied.');
  });

  muteBtn.addEventListener('click', () => {
    if (!engine) return;
    muted = !muted;
    engine.setMuted(muted);
    muteBtn.textContent = muted ? 'Unmute' : 'Mute';
  });

  el('leaveBtn').addEventListener('click', () => {
    if (signaling) signaling.leave();
    if (engine) engine.close();
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    location.href = '/call/';
  });

  window.addEventListener('beforeunload', () => {
    if (signaling) signaling.leave();
    if (engine) engine.close();
  });
})();
