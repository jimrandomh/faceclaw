package com.faceclaw.app;

import android.app.ActivityManager;
import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.tns.NativeScriptActivity;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Locale;

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
public final class FaceclawAlarms {
    public static final String ACTION_EXPIRE = "com.faceclaw.app.action.ALARM_EXPIRE";
    static final String EXTRA_ID = "id";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";
    static final String EXTRA_KIND = "kind";
    static final String EXTRA_SNOOZE_MINUTES = "snoozeMinutes";

    public static final String KIND_TIMER = "timer";
    public static final String KIND_ALARM = "alarm";

    private static final String PREFS_NAME = "faceclaw-alarms";
    private static final String KEY_SCHEDULED = "scheduled";
    private static final String KEY_JOURNAL = "journal";
    private static final String KEY_LOG = "log";
    private static final int LOG_LINES = 60;

    /**
     * A schedule entry found already past due (after a reboot, or when the
     * process was asleep) rings if it is at most this late; older ones are
     * dropped as missed. Matches the JS engine's grace window.
     */
    static final long LATE_GRACE_MS = 5 * 60_000L;
    /** A glasses status report older than this is not trusted (the JS side is probably gone). */
    static final long GLASSES_STATUS_MAX_AGE_MS = 3 * 60_000L;

    private static volatile boolean glassesConnected;
    private static volatile boolean glassesWorn;
    private static volatile boolean glassesCharging;
    private static volatile long glassesStatusAtMs;

    private static volatile FaceclawAlarmListener listener;
    private static final Handler mainHandler = new Handler(Looper.getMainLooper());

    private FaceclawAlarms() {}

    // ------------------------------------------------------------------
    // Storage

    /**
     * Device-protected storage, so the schedule is readable before the first
     * unlock after a reboot (the reschedule receiver may run then on some
     * devices) and survives credential-encrypted storage being unavailable.
     */
    static SharedPreferences prefs(Context context) {
        Context base = context.getApplicationContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            base = base.createDeviceProtectedStorageContext();
        }
        return base.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private static synchronized JSONArray readArray(Context context, String key) {
        String raw = prefs(context).getString(key, "[]");
        try {
            return new JSONArray(raw);
        } catch (JSONException error) {
            return new JSONArray();
        }
    }

    private static synchronized void writeArray(Context context, String key, JSONArray array) {
        prefs(context).edit().putString(key, array.toString()).apply();
    }

    static JSONObject findScheduled(Context context, long id) {
        JSONArray scheduled = readArray(context, KEY_SCHEDULED);
        for (int index = 0; index < scheduled.length(); index++) {
            JSONObject entry = scheduled.optJSONObject(index);
            if (entry != null && entry.optLong("id") == id) {
                return entry;
            }
        }
        return null;
    }

    private static synchronized void putScheduled(Context context, JSONObject entry) {
        JSONArray scheduled = readArray(context, KEY_SCHEDULED);
        JSONArray next = new JSONArray();
        long id = entry.optLong("id");
        for (int index = 0; index < scheduled.length(); index++) {
            JSONObject existing = scheduled.optJSONObject(index);
            if (existing != null && existing.optLong("id") != id) {
                next.put(existing);
            }
        }
        next.put(entry);
        writeArray(context, KEY_SCHEDULED, next);
    }

