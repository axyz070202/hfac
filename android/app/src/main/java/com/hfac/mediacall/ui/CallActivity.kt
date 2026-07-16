package com.hfac.mediacall.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.media.AudioManager
import android.os.Bundle
import android.view.WindowManager
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.hfac.mediacall.R
import com.hfac.mediacall.audio.AudioRouter
import com.hfac.mediacall.call.CallService
import com.hfac.mediacall.rtc.WebRtcEngine
import com.hfac.mediacall.signaling.SignalingClient
import com.hfac.mediacall.util.Prefs
import com.hfac.mediacall.util.QrCode
import org.json.JSONObject

class CallActivity : AppCompatActivity(), SignalingClient.Listener, WebRtcEngine.Listener {

    private lateinit var signaling: SignalingClient
    private lateinit var engine: WebRtcEngine
    private lateinit var audioRouter: AudioRouter

    private lateinit var roomTitle: TextView
    private lateinit var routeStatus: TextView
    private lateinit var participantList: LinearLayout
    private lateinit var btnMute: Button

    private var roomCode: String? = null
    private var shareLink: String? = null
    private var muted = false
    private var leaving = false

    /** peerId -> display name; also drives the participant list UI. */
    private val participants = LinkedHashMap<String, String>()
    private val connectedPeers = mutableSetOf<String>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_call)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // Hardware volume keys control the media stream — that's where call audio lives.
        volumeControlStream = AudioManager.STREAM_MUSIC

        roomTitle = findViewById(R.id.roomTitle)
        routeStatus = findViewById(R.id.routeStatus)
        participantList = findViewById(R.id.participantList)
        btnMute = findViewById(R.id.btnMute)

        val server = intent.getStringExtra(CallIntent.EXTRA_SERVER) ?: return finish()
        val name = intent.getStringExtra(CallIntent.EXTRA_NAME) ?: "Guest"
        val hiFi = intent.getBooleanExtra(CallIntent.EXTRA_HIFI, false)
        val createMode = intent.getStringExtra(CallIntent.EXTRA_MODE)
        val joinCode = intent.getStringExtra(CallIntent.EXTRA_CODE)

        engine = WebRtcEngine(applicationContext, hiFi, this)
        audioRouter = AudioRouter(applicationContext) { resId ->
            runOnUiThread { routeStatus.text = getString(resId) }
        }
        audioRouter.start()

        signaling = SignalingClient(Prefs.toWsUrl(server), this)
        val httpBase = Prefs.toHttpBase(server)

        // Once connected, either create or join.
        pendingOnOpen = {
            if (createMode != null) signaling.createRoom(createMode, name)
            else signaling.joinRoom(joinCode ?: "", name)
        }
        shareBaseUrl = httpBase
        signaling.connect()

        findViewById<Button>(R.id.btnShare).setOnClickListener { shareRoom() }
        findViewById<Button>(R.id.btnQr).setOnClickListener { showQr() }
        findViewById<Button>(R.id.btnCopy).setOnClickListener { copyCode() }
        btnMute.setOnClickListener { toggleMute() }
        findViewById<Button>(R.id.btnLeave).setOnClickListener { finish() }
    }

    private var pendingOnOpen: (() -> Unit)? = null
    private var shareBaseUrl: String = ""

    // ------------------------------------------------------------ signaling

    override fun onOpen() {
        runOnUiThread { pendingOnOpen?.invoke(); pendingOnOpen = null }
    }

    override fun onCreated(code: String, mode: String, selfId: String) {
        runOnUiThread { onRoomEntered(code) }
    }

    override fun onJoined(
        code: String, mode: String, selfId: String, peers: List<Pair<String, String>>,
    ) {
        runOnUiThread {
            onRoomEntered(code)
            // We are the newcomer: offer to every existing member.
            for ((id, peerName) in peers) {
                participants[id] = peerName
                engine.connectToPeer(id)
            }
            renderParticipants()
        }
    }

    private fun onRoomEntered(code: String) {
        roomCode = code
        shareLink = "$shareBaseUrl/j/$code"
        roomTitle.text = getString(R.string.room_code_label, code)
        CallService.start(this, code)
    }

    override fun onPeerJoined(id: String, name: String) {
        runOnUiThread {
            participants[id] = name
            renderParticipants()
            // The newcomer initiates; we just wait for their offer.
        }
    }

    override fun onPeerLeft(id: String) {
        engine.removePeer(id)
        runOnUiThread {
            participants.remove(id)
            connectedPeers.remove(id)
            renderParticipants()
        }
    }

    override fun onSignal(from: String, data: JSONObject) {
        engine.handleSignal(from, data)
    }

    override fun onError(reason: String) {
        runOnUiThread {
            if (!leaving) Toast.makeText(this, reason, Toast.LENGTH_LONG).show()
            if (roomCode == null) finish() // failed before entering a room
        }
    }

    override fun onClosed() {
        runOnUiThread { if (!leaving && !isFinishing) finish() }
    }

    // --------------------------------------------------------------- engine

    override fun onSignalOut(peerId: String, payload: JSONObject) {
        signaling.signal(peerId, payload)
    }

    override fun onPeerConnected(peerId: String) {
        runOnUiThread { connectedPeers.add(peerId); renderParticipants() }
    }

    override fun onPeerDisconnected(peerId: String) {
        runOnUiThread { connectedPeers.remove(peerId); renderParticipants() }
    }

    // ------------------------------------------------------------------- UI

    private fun renderParticipants() {
        participantList.removeAllViews()
        for ((id, name) in participants) {
            val row = TextView(this).apply {
                text = if (id in connectedPeers) "🔊  $name" else "⏳  $name"
                textSize = 18f
                setPadding(0, 12, 0, 12)
            }
            participantList.addView(row)
        }
    }

    private fun shareRoom() {
        val code = roomCode ?: return
        val link = shareLink ?: return
        startActivity(
            Intent.createChooser(
                Intent(Intent.ACTION_SEND)
                    .setType("text/plain")
                    .putExtra(Intent.EXTRA_TEXT, getString(R.string.share_message, code, link)),
                getString(R.string.share)
            )
        )
    }

    private fun showQr() {
        val link = shareLink ?: return
        val image = ImageView(this).apply {
            setImageBitmap(QrCode.encode(link))
            setPadding(48, 48, 48, 48)
        }
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.room_code_label, roomCode))
            .setView(image)
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }

    private fun copyCode() {
        val code = roomCode ?: return
        val cb = getSystemService(ClipboardManager::class.java)
        cb.setPrimaryClip(ClipData.newPlainText("MediaCall room code", code))
        Toast.makeText(this, R.string.code_copied, Toast.LENGTH_SHORT).show()
    }

    private fun toggleMute() {
        muted = !muted
        engine.setMuted(muted)
        btnMute.text = getString(if (muted) R.string.unmute else R.string.mute)
    }

    override fun onDestroy() {
        leaving = true
        audioRouter.stop()
        signaling.leave()
        engine.close()
        CallService.stop(this)
        super.onDestroy()
    }
}
