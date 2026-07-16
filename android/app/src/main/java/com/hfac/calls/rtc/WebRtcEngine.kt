package com.hfac.calls.rtc

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaRecorder
import android.util.Log
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.audio.JavaAudioDeviceModule
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Full-mesh WebRTC audio engine whose entire point is to keep call audio on the
 * MEDIA path instead of Android's voice-call path:
 *
 *  - Playback: [JavaAudioDeviceModule] is built with AudioAttributes(USAGE_MEDIA),
 *    so remote audio comes out of an ordinary media AudioTrack (STREAM_MUSIC).
 *    With Bluetooth earphones that means A2DP — full quality — instead of SCO.
 *  - Capture: MediaRecorder.AudioSource.MIC (not VOICE_COMMUNICATION), so no
 *    voice-call preprocessing chain, and since A2DP has no microphone channel,
 *    input stays on the phone's built-in mic (or the wired headset's mic).
 *  - We never touch AudioManager.mode / startBluetoothSco anywhere in the app.
 *  - Hardware AEC/NS are disabled: they are tied to the voice-comm session and
 *    unreliable outside it. WebRTC's software AEC3/NS run instead (unless Hi-Fi
 *    mode turns processing off entirely).
 *
 * Negotiation model (glare-free): the *newcomer* to a room creates the offer to
 * every existing peer; existing peers only ever answer.
 */
