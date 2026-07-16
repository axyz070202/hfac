package com.hfac.mediacall.util

import android.content.Context

/** Tiny settings store: signaling server URL + display name + Hi-Fi flag. */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("mediacall", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = sp.getString("serverUrl", "") ?: ""
        set(v) = sp.edit().putString("serverUrl", v.trim()).apply()

    var displayName: String
        get() = sp.getString("displayName", "") ?: ""
        set(v) = sp.edit().putString("displayName", v.trim()).apply()

    var hiFi: Boolean
        get() = sp.getBoolean("hiFi", false)
        set(v) = sp.edit().putBoolean("hiFi", v).apply()

    companion object {
        /**
         * Normalizes whatever the user typed into a ws(s) signaling URL ending in /ws.
         * Accepts "host:8787", "http://host:8787", "ws://host:8787", with/without /ws.
         */
        fun toWsUrl(raw: String): String {
            var u = raw.trim().trimEnd('/')
            u = when {
                u.startsWith("https://") -> "wss://" + u.removePrefix("https://")
                u.startsWith("http://") -> "ws://" + u.removePrefix("http://")
                u.startsWith("ws://") || u.startsWith("wss://") -> u
                else -> "ws://$u"
            }
            if (!u.endsWith("/ws")) u += "/ws"
            return u
        }

        /** ws(s)://host:port/ws  ->  http(s)://host:port  (base for share links). */
        fun toHttpBase(raw: String): String {
            val ws = toWsUrl(raw).removeSuffix("/ws")
            return when {
                ws.startsWith("wss://") -> "https://" + ws.removePrefix("wss://")
                else -> "http://" + ws.removePrefix("ws://")
            }
        }
    }
}
