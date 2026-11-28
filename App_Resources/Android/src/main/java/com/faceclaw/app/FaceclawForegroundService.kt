package com.faceclaw.app

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

class FaceclawForegroundService : Service() {
    companion object {
        const val ACTION_START = "com.faceclaw.app.action.START"
        const val ACTION_UPDATE = "com.faceclaw.app.action.UPDATE"
        const val ACTION_STOP = "com.faceclaw.app.action.STOP"
        const val ACTION_NEURAL_BAND = "com.faceclaw.app.action.NEURAL_BAND"
        const val ACTION_NEURAL_BAND_DISABLED = "com.faceclaw.app.action.NEURAL_BAND_DISABLED"
        const val EXTRA_TEXT = "text"

        // Channel id was bumped from "faceclaw-dashboard" when the badge setting
        // changed: Android freezes a channel's showBadge flag at creation, so the
        // old channel (which let Samsung's launcher count the pinned notification
        // as a red "1" badge) is deleted on upgrade rather than reused.
        private const val LEGACY_CHANNEL_ID = "faceclaw-dashboard"
        private const val CHANNEL_ID = "faceclaw-connection"
        private const val NOTIFICATION_ID = 4201
    }

    private var servesGlasses = false

    override fun onBind(intent: Intent?): IBinder? {
        return null
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        val text = intent?.getStringExtra(EXTRA_TEXT)

        if (action == ACTION_STOP) servesGlasses = false
        if (action == ACTION_NEURAL_BAND_DISABLED && servesGlasses) return START_STICKY
        if ((action == ACTION_STOP || action == ACTION_NEURAL_BAND_DISABLED) &&
            !FaceclawNeuralBand.shouldRun(this)
        ) {
            FaceclawNeuralBand.foregroundStopped()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        if (action == ACTION_START || action == ACTION_UPDATE ||
            (action == null && !FaceclawNeuralBand.shouldRun(this))
        ) servesGlasses = true

        ensureNotificationChannel()
        val notification = buildNotification(
            if (!text.isNullOrBlank()) text
            else if (!servesGlasses) getString(R.string.neural_band_title)
            else "Connected to glasses"
        )

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, foregroundServiceType())
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        if (ACTION_UPDATE == action) {
            val manager = getSystemService(NotificationManager::class.java)
            manager?.notify(NOTIFICATION_ID, notification)
        }
        FaceclawNeuralBand.foregroundStarted(this)

        return START_STICKY
    }

    override fun onDestroy() {
        FaceclawNeuralBand.foregroundStopped()
        super.onDestroy()
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }

        val channel = NotificationChannel(
            CHANNEL_ID,
            "Glasses connection",
            NotificationManager.IMPORTANCE_LOW
        )
        channel.description = "Keeps Faceclaw connected to the glasses."
        // The pinned status notification must not count toward the launcher
        // icon's notification badge.
        channel.setShowBadge(false)

        val manager = getSystemService(NotificationManager::class.java)
        if (manager != null) {
            manager.createNotificationChannel(channel)
            manager.deleteNotificationChannel(LEGACY_CHANNEL_ID)
        }
    }

    private fun buildNotification(text: String): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }

        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags = flags or PendingIntent.FLAG_IMMUTABLE
        }

        val contentIntent = launchIntent?.let { PendingIntent.getActivity(this, 0, it, flags) }

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, CHANNEL_ID)
        else
            Notification.Builder(this)

        return builder
            .setContentTitle("Faceclaw")
            .setContentText(text)
            .setSmallIcon(applicationInfo.icon)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    private fun foregroundServiceType(): Int {
        var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
        // TODO: Make this depend on which audio path (G2 vs phone) is selected
        if (servesGlasses && hasRecordAudioPermission()) {
            type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        }
        // The location type keeps while-in-use location flowing to the
        // Navigate app when the phone screen locks. Only claimed once the
        // permission exists: on API 34+ claiming it without the permission
        // makes startForeground throw.
        if (servesGlasses && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && hasFineLocationPermission()) {
            type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        }
        return type
    }

    private fun hasRecordAudioPermission(): Boolean {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    }

    private fun hasFineLocationPermission(): Boolean {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
    }
}
