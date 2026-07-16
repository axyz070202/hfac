# HFAC — internet calls on the media audio channel

Android voice calls normally run on the *voice communication* audio path
(`USAGE_VOICE_COMMUNICATION` / `MODE_IN_COMMUNICATION`). That path forces
Bluetooth into the low-quality SCO/HFP profile and applies aggressive,
narrowband-era processing. **HFAC** places internet (WebRTC) calls on the
**media** path (`USAGE_MEDIA`, `STREAM_MUSIC`) instead, so call audio gets the
same quality as music playback.

## How the audio routing works

| Peripheral | Output | Input | Notes |
|---|---|---|---|
| Wired / USB headset | Headset, media stream | Headset mic | Works by default — media audio and mic both route to the wired device. |
| Bluetooth earphones | **A2DP (media profile)** — full quality | **Phone's built-in mic** | We never start SCO and never enter `MODE_IN_COMMUNICATION`, so BT stays on A2DP. A2DP has no mic channel, so capture naturally falls back to the phone mic — exactly the intended split. |
| Nothing connected | Loudspeaker, media stream | Phone mic | Echo-prone; WebRTC's software AEC3 echo canceller is enabled to compensate. Quality of echo cancellation varies by device/volume. |

Key implementation points (see `android/app/src/main/java/com/hfac/calls/rtc/WebRtcEngine.kt`):

- `JavaAudioDeviceModule` is built with `AudioAttributes(USAGE_MEDIA)` → playback is an ordinary media `AudioTrack`.
- Capture uses `MediaRecorder.AudioSource.MIC` (not `VOICE_COMMUNICATION`), so no narrowband voice-call preprocessing.
- `AudioManager` stays in `MODE_NORMAL`; `startBluetoothSco()` is never called.
- Hardware AEC/NS are disabled in favour of WebRTC's software AEC3/NS, which work regardless of the audio path.
- Opus is tuned for quality via SDP: 48 kHz fullband, FEC on, DTX off, `maxaveragebitrate=128000`, and the RTP sender's max bitrate is raised to match.
- Optional **Hi-Fi mode** disables echo cancellation / noise suppression / AGC entirely — use only with a headset.

## Rooms

- **Duo room** — capped at exactly 2 participants.
- **Group room** — full-mesh audio, capped at 8 participants (mesh is the right topology for "best quality on a good connection": no SFU transcoding, direct peer links).

A room is created by one user and joined by others via any of:

1. **Link** — `http(s)://<server>/j/<code>` (the server serves a landing page with an "open in app" deep link `hfac://join/<code>`)
2. **QR code** — generated in-app (encodes the link), scannable in-app
3. **8-digit numeric code** — typed manually

## Repository layout

```
server/    Node.js WebSocket signaling server (rooms, codes, join page)
android/   Android app (Kotlin, libwebrtc)
```

## Running the signaling server

```bash
cd server
npm install
npm start            # listens on 0.0.0.0:8787 (PORT env var to change)
```

The server only relays signaling (SDP/ICE) — call audio flows peer-to-peer.

## Deploying to the internet (Render + Metered TURN)

1. **Render**: dashboard → New → Blueprint → point at this repo
   (`render.yaml` deploys `server/` as a free web service). Note the URL,
   e.g. `https://hfac-signaling.onrender.com`.
2. **Metered** (TURN relay for peers behind carrier-grade NAT): create a free
   account at metered.ca, create a TURN app, then set `METERED_DOMAIN`
   (e.g. `yourapp.metered.live`) and `METERED_API_KEY` in the Render service's
   environment. The server's `GET /ice` endpoint hands the app STUN + fresh
   TURN credentials at call time — nothing is baked into the APK.
   Alternatively point `TURN_URLS`/`TURN_USERNAME`/`TURN_CREDENTIAL` at your
   own coturn.
3. **Bake the server URL into the app**: set repo variable `HFAC_SERVER_URL`
   (GitHub → Settings → Secrets and variables → Actions → Variables) to the
   Render URL. CI passes it into every build; users never enter a URL.
   Local builds: `./gradlew assembleDebug -PHFAC_SERVER_URL=https://...`.

## Security model

- **Call audio is always end-to-end encrypted** (DTLS-SRTP, mandated by
  WebRTC). TURN relays and the signaling server carry only ciphertext.
- **Safety codes**: each peer link shows a short code derived from both ends'
  DTLS certificate fingerprints. Both sides seeing the same code rules out a
  man-in-the-middle at the signaling layer — compare it out loud for
  sensitive calls.
- **TLS**: release builds refuse cleartext; use `https://`/`wss://` servers.
  Debug builds allow `ws://` for LAN testing.
- **Abuse limits** (server): 10 join attempts/min and 20 room creations/hour
  per IP, 300 messages/10 s per connection, 64 KB max message, 500 active
  rooms, 12-hour room lifetime.
- **Room access = code possession** (like a meeting link). Codes are
  8 random digits; don't post them publicly.
- Peers in a call see each other's IP addresses (inherent to P2P).

## Building the app

Requirements: JDK 17, Android SDK (platform 35). `android/local.properties`
must point at the SDK (`sdk.dir=...`).

```bash
cd android
./gradlew assembleDebug
# APK: app/build/outputs/apk/debug/app-debug.apk
```

On first launch set the **server URL** (e.g. `ws://192.168.1.10:8787`) and a
display name, then create or join a room. Emulator talking to a server on the
host machine: use `ws://10.0.2.2:8787`.

## Known limitations

- Speaker + phone-mic (no peripheral) relies on software echo cancellation;
  results vary by device. A headset is recommended.
- Media-stream playback obeys the *media* volume, not the call volume.
- Bluetooth mics are intentionally unused (using them would force SCO and
  drop output quality — the whole thing this app avoids).
