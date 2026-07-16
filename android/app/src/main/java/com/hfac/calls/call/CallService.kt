package com.hfac.calls.call

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.hfac.calls.R
import com.hfac.calls.ui.CallActivity

/**
 * Foreground service that keeps the mic + playback alive while the call is
 * backgrounded. Holds no call logic — CallActivity owns the engine.
 */
class CallService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val code = intent?.getStringExtra(EXTRA_CODE) ?: ""
        val notification = buildNotification(code)
        when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.R -> startForeground(
                NOTIF_ID, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            )
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> startForeground(
                NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            )
            else -> startForeground(NOTIF_ID, notification)
        }
        return START_NOT_STICKY
    }

    private fun buildNotification(code: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    getString(R.string.notif_channel),
                    NotificationManager.IMPORTANCE_LOW
                )
            )
        }
        val tapIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, CallActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(getString(R.string.notif_title))
            .setContentText(getString(R.string.notif_text, code))
            .setContentIntent(tapIntent)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "ongoing_call"
        private const val NOTIF_ID = 41
        const val EXTRA_CODE = "code"

        fun start(context: Context, code: String) {
            context.startForegroundService(
                Intent(context, CallService::class.java).putExtra(EXTRA_CODE, code)
            )
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CallService::class.java))
        }
    }
}
