package com.hfac.calls.util

import org.json.JSONArray
import org.webrtc.PeerConnection

/**
 * ICE server config (STUN + TURN credentials) arrives inline in the
 * signaling server's 'created'/'joined' WebSocket responses — see
 * [com.hfac.calls.signaling.SignalingClient] — rather than a standalone
 * HTTP endpoint, so getting a set of TURN credentials requires actually
 * creating or joining a room and is covered by the server's room rate
 * limits. This object just parses that payload and provides a STUN-only
 * fallback for when it's missing or malformed.
 */
object IceConfig {

    val FALLBACK: List<PeerConnection.IceServer> = listOf(
        PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
        PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer(),
    )

    fun parse(arr: JSONArray): List<PeerConnection.IceServer> {
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
        return result.ifEmpty { FALLBACK }
    }
}
