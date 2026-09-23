package com.faceclaw.app

import android.app.ActivityManager
import android.app.AlarmManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings

import androidx.core.content.ContextCompat

import com.tns.NativeScriptActivity

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

import java.util.Locale

/**
 * The phone side of the Timers app's alarms and countdown timers, built to
 * ring without the JavaScript side: scheduling through AlarmManager's alarm
 * clock API, a persisted schedule (in device-protected storage) that the
 * reschedule receiver replays after reboots and time changes, the hand-off
 * to the ringing foreground service, and a journal of what the wearer did
 * on the phone (dismiss / snooze) for the JS engine to replay when it is
 * next awake. Also the reliability self-check the UI surfaces.
 *
 * Ids are the JS engine's item ids (a millisecond epoch times 100 plus a
 * serial), shared between timers and alarms; `kind` tells the two apart for
 * wording only.
 */
class FaceclawAlarms private constructor() {
    companion object {
        const val ACTION_EXPIRE = "com.faceclaw.app.action.ALARM_EXPIRE"
        internal const val EXTRA_ID = "id"
        internal const val EXTRA_TITLE = "title"
        internal const val EXTRA_TEXT = "text"
        internal const val EXTRA_KIND = "kind"
        internal const val EXTRA_SNOOZE_MINUTES = "snoozeMinutes"

        const val KIND_TIMER = AlarmSchedule.KIND_TIMER
        const val KIND_ALARM = AlarmSchedule.KIND_ALARM

        private const val PREFS_NAME = "faceclaw-alarms"

        /** Grace window for past-due entries found on replay (shared policy). */
        internal const val LATE_GRACE_MS = AlarmSchedule.LATE_GRACE_MS
        /** A glasses status report older than this is not trusted (shared policy). */
        internal const val GLASSES_STATUS_MAX_AGE_MS = GlassesStatusGate.MAX_AGE_MS

        /** The last glasses status pushed by the JS side; read by the ringing service. */
        @JvmField
        internal val glassesGate = GlassesStatusGate()

        @Volatile
        private var listener: FaceclawAlarmListener? = null
        private val mainHandler = Handler(Looper.getMainLooper())

        // ------------------------------------------------------------------
        // Storage

        /**
         * Device-protected storage, so the schedule is readable before the first
         * unlock after a reboot (the reschedule receiver may run then on some
         * devices) and survives credential-encrypted storage being unavailable.
         */
        @JvmStatic
        internal fun prefs(context: Context): SharedPreferences {
            var base = context.applicationContext
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                base = base.createDeviceProtectedStorageContext()
            }
            return base.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        }

        @Volatile
        private var scheduleInstance: AlarmSchedule? = null

        /** The shared schedule/journal/log core over the device-protected prefs (one per process). */
        @JvmStatic
        internal fun scheduleCore(context: Context): AlarmSchedule {
            scheduleInstance?.let { return it }
            synchronized(FaceclawAlarms::class.java) {
                scheduleInstance?.let { return it }
                val prefs = prefs(context)
                val created = AlarmSchedule(object : AlarmStore {
                    override fun read(key: String): String? = prefs.getString(key, null)

                    override fun write(key: String, value: String?) {
                        prefs.edit().putString(key, value).apply()
                    }
                })
                scheduleInstance = created
                return created
            }
        }

        @JvmStatic
        internal fun findScheduled(context: Context, id: Long): AlarmEntry? = scheduleCore(context).find(id)

        // ------------------------------------------------------------------
        // Scheduling

        /**
         * Schedule (or move) the phone alarm for an item. Idempotent: the same id
         * always maps to the same PendingIntent, so a reschedule replaces rather
         * than duplicates. setAlarmClock is exact, fires through Doze and battery
         * savers, and shows the system's alarm indicator; the fallbacks only run
         * where it is unavailable.
         */
        @JvmStatic
        fun schedule(
            context: Context,
            id: Long,
            triggerAtMs: Long,
            title: String?,
            text: String?,
            kind: String?,
            snoozeMinutes: Int
        ) {
            val appContext = context.applicationContext
            val entry = AlarmEntry(id, triggerAtMs, title, text, kind ?: KIND_ALARM, snoozeMinutes)
            scheduleCore(appContext).put(entry)
            armAlarm(appContext, entry)
        }

