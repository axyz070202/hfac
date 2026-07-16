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
For peers behind symmetric NATs add a TURN server to `ICE_SERVERS` in
`WebRtcEngine.kt` (STUN alone covers most home/mobile networks).

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
