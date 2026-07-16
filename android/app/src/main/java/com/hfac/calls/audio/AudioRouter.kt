package com.hfac.calls.audio

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import com.hfac.calls.R

/**
 * Watches audio peripherals and reports the effective route, WITHOUT ever
 * steering audio onto the voice-call path.
 *
 * Everything here is observational. The routing itself falls out of the
 * engine's configuration (USAGE_MEDIA playback + MIC capture) and Android's
 * default media routing rules:
 *
 *  - wired/USB headset plugged in  -> media out + mic in on the headset
 *  - Bluetooth connected           -> media out on A2DP; capture stays on the
 *                                     phone mic because A2DP has no mic channel
 *                                     and we never open SCO
 *  - nothing connected             -> loudspeaker + phone mic (software AEC)
 *
 * We also pin AudioManager to MODE_NORMAL: MODE_IN_COMMUNICATION is the switch
 * that drags Bluetooth onto SCO/HFP, which is exactly what this app avoids.
 */
class AudioRouter(
    context: Context,
    private val onRouteChanged: (routeResId: Int) -> Unit,
) {
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val handler = Handler(Looper.getMainLooper())

    private val callback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = report()
        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = report()
    }

    fun start() {
        // Never MODE_IN_COMMUNICATION — that flips Bluetooth to low-quality SCO.
        audioManager.mode = AudioManager.MODE_NORMAL
        audioManager.registerAudioDeviceCallback(callback, handler)
        report()
    }

    fun stop() {
        audioManager.unregisterAudioDeviceCallback(callback)
    }

    private fun report() {
        onRouteChanged(describeRoute())
    }

    fun describeRoute(): Int {
        val outputs = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        val types = outputs.map { it.type }.toSet()
        return when {
            AudioDeviceInfo.TYPE_WIRED_HEADSET in types ||
                AudioDeviceInfo.TYPE_WIRED_HEADPHONES in types -> R.string.route_wired
            AudioDeviceInfo.TYPE_USB_HEADSET in types ||
                AudioDeviceInfo.TYPE_USB_DEVICE in types -> R.string.route_usb
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP in types -> R.string.route_bt_a2dp
            else -> R.string.route_speaker
        }
    }
}
