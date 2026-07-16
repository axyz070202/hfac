package com.hfac.mediacall.ui

import android.content.Context
import android.content.Intent

/** Builders for launching CallActivity in create/join mode. */
object CallIntent {
    const val EXTRA_SERVER = "server"
    const val EXTRA_NAME = "name"
    const val EXTRA_HIFI = "hifi"
    const val EXTRA_MODE = "mode" // create: "duo" | "group"
    const val EXTRA_CODE = "code" // join: 8-digit code

    data class Base(
        val context: Context,
        val server: String,
        val name: String,
        val hiFi: Boolean,
    )

    private fun base(b: Base) = Intent(b.context, CallActivity::class.java)
        .putExtra(EXTRA_SERVER, b.server)
        .putExtra(EXTRA_NAME, b.name)
        .putExtra(EXTRA_HIFI, b.hiFi)

    fun create(b: Base, mode: String): Intent = base(b).putExtra(EXTRA_MODE, mode)

    fun join(b: Base, code: String): Intent = base(b).putExtra(EXTRA_CODE, code)
}