class WebRtcEngine(
    context: Context,
    private val hiFi: Boolean,
    private val listener: Listener,
) {
    interface Listener {
        /** Send a signaling payload to one peer (relayed by the server). */
        fun onSignalOut(peerId: String, payload: JSONObject)
        fun onPeerConnected(peerId: String)
        fun onPeerDisconnected(peerId: String)
    }

    private val executor = Executors.newSingleThreadExecutor()
    private val factory: PeerConnectionFactory
    private val audioSource: AudioSource
    private val localTrack: AudioTrack

    private class PeerLink(val pc: PeerConnection) {
        val pendingCandidates = mutableListOf<IceCandidate>()
        var remoteSet = false
    }

    private val peers = ConcurrentHashMap<String, PeerLink>()

    init {
        val mediaAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()

        val adm = JavaAudioDeviceModule.builder(context)
            .setAudioAttributes(mediaAttributes)
            .setAudioSource(MediaRecorder.AudioSource.MIC)
            .setSampleRate(48000)
            .setUseHardwareAcousticEchoCanceler(false)
            .setUseHardwareNoiseSuppressor(false)
            .setUseStereoOutput(true)
            .createAudioDeviceModule()

        factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(adm)
            .createPeerConnectionFactory()
        adm.release()

        val constraints = MediaConstraints()
        if (hiFi) {
            // Raw microphone: for headset use only (no acoustic feedback path).
            for (key in listOf(
                "googEchoCancellation", "echoCancellation",
                "googNoiseSuppression", "noiseSuppression",
                "googAutoGainControl", "autoGainControl",
                "googHighpassFilter",
            )) {
                constraints.mandatory.add(MediaConstraints.KeyValuePair(key, "false"))
            }
        }
        audioSource = factory.createAudioSource(constraints)
        localTrack = factory.createAudioTrack("hfac_audio", audioSource)
    }

    // ------------------------------------------------------------------ API

    /** We just joined: initiate a connection (send the offer) to an existing peer. */
    fun connectToPeer(peerId: String) = executor.execute {
        val link = getOrCreateLink(peerId) ?: return@execute
        link.pc.createOffer(object : SdpObserverAdapter() {
            override fun onCreateSuccess(desc: SessionDescription) {
                setLocalAndSend(peerId, link.pc, desc)
            }
        }, MediaConstraints())
    }

    fun handleSignal(fromPeer: String, payload: JSONObject) = executor.execute {
        when (payload.optString("kind")) {
            "offer" -> handleOffer(fromPeer, payload.getString("sdp"))
            "answer" -> handleAnswer(fromPeer, payload.getString("sdp"))
            "candidate" -> handleCandidate(fromPeer, payload)
            else -> Log.w(TAG, "unknown signal kind from $fromPeer")
        }
    }

    fun removePeer(peerId: String) = executor.execute {
        peers.remove(peerId)?.pc?.close()
    }

    fun setMuted(muted: Boolean) {
        localTrack.setEnabled(!muted)
    }

    fun close() = executor.execute {
        peers.values.forEach { it.pc.close() }
        peers.clear()
        localTrack.dispose()
        audioSource.dispose()
        factory.dispose()
        executor.shutdown()
    }

    // ---------------------------------------------------------- negotiation

    private fun handleOffer(fromPeer: String, sdp: String) {
        val link = getOrCreateLink(fromPeer) ?: return
        val remote = SessionDescription(SessionDescription.Type.OFFER, sdp)
        link.pc.setRemoteDescription(object : SdpObserverAdapter() {
            override fun onSetSuccess() = executor.execute {
                markRemoteSet(link)
                link.pc.createAnswer(object : SdpObserverAdapter() {
                    override fun onCreateSuccess(desc: SessionDescription) {
                        setLocalAndSend(fromPeer, link.pc, desc)
                    }
                }, MediaConstraints())
            }
        }, remote)
    }

    private fun handleAnswer(fromPeer: String, sdp: String) {
        val link = peers[fromPeer] ?: return
        val remote = SessionDescription(SessionDescription.Type.ANSWER, sdp)
        link.pc.setRemoteDescription(object : SdpObserverAdapter() {
            override fun onSetSuccess() = executor.execute { markRemoteSet(link) }
        }, remote)
    }

    private fun handleCandidate(fromPeer: String, payload: JSONObject) {
        val link = peers[fromPeer] ?: return
        val candidate = IceCandidate(
            payload.getString("sdpMid"),
            payload.getInt("sdpMLineIndex"),
            payload.getString("candidate"),
        )
        if (link.remoteSet) link.pc.addIceCandidate(candidate)
        else link.pendingCandidates += candidate
    }

    private fun markRemoteSet(link: PeerLink) {
        link.remoteSet = true
        link.pendingCandidates.forEach { link.pc.addIceCandidate(it) }
        link.pendingCandidates.clear()
    }

    /** Munge our SDP for quality, set it locally, cap the encoder, send it out. */
    private fun setLocalAndSend(peerId: String, pc: PeerConnection, desc: SessionDescription) {
        val tuned = SessionDescription(desc.type, tuneOpusForQuality(desc.description))
        pc.setLocalDescription(object : SdpObserverAdapter() {
            override fun onSetSuccess() = executor.execute {
                applySenderBitrate(pc)
                listener.onSignalOut(peerId, JSONObject().apply {
                    put("kind", if (tuned.type == SessionDescription.Type.OFFER) "offer" else "answer")
                    put("sdp", tuned.description)
                })
            }
        }, tuned)
    }

    private fun getOrCreateLink(peerId: String): PeerLink? {
        peers[peerId]?.let { return it }

        val config = PeerConnection.RTCConfiguration(ICE_SERVERS).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val pc = factory.createPeerConnection(config, object : PeerConnectionObserverAdapter() {
            override fun onIceCandidate(candidate: IceCandidate) {
                listener.onSignalOut(peerId, JSONObject().apply {
                    put("kind", "candidate")
                    put("candidate", candidate.sdp)
                    put("sdpMid", candidate.sdpMid)
                    put("sdpMLineIndex", candidate.sdpMLineIndex)
                })
            }

            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                when (newState) {
                    PeerConnection.PeerConnectionState.CONNECTED ->
                        listener.onPeerConnected(peerId)
                    PeerConnection.PeerConnectionState.DISCONNECTED,
                    PeerConnection.PeerConnectionState.FAILED,
                    PeerConnection.PeerConnectionState.CLOSED ->
                        listener.onPeerDisconnected(peerId)
                    else -> Unit
                }
            }
        }) ?: run {
            Log.e(TAG, "createPeerConnection returned null for $peerId")
            return null
        }

        pc.addTrack(localTrack, listOf("hfac_stream"))
        val link = PeerLink(pc)
        peers[peerId] = link
        return link
    }

    private fun applySenderBitrate(pc: PeerConnection) {
        for (sender in pc.senders) {
            val params = sender.parameters
            var changed = false
            for (enc in params.encodings) {
                enc.maxBitrateBps = TARGET_BITRATE_BPS
                changed = true
            }
            if (changed) sender.parameters = params
        }
    }

    companion object {
        private const val TAG = "WebRtcEngine"
        private const val TARGET_BITRATE_BPS = 128_000

        private val ICE_SERVERS = listOf(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
            PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer(),
            // Add a TURN server here for symmetric-NAT traversal if needed.
        )

        /**
         * Rewrites the Opus fmtp line for maximum quality: 48 kHz fullband,
         * FEC on, DTX off (constant flow beats artifacts on a good connection),
         * stereo playback allowed, and a 128 kbps average-bitrate ceiling
         * (Opus is transparent for speech way below this).
         *
         * fmtp parameters describe what *we* want to receive; both ends run
         * this app, so both directions get tuned.
         */
        fun tuneOpusForQuality(sdp: String): String {
            val lines = sdp.split("\r\n").toMutableList()
            val rtpmapIdx = lines.indexOfFirst { it.startsWith("a=rtpmap:") && it.contains("opus/48000") }
            if (rtpmapIdx < 0) return sdp
            val payloadType = lines[rtpmapIdx].removePrefix("a=rtpmap:").substringBefore(' ')

            val fmtpPrefix = "a=fmtp:$payloadType "
            val tunedParams = "minptime=10;useinbandfec=1;usedtx=0;stereo=1;sprop-stereo=1;" +
                "maxplaybackrate=48000;maxaveragebitrate=$TARGET_BITRATE_BPS"

            val fmtpIdx = lines.indexOfFirst { it.startsWith(fmtpPrefix) }
            if (fmtpIdx >= 0) lines[fmtpIdx] = fmtpPrefix + tunedParams
            else lines.add(rtpmapIdx + 1, fmtpPrefix + tunedParams)
            return lines.joinToString("\r\n")
        }
    }
}

/** SdpObserver with no-op defaults so call sites override only what they need. */
open class SdpObserverAdapter : SdpObserver {
    override fun onCreateSuccess(desc: SessionDescription) {}
    override fun onSetSuccess() {}
    override fun onCreateFailure(error: String?) {
        Log.e("WebRtcEngine", "SDP create failure: $error")
    }
    override fun onSetFailure(error: String?) {
        Log.e("WebRtcEngine", "SDP set failure: $error")
    }
}

/** PeerConnection.Observer with no-op defaults. */
open class PeerConnectionObserverAdapter : PeerConnection.Observer {
    override fun onSignalingChange(state: PeerConnection.SignalingState) {}
    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {}
    override fun onIceConnectionReceivingChange(receiving: Boolean) {}
    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
    override fun onIceCandidate(candidate: IceCandidate) {}
    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
    override fun onAddStream(stream: MediaStream) {}
    override fun onRemoveStream(stream: MediaStream) {}
    override fun onDataChannel(channel: DataChannel) {}
    override fun onRenegotiationNeeded() {}
    override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {}
}
