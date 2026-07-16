package com.hfac.calls

import android.app.Application
import org.webrtc.PeerConnectionFactory

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(this)
                .setEnableInternalTracer(false)
                .createInitializationOptions()
        )
    }
}