        private fun armAlarm(appContext: Context, entry: AlarmEntry) {
            val manager = appContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager?
                ?: return
            val id = entry.id
            val triggerAt = Math.max(System.currentTimeMillis(), entry.at)
            val fire = expiryPendingIntent(appContext, entry)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    val info = AlarmManager.AlarmClockInfo(triggerAt, showIntent(appContext, id))
                    manager.setAlarmClock(info, fire)
                } else {
                    manager.setExact(AlarmManager.RTC_WAKEUP, triggerAt, fire)
                }
            } catch (error: SecurityException) {
                // Exact-alarm access revoked (Android 12/13 without USE_EXACT_ALARM
                // honoured): the inexact alarm is still a wake-up, just a late one.
                log(appContext, "exact alarm refused for " + id + ": " + error.message)
                manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, fire)
            }
        }

        /** Cancel the phone alarm for an item, stop it if ringing, and forget it. */
        @JvmStatic
        fun cancel(context: Context, id: Long) {
            val appContext = context.applicationContext
            val manager = appContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager?
            if (manager != null) {
                manager.cancel(expiryPendingIntent(appContext, AlarmEntry(id, 0L, null, null, null, 10)))
            }
            scheduleCore(appContext).remove(id)
            FaceclawAlarmService.stopItem(appContext, id)
        }

        /**
         * Replay the persisted schedule into AlarmManager: after a reboot (alarms
         * are wiped), a package update, or a wall-clock / time-zone change. Entries
         * already due ring now if inside the grace window, else are dropped.
         */
        @JvmStatic
        fun rescheduleAll(context: Context, reason: String?) {
            val appContext = context.applicationContext
            scheduleCore(appContext).replay(reason, { ringEntry(appContext, it) }, { armAlarm(appContext, it) })
        }

        /**
         * The schedule and AlarmManager can disagree (a force-stop clears alarms
         * but not the file, an OEM killer drops them). True when the soonest
         * stored entry is not what the system reports as the next alarm clock.
         */
        @JvmStatic
        fun scheduleLooksStale(context: Context): Boolean {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
                return false
            }
            val appContext = context.applicationContext
            val core = scheduleCore(appContext)
            if (core.soonestPendingAt() == null) {
                return false
            }
            val manager = appContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager?
                ?: return false
            return core.looksStale(manager.nextAlarmClock?.triggerTime)
        }

        // ------------------------------------------------------------------
        // Ringing

        /** An item came due: hand it to the ringing service (idempotent per id). */
        @JvmStatic
        internal fun ringEntry(appContext: Context, entry: AlarmEntry) {
            FaceclawAlarmService.ring(appContext, entry.id, entry.title, entry.text, entry.kind, entry.snoozeMinutes)
        }

        /** The JS engine's own expiry path; the service deduplicates against the alarm's. */
        @JvmStatic
        fun ring(context: Context, id: Long, title: String?, text: String?, kind: String?, snoozeMinutes: Int) {
            val appContext = context.applicationContext
            val manager = appContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager?
            if (manager != null) {
                manager.cancel(expiryPendingIntent(appContext, AlarmEntry(id, 0L, null, null, null, 10)))
            }
            FaceclawAlarmService.ring(appContext, id, title, text, kind, snoozeMinutes)
        }

        /** The glasses are showing the ringing item; the acknowledgement clock starts now. */
        @JvmStatic
        fun deliveredToGlasses(context: Context, id: Long) {
            FaceclawAlarmService.delivered(context.applicationContext, id)
        }

        /** The wearer dismissed or snoozed it on the glasses: the phone side goes quiet. */
        @JvmStatic
        fun acknowledge(context: Context, id: Long) {
            val appContext = context.applicationContext
            scheduleCore(appContext).remove(id)
            FaceclawAlarmService.stopItem(appContext, id)
        }

        // ------------------------------------------------------------------
        // Glasses status (pushed by the JS side; in-memory, so a dead process reads as "no glasses")

        @JvmStatic
        fun setGlassesStatus(connected: Boolean, worn: Boolean, charging: Boolean) {
            glassesGate.set(connected, worn, charging)
        }

        /** True only when a fresh report says the glasses are connected, on a head, and not charging. */
        @JvmStatic
        internal fun glassesCanCarryAlarm(): Boolean = glassesGate.canCarryAlarm()

        @JvmStatic
        internal fun glassesStatusDescription(): String = glassesGate.description()

        // ------------------------------------------------------------------
        // Phone actions -> JS

        @JvmStatic
        fun setListener(newListener: FaceclawAlarmListener?) {
            listener = newListener
        }

        /**
         * Record a dismiss / snooze done on the phone. Delivered live to the JS
         * listener when one is registered, and journaled regardless so a JS side
         * that was asleep or gone can catch up on its next boot.
         */
        @JvmStatic
        internal fun recordPhoneAction(context: Context, id: Long, action: String, minutes: Int) {
            val appContext = context.applicationContext
            scheduleCore(appContext).appendJournal(id, action, minutes)
            val current = listener
            if (current != null) {
                mainHandler.post {
                    try {
                        current.onPhoneAction(id, action, minutes)
                    } catch (error: RuntimeException) {
                        log(appContext, "listener failed: " + error.message)
                    }
                }
            }
        }

        /** Hand the journal to the JS side (as a JSON array) and clear it. */
        @JvmStatic
        fun drainJournal(context: Context): String = scheduleCore(context.applicationContext).drainJournal()

        // ------------------------------------------------------------------
        // Reliability self-check

        /**
         * Conditions under which the phone may fail to ring, as a JSON array of
         * {code, message, fixable}, most serious first. Empty when everything is
         * in order. The UI shows these before the wearer relies on an alarm.
         */
        @JvmStatic
        fun checkReliability(context: Context): String {
            val appContext = context.applicationContext
            val issues = JSONArray()
            val notifications = appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager?
            val alarms = appContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager?

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && alarms != null && !alarms.canScheduleExactAlarms()) {
                addIssue(issues, "exact-alarm", "Exact alarms are not allowed for Faceclaw, so alarms may ring late.", true)
            }
            if (notifications != null && !notifications.areNotificationsEnabled()) {
                addIssue(issues, "notifications", "Notifications are turned off for Faceclaw, so the phone cannot show or sound an alarm.", true)
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && notifications != null) {
                val channel = notifications.getNotificationChannel(FaceclawAlarmService.CHANNEL_ID)
                if (channel != null && channel.importance == NotificationManager.IMPORTANCE_NONE) {
                    addIssue(issues, "alarm-channel", "The Alarms notification category is blocked, so the phone cannot show an alarm.", true)
                }
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && notifications != null && !notifications.canUseFullScreenIntent()) {
                addIssue(issues, "full-screen", "Full-screen alarms are not allowed, so a ringing alarm will not take over the lock screen.", true)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && notifications != null) {
                val filter = notifications.currentInterruptionFilter
                if (filter == NotificationManager.INTERRUPTION_FILTER_NONE) {
                    addIssue(issues, "dnd-total", "Do Not Disturb is set to total silence, which silences alarms too.", true)
                } else if (filter == NotificationManager.INTERRUPTION_FILTER_PRIORITY) {
                    try {
                        val policy = notifications.notificationPolicy
                        if (policy != null && (policy.priorityCategories and NotificationManager.Policy.PRIORITY_CATEGORY_ALARMS) == 0) {
                            addIssue(issues, "dnd-alarms", "Do Not Disturb does not allow alarms, so the phone will stay silent.", true)
                        }
                    } catch (ignored: SecurityException) {
                        // No notification-policy access: cannot inspect the exceptions.
                    }
                }
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                val activityManager = appContext.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager?
                if (activityManager != null && activityManager.isBackgroundRestricted) {
                    addIssue(issues, "background-restricted", "Background usage is restricted for Faceclaw, which blocks alarms while the app is not open.", true)
                }
            }
            val power = appContext.getSystemService(Context.POWER_SERVICE) as PowerManager?
            if (power != null && !power.isIgnoringBatteryOptimizations(appContext.packageName)) {
                addIssue(issues, "battery-optimized", "Battery optimization is on for Faceclaw; some phones delay alarms because of it.", true)
            }
            val audio = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager?
            if (audio != null && audio.getStreamVolume(AudioManager.STREAM_ALARM) == 0) {
                addIssue(issues, "alarm-volume", "The phone's alarm volume is muted; Faceclaw raises it while ringing, but check it.", true)
            }
            val maker = if (Build.MANUFACTURER == null) "" else Build.MANUFACTURER.lowercase(Locale.ROOT)
            if (maker.contains("xiaomi") || maker.contains("huawei") || maker.contains("oppo") || maker.contains("vivo")
                || maker.contains("oneplus") || maker.contains("realme") || maker.contains("meizu") || maker.contains("asus")) {
                addIssue(issues, "oem-killer", "This phone maker is known to stop background apps; allow Faceclaw to auto-start and run unrestricted (see dontkillmyapp.com).", true)
            }
            if (scheduleLooksStale(appContext)) {
                addIssue(issues, "schedule-stale", "The system lost Faceclaw's next alarm (the app may have been force-stopped); it was re-armed.", false)
                rescheduleAll(appContext, "self-check")
            }
            return issues.toString()
        }

        private fun addIssue(issues: JSONArray, code: String, message: String, fixable: Boolean) {
            val issue = JSONObject()
            try {
                issue.put("code", code)
                issue.put("message", message)
                issue.put("fixable", fixable)
            } catch (ignored: JSONException) {
                return
            }
            issues.put(issue)
        }

        /** Open the system screen where the issue can be fixed. */
        @JvmStatic
        fun openReliabilityFix(context: Context, code: String?) {
            val appContext = context.applicationContext
            val pkg = appContext.packageName
            var intent: Intent
            when (code ?: "") {
                "exact-alarm" ->
                    intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
                        Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:$pkg"))
                    else
                        appDetails(pkg)
                "notifications", "alarm-channel" -> {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, pkg)
                        if ("alarm-channel" == code) {
                            intent = Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                                .putExtra(Settings.EXTRA_APP_PACKAGE, pkg)
                                .putExtra(Settings.EXTRA_CHANNEL_ID, FaceclawAlarmService.CHANNEL_ID)
                        }
                    } else {
                        intent = appDetails(pkg)
                    }
                }
                "full-screen" ->
                    intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
                        Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:$pkg"))
                    else
                        appDetails(pkg)
                "dnd-total", "dnd-alarms" ->
                    intent = Intent(Settings.ACTION_SOUND_SETTINGS)
                "battery-optimized" ->
                    intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$pkg"))
                "alarm-volume" ->
                    intent = Intent(Settings.ACTION_SOUND_SETTINGS)
                else ->
                    intent = appDetails(pkg)
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                appContext.startActivity(intent)
            } catch (error: RuntimeException) {
                val fallback = appDetails(pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                try {
                    appContext.startActivity(fallback)
                } catch (ignored: RuntimeException) {
                    // No settings activity at all; nothing more to do.
                }
            }
        }

        private fun appDetails(pkg: String): Intent {
            return Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$pkg"))
        }

        // ------------------------------------------------------------------
        // Diagnostics log

        @JvmStatic
        internal fun log(context: Context, line: String) {
            scheduleCore(context.applicationContext).log(line)
        }

        /** The ring / miss / action log, newest last, one line per entry. */
        @JvmStatic
        fun readLog(context: Context): String = scheduleCore(context.applicationContext).readLog()

        // ------------------------------------------------------------------
        // Intents

        private fun expiryPendingIntent(appContext: Context, entry: AlarmEntry): PendingIntent {
            val intent = Intent(appContext, FaceclawAlarmReceiver::class.java)
            intent.action = ACTION_EXPIRE
            val id = entry.id
            intent.putExtra(EXTRA_ID, id)
            intent.putExtra(EXTRA_TITLE, entry.title)
            intent.putExtra(EXTRA_TEXT, entry.text)
            intent.putExtra(EXTRA_KIND, entry.kind)
            intent.putExtra(EXTRA_SNOOZE_MINUTES, entry.snoozeMinutes)
            var flags = PendingIntent.FLAG_UPDATE_CURRENT
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags = flags or PendingIntent.FLAG_IMMUTABLE
            }
            return PendingIntent.getBroadcast(appContext, requestCode(id), intent, flags)
        }

        /** What the system's alarm indicator opens: the app. */
        private fun showIntent(appContext: Context, id: Long): PendingIntent {
            val intent = Intent(appContext, NativeScriptActivity::class.java)
            intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            var flags = PendingIntent.FLAG_UPDATE_CURRENT
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags = flags or PendingIntent.FLAG_IMMUTABLE
            }
            return PendingIntent.getActivity(appContext, requestCode(id), intent, flags)
        }

        @JvmStatic
        internal fun requestCode(id: Long): Int = AlarmSchedule.requestCode(id)

        @JvmStatic
        internal fun startServiceCompat(appContext: Context, intent: Intent) {
            ContextCompat.startForegroundService(appContext, intent)
        }
    }
}