    private static synchronized void removeScheduled(Context context, long id) {
        JSONArray scheduled = readArray(context, KEY_SCHEDULED);
        JSONArray next = new JSONArray();
        for (int index = 0; index < scheduled.length(); index++) {
            JSONObject existing = scheduled.optJSONObject(index);
            if (existing != null && existing.optLong("id") != id) {
                next.put(existing);
            }
        }
        writeArray(context, KEY_SCHEDULED, next);
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
    public static void schedule(
            Context context,
            long id,
            long triggerAtMs,
            String title,
            String text,
            String kind,
            int snoozeMinutes
    ) {
        Context appContext = context.getApplicationContext();
        JSONObject entry = new JSONObject();
        try {
            entry.put("id", id);
            entry.put("at", triggerAtMs);
            entry.put("title", title == null ? "" : title);
            entry.put("text", text == null ? "" : text);
            entry.put("kind", kind == null ? KIND_ALARM : kind);
            entry.put("snoozeMinutes", snoozeMinutes);
        } catch (JSONException ignored) {
            return;
        }
        putScheduled(appContext, entry);
        armAlarm(appContext, entry);
    }

    private static void armAlarm(Context appContext, JSONObject entry) {
        AlarmManager manager = (AlarmManager) appContext.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) {
            return;
        }
        long id = entry.optLong("id");
        long triggerAt = Math.max(System.currentTimeMillis(), entry.optLong("at"));
        PendingIntent fire = expiryPendingIntent(appContext, entry);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                AlarmManager.AlarmClockInfo info = new AlarmManager.AlarmClockInfo(triggerAt, showIntent(appContext, id));
                manager.setAlarmClock(info, fire);
            } else {
                manager.setExact(AlarmManager.RTC_WAKEUP, triggerAt, fire);
            }
        } catch (SecurityException error) {
            // Exact-alarm access revoked (Android 12/13 without USE_EXACT_ALARM
            // honoured): the inexact alarm is still a wake-up, just a late one.
            log(appContext, "exact alarm refused for " + id + ": " + error.getMessage());
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, fire);
        }
    }

    /** Cancel the phone alarm for an item, stop it if ringing, and forget it. */
    public static void cancel(Context context, long id) {
        Context appContext = context.getApplicationContext();
        AlarmManager manager = (AlarmManager) appContext.getSystemService(Context.ALARM_SERVICE);
        if (manager != null) {
            JSONObject entry = new JSONObject();
            try {
                entry.put("id", id);
            } catch (JSONException ignored) {
                // unreachable for a numeric put
            }
            manager.cancel(expiryPendingIntent(appContext, entry));
        }
        removeScheduled(appContext, id);
        FaceclawAlarmService.stopItem(appContext, id);
    }

    /**
     * Replay the persisted schedule into AlarmManager: after a reboot (alarms
     * are wiped), a package update, or a wall-clock / time-zone change. Entries
     * already due ring now if inside the grace window, else are dropped.
     */
    public static void rescheduleAll(Context context, String reason) {
        Context appContext = context.getApplicationContext();
        JSONArray scheduled = readArray(appContext, KEY_SCHEDULED);
        long now = System.currentTimeMillis();
        int armed = 0;
        for (int index = 0; index < scheduled.length(); index++) {
            JSONObject entry = scheduled.optJSONObject(index);
            if (entry == null) {
                continue;
            }
            long at = entry.optLong("at");
            if (at <= now) {
                if (now - at <= LATE_GRACE_MS) {
                    ringEntry(appContext, entry);
                } else {
                    log(appContext, "missed " + entry.optString("kind") + " " + entry.optLong("id") + " (" + reason + ")");
                    removeScheduled(appContext, entry.optLong("id"));
                }
                continue;
            }
            armAlarm(appContext, entry);
            armed++;
        }
        log(appContext, "rescheduled " + armed + " (" + reason + ")");
    }

    /**
     * The schedule and AlarmManager can disagree (a force-stop clears alarms
     * but not the file, an OEM killer drops them). True when the soonest
     * stored entry is not what the system reports as the next alarm clock.
     */
    public static boolean scheduleLooksStale(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
            return false;
        }
        Context appContext = context.getApplicationContext();
        JSONArray scheduled = readArray(appContext, KEY_SCHEDULED);
        long now = System.currentTimeMillis();
        long soonest = Long.MAX_VALUE;
        for (int index = 0; index < scheduled.length(); index++) {
            JSONObject entry = scheduled.optJSONObject(index);
            if (entry != null && entry.optLong("at") > now) {
                soonest = Math.min(soonest, entry.optLong("at"));
            }
        }
        if (soonest == Long.MAX_VALUE) {
            return false;
        }
        AlarmManager manager = (AlarmManager) appContext.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) {
            return false;
        }
        AlarmManager.AlarmClockInfo next = manager.getNextAlarmClock();
        // Another app's alarm may legitimately be sooner; only a later (or
        // absent) system alarm proves ours is missing.
        return next == null || next.getTriggerTime() > soonest + 1000;
    }

    // ------------------------------------------------------------------
    // Ringing

    /** An item came due: hand it to the ringing service (idempotent per id). */
    static void ringEntry(Context appContext, JSONObject entry) {
        FaceclawAlarmService.ring(
                appContext,
                entry.optLong("id"),
                entry.optString("title"),
                entry.optString("text"),
                entry.optString("kind", KIND_ALARM),
                entry.optInt("snoozeMinutes", 10)
        );
    }

    /** The JS engine's own expiry path; the service deduplicates against the alarm's. */
    public static void ring(Context context, long id, String title, String text, String kind, int snoozeMinutes) {
        Context appContext = context.getApplicationContext();
        AlarmManager manager = (AlarmManager) appContext.getSystemService(Context.ALARM_SERVICE);
        if (manager != null) {
            JSONObject probe = new JSONObject();
            try {
                probe.put("id", id);
            } catch (JSONException ignored) {
                // unreachable for a numeric put
            }
            manager.cancel(expiryPendingIntent(appContext, probe));
        }
        FaceclawAlarmService.ring(appContext, id, title, text, kind, snoozeMinutes);
    }

    /** The glasses are showing the ringing item; the acknowledgement clock starts now. */
    public static void deliveredToGlasses(Context context, long id) {
        FaceclawAlarmService.delivered(context.getApplicationContext(), id);
    }

    /** The wearer dismissed or snoozed it on the glasses: the phone side goes quiet. */
    public static void acknowledge(Context context, long id) {
        Context appContext = context.getApplicationContext();
        removeScheduled(appContext, id);
        FaceclawAlarmService.stopItem(appContext, id);
    }

    // ------------------------------------------------------------------
    // Glasses status (pushed by the JS side; in-memory, so a dead process reads as "no glasses")

    public static void setGlassesStatus(boolean connected, boolean worn, boolean charging) {
        glassesConnected = connected;
        glassesWorn = worn;
        glassesCharging = charging;
        glassesStatusAtMs = System.currentTimeMillis();
    }

    /** True only when a fresh report says the glasses are connected, on a head, and not charging. */
    static boolean glassesCanCarryAlarm() {
        long age = System.currentTimeMillis() - glassesStatusAtMs;
        if (glassesStatusAtMs == 0 || age > GLASSES_STATUS_MAX_AGE_MS) {
            return false;
        }
        return glassesConnected && glassesWorn && !glassesCharging;
    }

    static String glassesStatusDescription() {
        if (glassesStatusAtMs == 0) {
            return "no glasses status";
        }
        long age = System.currentTimeMillis() - glassesStatusAtMs;
        if (age > GLASSES_STATUS_MAX_AGE_MS) {
            return "glasses status stale";
        }
        if (!glassesConnected) {
            return "glasses not connected";
        }
        if (glassesCharging) {
            return "glasses charging";
        }
        if (!glassesWorn) {
            return "glasses not worn";
        }
        return "glasses worn";
    }

    // ------------------------------------------------------------------
    // Phone actions -> JS

    public static void setListener(FaceclawAlarmListener newListener) {
        listener = newListener;
    }

    /**
     * Record a dismiss / snooze done on the phone. Delivered live to the JS
     * listener when one is registered, and journaled regardless so a JS side
     * that was asleep or gone can catch up on its next boot.
     */
    static void recordPhoneAction(Context context, long id, String action, int minutes) {
        Context appContext = context.getApplicationContext();
        JSONObject event = new JSONObject();
        try {
            event.put("id", id);
            event.put("action", action);
            event.put("minutes", minutes);
            event.put("at", System.currentTimeMillis());
        } catch (JSONException ignored) {
            return;
        }
        synchronized (FaceclawAlarms.class) {
            JSONArray journal = readArray(appContext, KEY_JOURNAL);
            journal.put(event);
            writeArray(appContext, KEY_JOURNAL, journal);
        }
        log(appContext, "phone " + action + " " + id + (minutes > 0 ? " (" + minutes + " min)" : ""));
        final FaceclawAlarmListener current = listener;
        if (current != null) {
            mainHandler.post(() -> {
                try {
                    current.onPhoneAction(id, action, minutes);
                } catch (RuntimeException error) {
                    log(appContext, "listener failed: " + error.getMessage());
                }
            });
        }
    }

    /** Hand the journal to the JS side (as a JSON array) and clear it. */
    public static synchronized String drainJournal(Context context) {
        Context appContext = context.getApplicationContext();
        JSONArray journal = readArray(appContext, KEY_JOURNAL);
        writeArray(appContext, KEY_JOURNAL, new JSONArray());
        return journal.toString();
    }

    // ------------------------------------------------------------------
    // Reliability self-check

    /**
     * Conditions under which the phone may fail to ring, as a JSON array of
     * {code, message, fixable}, most serious first. Empty when everything is
     * in order. The UI shows these before the wearer relies on an alarm.
     */
    public static String checkReliability(Context context) {
        Context appContext = context.getApplicationContext();
        JSONArray issues = new JSONArray();
        NotificationManager notifications = (NotificationManager) appContext.getSystemService(Context.NOTIFICATION_SERVICE);
        AlarmManager alarms = (AlarmManager) appContext.getSystemService(Context.ALARM_SERVICE);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && alarms != null && !alarms.canScheduleExactAlarms()) {
            addIssue(issues, "exact-alarm", "Exact alarms are not allowed for Faceclaw, so alarms may ring late.", true);
        }
        if (notifications != null && !notifications.areNotificationsEnabled()) {
            addIssue(issues, "notifications", "Notifications are turned off for Faceclaw, so the phone cannot show or sound an alarm.", true);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && notifications != null) {
            NotificationChannel channel = notifications.getNotificationChannel(FaceclawAlarmService.CHANNEL_ID);
            if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE) {
                addIssue(issues, "alarm-channel", "The Alarms notification category is blocked, so the phone cannot show an alarm.", true);
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && notifications != null && !notifications.canUseFullScreenIntent()) {
            addIssue(issues, "full-screen", "Full-screen alarms are not allowed, so a ringing alarm will not take over the lock screen.", true);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && notifications != null) {
            int filter = notifications.getCurrentInterruptionFilter();
            if (filter == NotificationManager.INTERRUPTION_FILTER_NONE) {
                addIssue(issues, "dnd-total", "Do Not Disturb is set to total silence, which silences alarms too.", true);
            } else if (filter == NotificationManager.INTERRUPTION_FILTER_PRIORITY) {
                try {
                    NotificationManager.Policy policy = notifications.getNotificationPolicy();
                    if (policy != null && (policy.priorityCategories & NotificationManager.Policy.PRIORITY_CATEGORY_ALARMS) == 0) {
                        addIssue(issues, "dnd-alarms", "Do Not Disturb does not allow alarms, so the phone will stay silent.", true);
                    }
                } catch (SecurityException ignored) {
                    // No notification-policy access: cannot inspect the exceptions.
                }
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            ActivityManager activityManager = (ActivityManager) appContext.getSystemService(Context.ACTIVITY_SERVICE);
            if (activityManager != null && activityManager.isBackgroundRestricted()) {
                addIssue(issues, "background-restricted", "Background usage is restricted for Faceclaw, which blocks alarms while the app is not open.", true);
            }
        }
        PowerManager power = (PowerManager) appContext.getSystemService(Context.POWER_SERVICE);
        if (power != null && !power.isIgnoringBatteryOptimizations(appContext.getPackageName())) {
            addIssue(issues, "battery-optimized", "Battery optimization is on for Faceclaw; some phones delay alarms because of it.", true);
        }
        AudioManager audio = (AudioManager) appContext.getSystemService(Context.AUDIO_SERVICE);
        if (audio != null && audio.getStreamVolume(AudioManager.STREAM_ALARM) == 0) {
            addIssue(issues, "alarm-volume", "The phone's alarm volume is muted; Faceclaw raises it while ringing, but check it.", true);
        }
        String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase(Locale.ROOT);
        if (maker.contains("xiaomi") || maker.contains("huawei") || maker.contains("oppo") || maker.contains("vivo")
                || maker.contains("oneplus") || maker.contains("realme") || maker.contains("meizu") || maker.contains("asus")) {
            addIssue(issues, "oem-killer", "This phone maker is known to stop background apps; allow Faceclaw to auto-start and run unrestricted (see dontkillmyapp.com).", true);
        }
        if (scheduleLooksStale(appContext)) {
            addIssue(issues, "schedule-stale", "The system lost Faceclaw's next alarm (the app may have been force-stopped); it was re-armed.", false);
            rescheduleAll(appContext, "self-check");
        }
        return issues.toString();
    }

    private static void addIssue(JSONArray issues, String code, String message, boolean fixable) {
        JSONObject issue = new JSONObject();
        try {
            issue.put("code", code);
            issue.put("message", message);
            issue.put("fixable", fixable);
        } catch (JSONException ignored) {
            return;
        }
        issues.put(issue);
    }

    /** Open the system screen where the issue can be fixed. */
    public static void openReliabilityFix(Context context, String code) {
        Context appContext = context.getApplicationContext();
        String pkg = appContext.getPackageName();
        Intent intent;
        switch (code == null ? "" : code) {
            case "exact-alarm":
                intent = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                        ? new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + pkg))
                        : appDetails(pkg);
                break;
            case "notifications":
            case "alarm-channel":
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, pkg);
                    if ("alarm-channel".equals(code)) {
                        intent = new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                                .putExtra(Settings.EXTRA_APP_PACKAGE, pkg)
                                .putExtra(Settings.EXTRA_CHANNEL_ID, FaceclawAlarmService.CHANNEL_ID);
                    }
                } else {
                    intent = appDetails(pkg);
                }
                break;
            case "full-screen":
                intent = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
                        ? new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + pkg))
                        : appDetails(pkg);
                break;
            case "dnd-total":
            case "dnd-alarms":
                intent = new Intent(Settings.ACTION_SOUND_SETTINGS);
                break;
            case "battery-optimized":
                intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + pkg));
                break;
            case "alarm-volume":
                intent = new Intent(Settings.ACTION_SOUND_SETTINGS);
                break;
            default:
                intent = appDetails(pkg);
                break;
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            appContext.startActivity(intent);
        } catch (RuntimeException error) {
            Intent fallback = appDetails(pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                appContext.startActivity(fallback);
            } catch (RuntimeException ignored) {
                // No settings activity at all; nothing more to do.
            }
        }
    }

    private static Intent appDetails(String pkg) {
        return new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg));
    }

    // ------------------------------------------------------------------
    // Diagnostics log

    static synchronized void log(Context context, String line) {
        Context appContext = context.getApplicationContext();
        JSONArray log = readArray(appContext, KEY_LOG);
        JSONArray next = new JSONArray();
        int start = Math.max(0, log.length() - (LOG_LINES - 1));
        for (int index = start; index < log.length(); index++) {
            next.put(log.optString(index));
        }
        next.put(System.currentTimeMillis() + " " + line);
        writeArray(appContext, KEY_LOG, next);
    }

    /** The ring / miss / action log, newest last, one line per entry. */
    public static String readLog(Context context) {
        JSONArray log = readArray(context.getApplicationContext(), KEY_LOG);
        StringBuilder out = new StringBuilder();
        for (int index = 0; index < log.length(); index++) {
            if (index > 0) {
                out.append('\n');
            }
            out.append(log.optString(index));
        }
        return out.toString();
    }

    // ------------------------------------------------------------------
    // Intents

    private static PendingIntent expiryPendingIntent(Context appContext, JSONObject entry) {
        Intent intent = new Intent(appContext, FaceclawAlarmReceiver.class);
        intent.setAction(ACTION_EXPIRE);
        long id = entry.optLong("id");
        intent.putExtra(EXTRA_ID, id);
        intent.putExtra(EXTRA_TITLE, entry.optString("title"));
        intent.putExtra(EXTRA_TEXT, entry.optString("text"));
        intent.putExtra(EXTRA_KIND, entry.optString("kind", KIND_ALARM));
        intent.putExtra(EXTRA_SNOOZE_MINUTES, entry.optInt("snoozeMinutes", 10));
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getBroadcast(appContext, requestCode(id), intent, flags);
    }

    /** What the system's alarm indicator opens: the app. */
    private static PendingIntent showIntent(Context appContext, long id) {
        Intent intent = new Intent(appContext, NativeScriptActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getActivity(appContext, requestCode(id), intent, flags);
    }

    static int requestCode(long id) {
        return (int) (id ^ (id >>> 32)) & 0x7fffffff;
    }

    static void startServiceCompat(Context appContext, Intent intent) {
        ContextCompat.startForegroundService(appContext, intent);
    }
}
