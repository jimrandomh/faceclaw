package com.faceclaw.app;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import com.tns.NativeScriptActivity;

/**
 * Android alarm + notification bridge used by the on-glasses Timers app, for
 * countdown timers and alarms alike: one AlarmManager alarm per item posts a
 * phone notification at the moment of expiry, even when the app process is
 * asleep or gone.
 */
public final class FaceclawTimerNotifications {
    public static final String CHANNEL_ID = "faceclaw-timers";
    static final String ACTION_EXPIRE = "com.faceclaw.app.action.TIMER_EXPIRE";
    static final String EXTRA_TIMER_ID = "timerId";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";

    private static final String TIMER_TAG_PREFIX = "faceclaw-timer:";
    private static final String PREFS_NAME = "faceclaw-timer-notifications";
    private static final String FIRED_KEY_PREFIX = "fired:";

    private FaceclawTimerNotifications() {}

    /**
     * Schedule an Android alarm as the durable path. The engine also keeps a
     * normal JS timeout for prompt delivery while the process is awake.
     */
    public static void schedule(Context context, long timerId, long triggerAtMs, String title, String text) {
        Context appContext = context.getApplicationContext();
        preferences(appContext).edit().putBoolean(firedKey(timerId), false).apply();

        AlarmManager manager = (AlarmManager) appContext.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) {
            return;
        }
        PendingIntent pendingIntent = expiryPendingIntent(appContext, timerId, title, text);
        long triggerAt = Math.max(System.currentTimeMillis(), triggerAtMs);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !manager.canScheduleExactAlarms()) {
                manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent);
            } else {
                manager.setExact(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent);
            }
        } catch (SecurityException ignored) {
            // Exact-alarm access can be disabled by the user on recent Android.
            // The inexact alarm remains a durable backup to the worker timeout.
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent);
        }
    }

    public static void cancel(Context context, long timerId) {
        Context appContext = context.getApplicationContext();
        AlarmManager alarmManager = (AlarmManager) appContext.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager != null) {
            alarmManager.cancel(expiryPendingIntent(appContext, timerId, "", ""));
        }
        NotificationManager notificationManager =
                (NotificationManager) appContext.getSystemService(Context.NOTIFICATION_SERVICE);
        if (notificationManager != null) {
            notificationManager.cancel(notificationTag(timerId), notificationId(timerId));
        }
        preferences(appContext).edit().remove(firedKey(timerId)).apply();
    }

    /** Engine-timeout path. Cancels the backup alarm and posts at most once. */
    public static void fireNow(Context context, long timerId, String title, String text) {
        Context appContext = context.getApplicationContext();
        AlarmManager alarmManager = (AlarmManager) appContext.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager != null) {
            alarmManager.cancel(expiryPendingIntent(appContext, timerId, title, text));
        }
        showExpiredOnce(appContext, timerId, title, text);
    }

    static synchronized void showExpiredOnce(Context context, long timerId, String title, String text) {
        SharedPreferences preferences = preferences(context);
        String firedKey = firedKey(timerId);
        if (preferences.getBoolean(firedKey, false)) {
            return;
        }
        preferences.edit().putBoolean(firedKey, true).apply();
        ensureChannel(context);

        Intent launchIntent = new Intent(context, NativeScriptActivity.class);
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int contentFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            contentFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent contentIntent = PendingIntent.getActivity(
                context,
                notificationId(timerId),
                launchIntent,
                contentFlags
        );

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, CHANNEL_ID)
                : new Notification.Builder(context);
        String contentTitle = title == null || title.trim().isEmpty() ? "Timer finished" : title;
        String contentText = text == null || text.trim().isEmpty() ? "Time's up" : text;
        Notification notification = builder
                .setContentTitle(contentTitle)
                .setContentText(contentText)
                .setSmallIcon(context.getApplicationInfo().icon)
                .setContentIntent(contentIntent)
                .setCategory(Notification.CATEGORY_ALARM)
                .setAutoCancel(true)
                .setWhen(System.currentTimeMillis())
                .setShowWhen(true)
                .build();

        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(notificationTag(timerId), notificationId(timerId), notification);
        }
    }

    /** Identifies this bridge's notifications among our own package's (see the listener service). */
    public static boolean isTimerNotification(android.service.notification.StatusBarNotification item) {
        if (item == null || item.getNotification() == null) {
            return false;
        }
        String tag = item.getTag();
        if (tag != null && tag.startsWith(TIMER_TAG_PREFIX)) {
            return true;
        }
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && CHANNEL_ID.equals(item.getNotification().getChannelId());
    }

    private static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Timers",
                NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Alerts when a Faceclaw timer finishes.");
        channel.enableVibration(true);
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }

    private static PendingIntent expiryPendingIntent(
            Context context,
            long timerId,
            String title,
            String text
    ) {
        Intent intent = new Intent(context, FaceclawTimerReceiver.class);
        intent.setAction(ACTION_EXPIRE);
        intent.putExtra(EXTRA_TIMER_ID, timerId);
        intent.putExtra(EXTRA_TITLE, title == null ? "" : title);
        intent.putExtra(EXTRA_TEXT, text == null ? "" : text);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getBroadcast(context, notificationId(timerId), intent, flags);
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private static String firedKey(long timerId) {
        return FIRED_KEY_PREFIX + timerId;
    }

    private static String notificationTag(long timerId) {
        return TIMER_TAG_PREFIX + timerId;
    }

    private static int notificationId(long timerId) {
        return (int) (timerId ^ (timerId >>> 32)) & 0x7fffffff;
    }
}
