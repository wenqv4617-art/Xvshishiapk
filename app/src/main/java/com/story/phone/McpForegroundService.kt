package com.story.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

class McpForegroundService : Service() {

    companion object {
        private const val TAG = "McpForegroundService"
        private const val CHANNEL_ID = "mcp_foreground_service_channel"
        private const val NOTIFICATION_ID = 9001
    }

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "onCreate() called")
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(TAG, "onStartCommand() called")
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        Log.d(TAG, "onDestroy() called")
    }

    override fun onBind(intent: Intent?): IBinder? {
        return null
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            var channel = manager.getNotificationChannel(CHANNEL_ID)
            if (channel == null) {
                channel = NotificationChannel(
                    CHANNEL_ID,
                    "叙事诗保活服务",
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = "保证叙事诗小手机后台心跳定时发信稳定运行"
                }
                manager.createNotificationChannel(channel)
            }
        }
    }

    private fun buildNotification(): Notification {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = android.app.PendingIntent.getActivity(
            this, 0, intent,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
            } else {
                android.app.PendingIntent.FLAG_UPDATE_CURRENT
            }
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("叙事诗后台守护中")
            .setContentText("已打通真机特权神经，后台心跳保活就绪")
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build()
    }
}