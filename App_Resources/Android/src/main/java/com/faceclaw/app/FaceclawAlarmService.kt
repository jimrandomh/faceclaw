package com.faceclaw.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator


/**
 * The ringing foreground service. One instance carries every item currently
 * ringing. Each item starts silent on the phone (a heads-up / lock-screen
 * notification only, the glasses do the ringing) and escalates to phone
 * sound and vibration when the glasses cannot carry it: not connected, not
 * on a head, charging, no delivery confirmation from the JS side within a
 * few seconds, or no acknowledgement within 30 seconds of delivery. Sound
 * uses the alarm stream, so media volume, the ringer switch and (unless set
 * to total silence) Do Not Disturb do not silence it.
 */
class FaceclawAlarmService : Service() {
    /** The shared item model; kept as a nested subclass so the lock-screen activity's references hold. */
    internal class Ringing(
        id: Long,
        title: String?,
        text: String?,
        kind: String?,
        snoozeMinutes: Int
    ) : RingingItem(id, title, text, kind, snoozeMinutes, System.currentTimeMillis())

    companion object {
        const val CHANNEL_ID = "faceclaw-alarms"
        internal const val ACTION_RING = "com.faceclaw.app.action.ALARM_RING"
        internal const val ACTION_DELIVERED = "com.faceclaw.app.action.ALARM_DELIVERED"
        internal const val ACTION_DISMISS = "com.faceclaw.app.action.ALARM_DISMISS"
        internal const val ACTION_SNOOZE = "com.faceclaw.app.action.ALARM_SNOOZE"
        /** Stop an item quietly (acknowledged on the glasses / cancelled by the engine). */
        internal const val ACTION_STOP_ITEM = "com.faceclaw.app.action.ALARM_STOP_ITEM"

        /** How long to wait for the JS side to confirm the glasses are showing the item. */
        internal const val DELIVERY_WAIT_MS = 5_000L
        /** How long after delivery to the glasses before the phone joins in. */
        internal const val ACK_WAIT_MS = 30_000L
        /** Sound and vibration stop after this; the notification stays. */
        internal const val AUTO_SILENCE_MS = 10 * 60_000L
        /** Alarm-stream level (fraction of max) used when the wearer has it muted. */
        internal const val MUTED_VOLUME_FRACTION = 0.6f

        /**
         * The escalation policy is process-wide (the activity reads it, the static entry points
         * consult it before the service exists); the live service attaches its timers/effects.
         */
        private val policy = AlarmRingingPolicy(FaceclawAlarms.glassesGate)

        // ------------------------------------------------------------------
        // Static entry points

        @JvmStatic
        fun ring(context: Context, id: Long, title: String?, text: String?, kind: String?, snoozeMinutes: Int) {
            val appContext = context.applicationContext
            val intent = Intent(appContext, FaceclawAlarmService::class.java)
                .setAction(ACTION_RING)
                .putExtra(FaceclawAlarms.EXTRA_ID, id)
                .putExtra(FaceclawAlarms.EXTRA_TITLE, title)
                .putExtra(FaceclawAlarms.EXTRA_TEXT, text)
                .putExtra(FaceclawAlarms.EXTRA_KIND, kind)
                .putExtra(FaceclawAlarms.EXTRA_SNOOZE_MINUTES, snoozeMinutes)
            FaceclawAlarms.startServiceCompat(appContext, intent)
        }

        @JvmStatic
        fun delivered(context: Context, id: Long) {
            if (!policy.deliveredOrDefer(id)) {
                return
            }
            val appContext = context.applicationContext
            appContext.startService(Intent(appContext, FaceclawAlarmService::class.java)
                .setAction(ACTION_DELIVERED)
                .putExtra(FaceclawAlarms.EXTRA_ID, id))
        }

        @JvmStatic
        fun stopItem(context: Context, id: Long) {
            if (!policy.stopOrDefer(id)) {
                return
            }
            val appContext = context.applicationContext
            appContext.startService(Intent(appContext, FaceclawAlarmService::class.java)
                .setAction(ACTION_STOP_ITEM)
                .putExtra(FaceclawAlarms.EXTRA_ID, id))
        }

        @JvmStatic
        fun isRinging(id: Long): Boolean = policy.isRinging(id)

        @JvmStatic
        fun isAnythingRinging(): Boolean = policy.isAnythingRinging()

        @JvmStatic
        internal fun snapshot(): List<Ringing> = policy.snapshot().map { it as Ringing }

        @JvmStatic
        internal fun actionIntent(appContext: Context, action: String, id: Long): PendingIntent {
            val intent = Intent(appContext, FaceclawAlarmService::class.java)
                .setAction(action)
                .putExtra(FaceclawAlarms.EXTRA_ID, id)
            var flags = PendingIntent.FLAG_UPDATE_CURRENT
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags = flags or PendingIntent.FLAG_IMMUTABLE
            }
            val code = FaceclawAlarms.requestCode(id) xor action.hashCode()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                return PendingIntent.getForegroundService(appContext, code, intent, flags)
            }
            return PendingIntent.getService(appContext, code, intent, flags)
        }

        private fun notificationId(id: Long): Int {
            return 0x41000000 or (FaceclawAlarms.requestCode(id) and 0x00ffffff)
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var audioManager: AudioManager? = null
    private var focusRequest: AudioFocusRequest? = null
    private var restoreAlarmVolume = -1
    private var foregroundId: Long = 0

    // ------------------------------------------------------------------
    // Service lifecycle

    override fun onBind(intent: Intent?): IBinder? {
        return null
    }

    override fun onCreate() {
        super.onCreate()
        policy.attach(timers, effects)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        val id = if (intent == null) 0L else intent.getLongExtra(FaceclawAlarms.EXTRA_ID, 0)
        if (action == null) {
            // Restarted by the system with nothing to do.
            finishIfIdle()
            return START_NOT_STICKY
        }
        when (action) {
            ACTION_RING ->
                startRinging(Ringing(
                    id,
                    intent!!.getStringExtra(FaceclawAlarms.EXTRA_TITLE),
                    intent.getStringExtra(FaceclawAlarms.EXTRA_TEXT),
                    intent.getStringExtra(FaceclawAlarms.EXTRA_KIND),
                    intent.getIntExtra(FaceclawAlarms.EXTRA_SNOOZE_MINUTES, 10)
                ))
            ACTION_DELIVERED ->
                policy.markDelivered(id)
            ACTION_DISMISS ->
                policy.dismiss(id)
            ACTION_SNOOZE ->
                policy.snooze(id)
            ACTION_STOP_ITEM ->
                policy.stopQuietly(id, "acknowledged")
            else -> {}
        }
        finishIfIdle()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        policy.detach()
        handler.removeCallbacksAndMessages(null)
        stopSound()
        releaseWakeLock()
        super.onDestroy()
    }

    // ------------------------------------------------------------------
    // Ringing

    private fun startRinging(item: Ringing) {
        if (item.id == 0L) {
            return
        }
        ensureChannel()
        policy.ring(item)
    }

    /** Escalation timers on the service's main-thread Handler. */
    private val timers = object : AlarmScheduler {
        private val pending = HashMap<Any, Runnable>()

        override fun postDelayed(token: Any, delayMs: Long, action: () -> Unit) {
            pending.remove(token)?.let { handler.removeCallbacks(it) }
            val runnable = Runnable {
                pending.remove(token)
                action()
            }
            pending[token] = runnable
            handler.postDelayed(runnable, delayMs)
        }

        override fun cancel(token: Any) {
            pending.remove(token)?.let { handler.removeCallbacks(it) }
        }

        override fun cancelAll() {
            pending.clear()
            handler.removeCallbacksAndMessages(null)
        }
    }

    /** The phone-side effects of the shared policy: notifications, sound, schedule, journal. */
    private val effects = object : RingingSink {
        override fun showNotification(item: RingingItem) = this@FaceclawAlarmService.showNotification(item as Ringing)

        override fun itemRemoved(item: RingingItem) {
            val manager = getSystemService(NotificationManager::class.java)
            manager?.cancel(notificationId(item.id))
            if (item.id == foregroundId) {
                promoteAnotherToForeground()
            }
        }

        override fun ringingStarted() = acquireWakeLock()

        override fun startSound() = this@FaceclawAlarmService.startSound()

        override fun stopSound() = this@FaceclawAlarmService.stopSound()

        override fun reschedule(item: RingingItem, atMs: Long, minutes: Int) {
            // The engine replays the journal and lands on the same id.
            FaceclawAlarms.schedule(this@FaceclawAlarmService, item.id, atMs, item.title, item.text, item.kind, minutes)
        }

        override fun cancelSchedule(id: Long) = FaceclawAlarms.cancel(this@FaceclawAlarmService, id)

        override fun recordPhoneAction(id: Long, action: String, minutes: Int) =
            FaceclawAlarms.recordPhoneAction(this@FaceclawAlarmService, id, action, minutes)

        override fun log(line: String) = FaceclawAlarms.log(this@FaceclawAlarmService, line)
    }

    private fun finishIfIdle() {
        if (policy.isAnythingRinging()) {
            return
        }
        policy.cancelTimers()
        stopSound()
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    // ------------------------------------------------------------------
    // Notification (the phone's silent display of the alarm)

    private fun showNotification(item: Ringing) {
        val notification = buildNotification(item)
        if (foregroundId == 0L || foregroundId == item.id || !policy.isRinging(foregroundId)) {
            foregroundId = item.id
            startForegroundCompat(notificationId(item.id), notification)
        } else {
            val manager = getSystemService(NotificationManager::class.java)
            manager?.notify(notificationId(item.id), notification)
        }
    }

    private fun promoteAnotherToForeground() {
        val items = snapshot()
        if (items.isEmpty()) {
            foregroundId = 0
            return
        }
        val next = items[0]
        foregroundId = next.id
        startForegroundCompat(notificationId(next.id), buildNotification(next))
    }

    private fun startForegroundCompat(id: Int, notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(id, notification)
        }
    }

    private fun buildNotification(item: Ringing): Notification {
        val activity = Intent(this, FaceclawAlarmActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(FaceclawAlarms.EXTRA_ID, item.id)
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags = flags or PendingIntent.FLAG_IMMUTABLE
        }
        val open = PendingIntent.getActivity(this, FaceclawAlarms.requestCode(item.id), activity, flags)

        val status: String = if (item.silenced) {
            "Not answered"
        } else if (item.escalated) {
            "Ringing"
        } else {
            "Ringing on the glasses"
        }
        val text = if (item.text.isEmpty()) status else item.text + " · " + status

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, CHANNEL_ID)
        else
            Notification.Builder(this).setPriority(Notification.PRIORITY_MAX)
        builder.setContentTitle(item.title)
            .setContentText(text)
            .setSmallIcon(applicationInfo.icon)
            .setContentIntent(open)
            .setFullScreenIntent(open, true)
            .setCategory(Notification.CATEGORY_ALARM)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setOnlyAlertOnce(true)
            .setWhen(item.ringAtMs)
            .setShowWhen(true)
            .addAction(Notification.Action.Builder(
                null,
                if (FaceclawAlarms.KIND_TIMER == item.kind) "+" + item.snoozeMinutes + " min" else "Snooze " + item.snoozeMinutes + " min",
                actionIntent(this, ACTION_SNOOZE, item.id)).build())
            .addAction(Notification.Action.Builder(
                null,
                "Dismiss",
                actionIntent(this, ACTION_DISMISS, item.id)).build())
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // Pre-channel: the builder controls sound, and we want none.
            builder.setSound(null).setVibrate(null)
        }
        return builder.build()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(CHANNEL_ID, "Alarms", NotificationManager.IMPORTANCE_HIGH)
        channel.description = "Timers and alarms going off. Silent here: the sound is played by the alarm itself."
        // The service plays the sound itself (on the alarm stream) so the
        // notification stays silent and vibration-free on purpose.
        channel.setSound(null, null)
        channel.enableVibration(false)
        channel.setBypassDnd(true)
        channel.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        manager.createNotificationChannel(channel)
    }

    // ------------------------------------------------------------------
    // Sound and vibration (only while some item is escalated and not yet silenced)

    private fun startSound() {
        if (player != null) {
            return
        }
        audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager?
        val attributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        raiseMutedAlarmVolume()
        requestAudioFocus(attributes)
        var tone: Uri? = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
        if (tone == null) {
            tone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        }
        try {
            val created = MediaPlayer()
            created.setAudioAttributes(attributes)
            created.setDataSource(this, tone!!)
            created.isLooping = true
            created.prepare()
            created.start()
            player = created
        } catch (error: Exception) {
            FaceclawAlarms.log(this, "alarm sound failed: " + error.message)
            player = null
        }
        startVibration()
    }

    private fun stopSound() {
        val current = player
        if (current != null) {
            try {
                current.stop()
            } catch (ignored: RuntimeException) {
                // Already stopped.
            }
            current.release()
            player = null
        }
        val device = vibrator
        if (device != null) {
            device.cancel()
            vibrator = null
        }
        abandonAudioFocus()
        restoreAlarmVolume()
    }

    /**
     * A muted alarm stream is the one thing that would keep an alarm clock
     * silent; raise it for the duration of the ring and put it back after.
     */
    private fun raiseMutedAlarmVolume() {
        val manager = audioManager ?: return
        try {
            val current = manager.getStreamVolume(AudioManager.STREAM_ALARM)
            val max = manager.getStreamMaxVolume(AudioManager.STREAM_ALARM)
            if (current == 0 && max > 0) {
                restoreAlarmVolume = current
                manager.setStreamVolume(AudioManager.STREAM_ALARM, Math.max(1, Math.round(max * MUTED_VOLUME_FRACTION)), 0)
            }
        } catch (error: RuntimeException) {
            FaceclawAlarms.log(this, "alarm volume change failed: " + error.message)
        }
    }

    private fun restoreAlarmVolume() {
        val manager = audioManager
        if (manager == null || restoreAlarmVolume < 0) {
            return
        }
        try {
            manager.setStreamVolume(AudioManager.STREAM_ALARM, restoreAlarmVolume, 0)
        } catch (ignored: RuntimeException) {
            // Best effort.
        }
        restoreAlarmVolume = -1
    }

    private fun requestAudioFocus(attributes: AudioAttributes) {
        val manager = audioManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(attributes)
                .build()
            focusRequest = request
            manager.requestAudioFocus(request)
        } else {
            @Suppress("DEPRECATION")
            manager.requestAudioFocus(null, AudioManager.STREAM_ALARM, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        }
    }

    private fun abandonAudioFocus() {
        val manager = audioManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = focusRequest
            if (request != null) {
                manager.abandonAudioFocusRequest(request)
                focusRequest = null
            }
        } else {
            @Suppress("DEPRECATION")
            manager.abandonAudioFocus(null)
        }
    }

    private fun startVibration() {
        val device = getSystemService(Context.VIBRATOR_SERVICE) as Vibrator?
        if (device == null || !device.hasVibrator()) {
            return
        }
        vibrator = device
        val pattern = longArrayOf(0, 600, 400, 600, 1200)
        val attributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                device.vibrate(VibrationEffect.createWaveform(pattern, 0), attributes)
            } else {
                @Suppress("DEPRECATION")
                device.vibrate(pattern, 0, attributes)
            }
        } catch (error: RuntimeException) {
            FaceclawAlarms.log(this, "vibration failed: " + error.message)
        }
    }

    // ------------------------------------------------------------------
    // Wake lock

    private fun acquireWakeLock() {
        val held = wakeLock
        if (held != null && held.isHeld) {
            return
        }
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager? ?: return
        val lock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "faceclaw:alarm")
        wakeLock = lock
        // Bounded: sound auto-silences at AUTO_SILENCE_MS, and a stuck lock
        // past that would only drain the battery.
        lock.acquire(AUTO_SILENCE_MS + ACK_WAIT_MS + DELIVERY_WAIT_MS + 10_000L)
    }

    private fun releaseWakeLock() {
        val lock = wakeLock
        if (lock != null && lock.isHeld) {
            lock.release()
        }
        wakeLock = null
    }
}
