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

import java.util.ArrayList
import java.util.Collections
import java.util.LinkedHashMap

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
    internal class Ringing(
        @JvmField val id: Long,
        title: String?,
        text: String?,
        kind: String?,
        snoozeMinutes: Int
    ) {
        @JvmField val title: String = if (title == null || title.trim().isEmpty()) "Alarm" else title
        @JvmField val text: String = text ?: ""
        @JvmField val kind: String = kind ?: FaceclawAlarms.KIND_ALARM
        @JvmField val snoozeMinutes: Int = Math.max(1, snoozeMinutes)
        @JvmField val ringAtMs: Long = System.currentTimeMillis()
        @JvmField var deliveredAtMs: Long = 0
        @JvmField var escalated: Boolean = false
        @JvmField var silenced: Boolean = false
    }

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

        /** Ringing items, oldest first; static so the activity can read them. */
        private val ringing: MutableMap<Long, Ringing> = Collections.synchronizedMap(LinkedHashMap())
        /**
         * Signals that arrived before the ring intent was processed (the JS
         * engine fires, launches its window and reports delivery on the same
         * main thread the service's onStartCommand queues behind), keyed by id
         * with their arrival time. Consumed by startRinging.
         */
        private val deliveredEarly: MutableMap<Long, Long> = Collections.synchronizedMap(LinkedHashMap())
        private val stoppedEarly: MutableMap<Long, Long> = Collections.synchronizedMap(LinkedHashMap())
        private const val EARLY_SIGNAL_MAX_AGE_MS = 15_000L

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
            if (!ringing.containsKey(id)) {
                deliveredEarly[id] = System.currentTimeMillis()
                return
            }
            val appContext = context.applicationContext
            appContext.startService(Intent(appContext, FaceclawAlarmService::class.java)
                .setAction(ACTION_DELIVERED)
                .putExtra(FaceclawAlarms.EXTRA_ID, id))
        }

        @JvmStatic
        fun stopItem(context: Context, id: Long) {
            if (!ringing.containsKey(id)) {
                stoppedEarly[id] = System.currentTimeMillis()
                return
            }
            val appContext = context.applicationContext
            appContext.startService(Intent(appContext, FaceclawAlarmService::class.java)
                .setAction(ACTION_STOP_ITEM)
                .putExtra(FaceclawAlarms.EXTRA_ID, id))
        }

        @JvmStatic
        fun isRinging(id: Long): Boolean {
            return ringing.containsKey(id)
        }

        @JvmStatic
        fun isAnythingRinging(): Boolean {
            return !ringing.isEmpty()
        }

        @JvmStatic
        internal fun snapshot(): List<Ringing> {
            synchronized(ringing) {
                return ArrayList(ringing.values)
            }
        }

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

        /** Consume an early signal for the id; stale entries are dropped. */
        private fun takeEarlySignal(signals: MutableMap<Long, Long>, id: Long): Boolean {
            val at = signals.remove(id)
            val now = System.currentTimeMillis()
            synchronized(signals) {
                signals.values.removeIf { stamp -> now - stamp > EARLY_SIGNAL_MAX_AGE_MS }
            }
            return at != null && now - at <= EARLY_SIGNAL_MAX_AGE_MS
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
                markDelivered(id)
            ACTION_DISMISS ->
                dismiss(id)
            ACTION_SNOOZE ->
                snooze(id)
            ACTION_STOP_ITEM ->
                stopItemQuietly(id, "acknowledged")
            else -> {}
        }
        finishIfIdle()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
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
        val existing = ringing[item.id]
        if (existing != null) {
            // The engine's JS timeout and the AlarmManager alarm both fired: one ring.
            showNotification(existing)
            return
        }
        if (takeEarlySignal(stoppedEarly, item.id)) {
            // Acknowledged or cancelled before this intent was processed.
            FaceclawAlarms.log(this, "ring " + item.id + " already acknowledged")
            return
        }
        ringing[item.id] = item
        FaceclawAlarms.log(this, "ring " + item.kind + " " + item.id + " (" + FaceclawAlarms.glassesStatusDescription() + ")")
        acquireWakeLock()
        showNotification(item)
        if (!FaceclawAlarms.glassesCanCarryAlarm()) {
            escalate(item, FaceclawAlarms.glassesStatusDescription())
            return
        }
        if (takeEarlySignal(deliveredEarly, item.id)) {
            markDelivered(item.id)
            return
        }
        // The glasses could carry it: give the JS side a moment to confirm
        // they are actually showing it, then hold for the acknowledgement.
        handler.postDelayed({
            val current = ringing[item.id]
            if (current != null && !current.escalated && current.deliveredAtMs == 0L) {
                escalate(current, "not delivered to the glasses")
            }
        }, DELIVERY_WAIT_MS)
    }

    private fun markDelivered(id: Long) {
        val item = ringing[id]
        if (item == null || item.deliveredAtMs != 0L) {
            return
        }
        item.deliveredAtMs = System.currentTimeMillis()
        FaceclawAlarms.log(this, "delivered $id to glasses")
        handler.postDelayed({
            val current = ringing[id]
            if (current != null && !current.escalated) {
                escalate(current, "not acknowledged on the glasses")
            }
        }, ACK_WAIT_MS)
    }

    private fun escalate(item: Ringing, reason: String) {
        if (item.escalated) {
            return
        }
        item.escalated = true
        FaceclawAlarms.log(this, "phone sound for " + item.id + ": " + reason)
        showNotification(item)
        startSound()
        handler.postDelayed({
            val current = ringing[item.id]
            if (current != null && current.escalated && !current.silenced) {
                current.silenced = true
                FaceclawAlarms.log(this, "auto-silenced " + current.id)
                showNotification(current)
                syncSound()
            }
        }, AUTO_SILENCE_MS)
    }

    private fun dismiss(id: Long) {
        val item = ringing[id] ?: return
        FaceclawAlarms.recordPhoneAction(this, id, "dismiss", 0)
        removeItem(item)
        // Also drop the schedule entry (a one-off is over; the engine re-arms repeats).
        FaceclawAlarms.cancel(this, id)
    }

    private fun snooze(id: Long) {
        val item = ringing[id] ?: return
        val minutes = item.snoozeMinutes
        FaceclawAlarms.recordPhoneAction(this, id, "snooze", minutes)
        removeItem(item)
        // Re-arm on the phone directly so the snooze holds even with the JS
        // side gone; the engine replays the journal and lands on the same id.
        FaceclawAlarms.schedule(
            this,
            id,
            System.currentTimeMillis() + minutes * 60_000L,
            item.title,
            item.text,
            item.kind,
            minutes
        )
    }

    private fun stopItemQuietly(id: Long, reason: String) {
        val item = ringing[id] ?: return
        FaceclawAlarms.log(this, "$reason $id")
        removeItem(item)
    }

    private fun removeItem(item: Ringing) {
        ringing.remove(item.id)
        val manager = getSystemService(NotificationManager::class.java)
        manager?.cancel(notificationId(item.id))
        syncSound()
        if (item.id == foregroundId) {
            promoteAnotherToForeground()
        }
    }

    private fun finishIfIdle() {
        if (!ringing.isEmpty()) {
            return
        }
        handler.removeCallbacksAndMessages(null)
        stopSound()
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    // ------------------------------------------------------------------
    // Notification (the phone's silent display of the alarm)

    private fun showNotification(item: Ringing) {
        val notification = buildNotification(item)
        if (foregroundId == 0L || foregroundId == item.id || !ringing.containsKey(foregroundId)) {
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

    private fun syncSound() {
        var wanted = false
        for (item in snapshot()) {
            if (item.escalated && !item.silenced) {
                wanted = true
                break
            }
        }
        if (wanted) {
            startSound()
        } else {
            stopSound()
        }
    }

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
