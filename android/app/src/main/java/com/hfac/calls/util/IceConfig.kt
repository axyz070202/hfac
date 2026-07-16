package com.hfac.calls.util

import android.util.Log
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.PeerConnection
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Fetches ICE server config (STUN + TURN credentials) from the signaling
 * server's /ice endpoint. TURN credentials are short-lived and delivered by
 * the server, never baked into the APK. Falls back to public STUN on any
 * failure so calls still attempt.
 */
object IceConfig {

    val FALLBACK: List<PeerConnection.IceServer> = listOf(
        PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
        PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer(),
    )

    private val client = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(4, TimeUnit.SECONDS)
        .build()

    /** Calls [onResult] (on an OkHttp thread) with fetched servers or [FALLBACK]. */
    fun fetch(httpBase: String, onResult: (List<PeerConnection.IceServer>) -> Unit) {
        val request = Request.Builder().url("$httpBase/ice").build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                Log.w(TAG, "ice fetch failed, using STUN fallback: ${e.message}")
                onResult(FALLBACK)
            }

            override fun onResponse(call: Call, response: Response) {
                val servers = try {
                    response.use { parse(it.body?.string() ?: "") }
                } catch (e: Exception) {
                    Log.w(TAG, "ice parse failed, using STUN fallback", e)
                    FALLBACK
                }
                onResult(servers.ifEmpty { FALLBACK })
            }
        })
    }

    private fun parse(json: String): List<PeerConnection.IceServer> {
        val arr = JSONObject(json).getJSONArray("iceServers")
        val result = mutableListOf<PeerConnection.IceServer>()
        for (i in 0 until arr.length()) {
            val entry = arr.getJSONObject(i)
            val urls = when (val u = entry.get("urls")) {
                is JSONArray -> (0 until u.length()).map { u.getString(it) }
                else -> listOf(u.toString())
            }
            val builder = PeerConnection.IceServer.builder(urls)
            entry.optString("username").takeIf { it.isNotEmpty() }?.let { builder.setUsername(it) }
            entry.optString("credential").takeIf { it.isNotEmpty() }?.let { builder.setPassword(it) }
            result += builder.createIceServer()
        }
        return result
    }

    private const val TAG = "IceConfig"
}
