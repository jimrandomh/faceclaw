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

        const val KIND_TIMER = "timer"
        const val KIND_ALARM = "alarm"

        private const val PREFS_NAME = "faceclaw-alarms"
        private const val KEY_SCHEDULED = "scheduled"
        private const val KEY_JOURNAL = "journal"
        private const val KEY_LOG = "log"
        private const val LOG_LINES = 60

        /**
         * A schedule entry found already past due (after a reboot, or when the
         * process was asleep) rings if it is at most this late; older ones are
         * dropped as missed. Matches the JS engine's grace window.
         */
        internal const val LATE_GRACE_MS = 5 * 60_000L
        /** A glasses status report older than this is not trusted (the JS side is probably gone). */
        internal const val GLASSES_STATUS_MAX_AGE_MS = 3 * 60_000L

        @Volatile
        private var glassesConnected = false
        @Volatile
        private var glassesWorn = false
        @Volatile
        private var glassesCharging = false
        @Volatile
        private var glassesStatusAtMs = 0L

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

        // The Java statics were `synchronized`, i.e. locked on the class object;
        // the explicit blocks below keep that single monitor.
        private fun readArray(context: Context, key: String): JSONArray {
            synchronized(FaceclawAlarms::class.java) {
                val raw = prefs(context).getString(key, "[]")
                return try {
                    JSONArray(raw)
                } catch (error: JSONException) {
                    JSONArray()
                }
            }
        }

        private fun writeArray(context: Context, key: String, array: JSONArray) {
            synchronized(FaceclawAlarms::class.java) {
                prefs(context).edit().putString(key, array.toString()).apply()
            }
        }

        @JvmStatic
        internal fun findScheduled(context: Context, id: Long): JSONObject? {
            val scheduled = readArray(context, KEY_SCHEDULED)
            for (index in 0 until scheduled.length()) {
                val entry = scheduled.optJSONObject(index)
                if (entry != null && entry.optLong("id") == id) {
                    return entry
                }
            }
            return null
        }

        private fun putScheduled(context: Context, entry: JSONObject) {
            synchronized(FaceclawAlarms::class.java) {
                val scheduled = readArray(context, KEY_SCHEDULED)
                val next = JSONArray()
                val id = entry.optLong("id")
                for (index in 0 until scheduled.length()) {
                    val existing = scheduled.optJSONObject(index)
                    if (existing != null && existing.optLong("id") != id) {
                        next.put(existing)
                    }
                }
                next.put(entry)
                writeArray(context, KEY_SCHEDULED, next)
            }
        }

        private fun removeScheduled(context: Context, id: Long) {
            synchronized(FaceclawAlarms::class.java) {
                val scheduled = readArray(context, KEY_SCHEDULED)
                val next = JSONArray()
                for (index in 0 until scheduled.length()) {
                    val existing = scheduled.optJSONObject(index)
                    if (existing != null && existing.optLong("id") != id) {
                        next.put(existing)
                    }
                }
                writeArray(context, KEY_SCHEDULED, next)
            }
        }

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
            val entry = JSONObject()
            try {
                entry.put("id", id)
                entry.put("at", triggerAtMs)
                entry.put("title", title ?: "")
                entry.put("text", text ?: "")
                entry.put("kind", kind ?: KIND_ALARM)
                entry.put("snoozeMinutes", snoozeMinutes)
            } catch (ignored: JSONException) {
                return
            }
            putScheduled(appContext, entry)
            armAlarm(appContext, entry)
        }

        private fun armAlarm(appContext: Context, entry: JSONObject) {
            val manager = appContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager?
                ?: return
            val id = entry.optLong("id")
            val triggerAt = Math.max(System.currentTimeMillis(), entry.optLong("at"))
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
                val entry = JSONObject()
                try {
                    entry.put("id", id)
                } catch (ignored: JSONException) {
                    // unreachable for a numeric put
                }
                manager.cancel(expiryPendingIntent(appContext, entry))
            }
            removeScheduled(appContext, id)
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
            val scheduled = readArray(appContext, KEY_SCHEDULED)
            val now = System.currentTimeMillis()
            var armed = 0
            for (index in 0 until scheduled.length()) {
                val entry = scheduled.optJSONObject(index) ?: continue
                val at = entry.optLong("at")
                if (at <= now) {
                    if (now - at <= LATE_GRACE_MS) {
                        ringEntry(appContext, entry)
                    } else {
                        log(appContext, "missed " + entry.optString("kind") + " " + entry.optLong("id") + " (" + reason + ")")
                        removeScheduled(appContext, entry.optLong("id"))
                    }
                    continue
                }
                armAlarm(appContext, entry)
                armed++
            }
            log(appContext, "rescheduled $armed ($reason)")
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
            val scheduled = readArray(appContext, KEY_SCHEDULED)
            val now = System.currentTimeMillis()
            var soonest = Long.MAX_VALUE
            for (index in 0 until scheduled.length()) {
                val entry = scheduled.optJSONObject(index)
                if (entry != null && entry.optLong("at") > now) {
                    soonest = Math.min(soonest, entry.optLong("at"))
                }
            }
            if (soonest == Long.MAX_VALUE) {
                return false
            }
            val manager = appContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager?
                ?: return false
            val next = manager.nextAlarmClock
            // Another app's alarm may legitimately be sooner; only a later (or
            // absent) system alarm proves ours is missing.
            return next == null || next.triggerTime > soonest + 1000
        }

        // ------------------------------------------------------------------
        // Ringing

        /** An item came due: hand it to the ringing service (idempotent per id). */
        @JvmStatic
        internal fun ringEntry(appContext: Context, entry: JSONObject) {
            FaceclawAlarmService.ring(
                appContext,
                entry.optLong("id"),
                entry.optString("title"),
                entry.optString("text"),
                entry.optString("kind", KIND_ALARM),
                entry.optInt("snoozeMinutes", 10)
            )
        }

        /** The JS engine's own expiry path; the service deduplicates against the alarm's. */
        @JvmStatic
        fun ring(context: Context, id: Long, title: String?, text: String?, kind: String?, snoozeMinutes: Int) {
            val appContext = context.applicationContext
            val manager = appContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager?
            if (manager != null) {
                val probe = JSONObject()
                try {
                    probe.put("id", id)
                } catch (ignored: JSONException) {
                    // unreachable for a numeric put
                }
                manager.cancel(expiryPendingIntent(appContext, probe))
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
            removeScheduled(appContext, id)
            FaceclawAlarmService.stopItem(appContext, id)
        }

        // ------------------------------------------------------------------
        // Glasses status (pushed by the JS side; in-memory, so a dead process reads as "no glasses")

        @JvmStatic
        fun setGlassesStatus(connected: Boolean, worn: Boolean, charging: Boolean) {
            glassesConnected = connected
            glassesWorn = worn
            glassesCharging = charging
            glassesStatusAtMs = System.currentTimeMillis()
        }

        /** True only when a fresh report says the glasses are connected, on a head, and not charging. */
        @JvmStatic
        internal fun glassesCanCarryAlarm(): Boolean {
            val age = System.currentTimeMillis() - glassesStatusAtMs
            if (glassesStatusAtMs == 0L || age > GLASSES_STATUS_MAX_AGE_MS) {
                return false
            }
            return glassesConnected && glassesWorn && !glassesCharging
        }

        @JvmStatic
        internal fun glassesStatusDescription(): String {
            if (glassesStatusAtMs == 0L) {
                return "no glasses status"
            }
            val age = System.currentTimeMillis() - glassesStatusAtMs
            if (age > GLASSES_STATUS_MAX_AGE_MS) {
                return "glasses status stale"
            }
            if (!glassesConnected) {
                return "glasses not connected"
            }
            if (glassesCharging) {
                return "glasses charging"
            }
            if (!glassesWorn) {
                return "glasses not worn"
            }
            return "glasses worn"
        }

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
            val event = JSONObject()
            try {
                event.put("id", id)
                event.put("action", action)
                event.put("minutes", minutes)
                event.put("at", System.currentTimeMillis())
            } catch (ignored: JSONException) {
                return
            }
            synchronized(FaceclawAlarms::class.java) {
                val journal = readArray(appContext, KEY_JOURNAL)
                journal.put(event)
                writeArray(appContext, KEY_JOURNAL, journal)
            }
            log(appContext, "phone " + action + " " + id + (if (minutes > 0) " ($minutes min)" else ""))
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
        fun drainJournal(context: Context): String {
            synchronized(FaceclawAlarms::class.java) {
                val appContext = context.applicationContext
                val journal = readArray(appContext, KEY_JOURNAL)
                writeArray(appContext, KEY_JOURNAL, JSONArray())
                return journal.toString()
            }
        }

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
            synchronized(FaceclawAlarms::class.java) {
                val appContext = context.applicationContext
                val log = readArray(appContext, KEY_LOG)
                val next = JSONArray()
                val start = Math.max(0, log.length() - (LOG_LINES - 1))
                for (index in start until log.length()) {
                    next.put(log.optString(index))
                }
                next.put(System.currentTimeMillis().toString() + " " + line)
                writeArray(appContext, KEY_LOG, next)
            }
        }

        /** The ring / miss / action log, newest last, one line per entry. */
        @JvmStatic
        fun readLog(context: Context): String {
            val log = readArray(context.applicationContext, KEY_LOG)
            val out = StringBuilder()
            for (index in 0 until log.length()) {
                if (index > 0) {
                    out.append('\n')
                }
                out.append(log.optString(index))
            }
            return out.toString()
        }

        // ------------------------------------------------------------------
        // Intents

        private fun expiryPendingIntent(appContext: Context, entry: JSONObject): PendingIntent {
            val intent = Intent(appContext, FaceclawAlarmReceiver::class.java)
            intent.action = ACTION_EXPIRE
            val id = entry.optLong("id")
            intent.putExtra(EXTRA_ID, id)
            intent.putExtra(EXTRA_TITLE, entry.optString("title"))
            intent.putExtra(EXTRA_TEXT, entry.optString("text"))
            intent.putExtra(EXTRA_KIND, entry.optString("kind", KIND_ALARM))
            intent.putExtra(EXTRA_SNOOZE_MINUTES, entry.optInt("snoozeMinutes", 10))
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
        internal fun requestCode(id: Long): Int {
            return (id xor (id ushr 32)).toInt() and 0x7fffffff
        }

        @JvmStatic
        internal fun startServiceCompat(appContext: Context, intent: Intent) {
            ContextCompat.startForegroundService(appContext, intent)
        }
    }
}
