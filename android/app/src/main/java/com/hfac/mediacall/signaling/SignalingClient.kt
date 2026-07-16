package com.hfac.mediacall.signaling

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Thin JSON-over-WebSocket client for the MediaCall signaling server.
 * Callbacks arrive on OkHttp's background thread — marshal to the main
 * thread in the UI layer.
 */
class SignalingClient(
    private val wsUrl: String,
    private val listener: Listener,
) {
    interface Listener {
        fun onOpen()
        fun onCreated(code: String, mode: String, selfId: String)
        fun onJoined(code: String, mode: String, selfId: String, peers: List<Pair<String, String>>)
        fun onPeerJoined(id: String, name: String)
        fun onPeerLeft(id: String)
        fun onSignal(from: String, data: JSONObject)
        fun onError(reason: String)
        fun onClosed()
    }

    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private var socket: WebSocket? = null

    fun connect() {
        val request = Request.Builder().url(wsUrl).build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = listener.onOpen()

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = try {
                    JSONObject(text)
                } catch (e: Exception) {
                    Log.w(TAG, "bad message: $text"); return
                }
                when (msg.optString("type")) {
                    "created" -> listener.onCreated(
                        msg.getString("code"), msg.getString("mode"), msg.getString("selfId"))
                    "joined" -> {
                        val peersJson = msg.getJSONArray("peers")
                        val peers = (0 until peersJson.length()).map { i ->
                            val p = peersJson.getJSONObject(i)
                            p.getString("id") to p.optString("name", "Guest")
                        }
                        listener.onJoined(
                            msg.getString("code"), msg.getString("mode"),
                            msg.getString("selfId"), peers)
                    }
                    "peer-joined" -> listener.onPeerJoined(
                        msg.getString("id"), msg.optString("name", "Guest"))
                    "peer-left" -> listener.onPeerLeft(msg.getString("id"))
                    "signal" -> listener.onSignal(
                        msg.getString("from"), msg.getJSONObject("data"))
                    "error" -> listener.onError(msg.optString("reason", "unknown error"))
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "ws failure", t)
                listener.onError(t.message ?: "connection failed")
                listener.onClosed()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) =
                listener.onClosed()
        })
    }

    fun createRoom(mode: String, name: String) = send(JSONObject()
        .put("type", "create").put("mode", mode).put("name", name))

    fun joinRoom(code: String, name: String) = send(JSONObject()
        .put("type", "join").put("code", code).put("name", name))

    fun signal(to: String, data: JSONObject) = send(JSONObject()
        .put("type", "signal").put("to", to).put("data", data))

    fun leave() {
        send(JSONObject().put("type", "leave"))
        socket?.close(1000, "bye")
        socket = null
    }

    private fun send(obj: JSONObject) {
        socket?.send(obj.toString())
    }

    companion object {
        private const val TAG = "SignalingClient"
    }
}
