package com.faceclaw.app;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.Icon;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public class FaceclawMediaNotificationListenerService extends NotificationListenerService {
    private static final String TAG = "FaceclawNotify";
    private static final double NOTIFICATION_ICON_GAMMA = 1.6;
    private static final String EXTRA_SUBSTITUTE_APP_NAME = "android.substName";

    private static volatile FaceclawMediaNotificationListenerService activeService;
    private static final Handler mainHandler = new Handler(Looper.getMainLooper());
    private static final Set<FaceclawNotificationListener> notificationListeners = new CopyOnWriteArraySet<>();
    private static final Set<String> activeNotificationWakeKeys = new HashSet<>();

    @Override
    public void onCreate() {
        super.onCreate();
        activeService = this;
    }

    @Override
    public void onDestroy() {
        if (activeService == this) {
            activeService = null;
        }
        super.onDestroy();
    }

    @Override
    public void onListenerConnected() {
        activeService = this;
        super.onListenerConnected();
        refreshActiveNotificationWakeKeys(this);
    }

    @Override
    public void onListenerDisconnected() {
        if (activeService == this) {
            activeService = null;
        }
        super.onListenerDisconnected();
    }

    @Override
    public void onNotificationPosted(StatusBarNotification statusBarNotification) {
        super.onNotificationPosted(statusBarNotification);
        if (!shouldShowNotificationInList(this, statusBarNotification)) {
            forgetActiveNotificationWakeKey(statusBarNotification);
            return;
        }
        if (shouldEmitNotificationPosted(statusBarNotification)) {
            emitNotificationPosted(statusBarNotification.getKey());
        }
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification statusBarNotification) {
        forgetActiveNotificationWakeKey(statusBarNotification);
        super.onNotificationRemoved(statusBarNotification);
    }

    public static void addNotificationListener(FaceclawNotificationListener listener) {
        if (listener != null) {
            notificationListeners.add(listener);
        }
    }

    public static void removeNotificationListener(FaceclawNotificationListener listener) {
        if (listener != null) {
            notificationListeners.remove(listener);
        }
    }

    public static boolean hasActiveNotificationTitle(String expectedTitle) {
        FaceclawMediaNotificationListenerService service = activeService;
        if (service == null || expectedTitle == null || expectedTitle.isEmpty()) {
            return false;
        }
        StatusBarNotification[] notifications;
        try {
            notifications = service.getActiveNotifications();
        } catch (SecurityException e) {
            Log.w(TAG, "notification access denied while checking active notifications", e);
            return false;
        } catch (Throwable t) {
            Log.w(TAG, "failed to check active notifications", t);
            return false;
        }
        if (notifications == null || notifications.length == 0) {
            return false;
        }
        for (StatusBarNotification notification : notifications) {
            if (notification == null || notification.getNotification() == null) {
                continue;
            }
            Bundle extras = notification.getNotification().extras;
            if (extras == null) {
                continue;
            }
            CharSequence title = extras.getCharSequence(Notification.EXTRA_TITLE);
            if (title != null && expectedTitle.contentEquals(title)) {
                return true;
            }
        }
        return false;
    }

    public static byte[] getActiveNotificationIconGrays(int iconSize, int maxIcons) {
        FaceclawMediaNotificationListenerService service = activeService;
        int size = Math.max(1, Math.min(96, iconSize));
        int limit = Math.max(0, maxIcons);
        if (service == null || limit == 0) {
            return new byte[0];
        }

        StatusBarNotification[] notifications;
        try {
            notifications = service.getActiveNotifications();
        } catch (SecurityException e) {
            Log.w(TAG, "notification access denied while reading icons", e);
            return new byte[0];
        } catch (Throwable t) {
            Log.w(TAG, "failed to read notification icons", t);
            return new byte[0];
        }
        if (notifications == null || notifications.length == 0) {
            return new byte[0];
        }

        ByteArrayOutputStream out = new ByteArrayOutputStream(size * size * Math.min(limit, notifications.length));
        Set<String> emittedGroupKeys = new HashSet<>();
        int emitted = 0;
        for (StatusBarNotification statusBarNotification : notifications) {
            if (!shouldShowNotificationIcon(service, statusBarNotification)) {
                continue;
            }
            String dedupeGroupKey = getNotificationDedupeGroupKey(statusBarNotification);
            if (dedupeGroupKey != null && emittedGroupKeys.contains(dedupeGroupKey)) {
                continue;
            }
            Drawable drawable = loadNotificationIcon(service, statusBarNotification.getNotification());
            if (drawable == null) {
                Log.i(TAG, "icon skipped (no drawable): " + statusBarNotification.getPackageName());
                continue;
            }
            Log.i(TAG, "icon[" + emitted + "] pkg=" + statusBarNotification.getPackageName()
                    + " drawable=" + drawable.getClass().getSimpleName()
                    + " intrinsic=" + drawable.getIntrinsicWidth() + "x" + drawable.getIntrinsicHeight());
            appendIconGrayBytes(drawable, size, out, service, emitted, statusBarNotification.getPackageName());
            if (dedupeGroupKey != null) {
                emittedGroupKeys.add(dedupeGroupKey);
            }
            emitted += 1;
            if (emitted >= limit) {
                break;
            }
        }
        return out.toByteArray();
    }

    /**
     * Grayscale icon (iconSize*iconSize bytes) for one active notification,
     * identified by its key; empty array when the notification or its icon is
     * unavailable. Shares the extraction/scaling pipeline with the tray icon
     * strip above.
     */
    public static byte[] getNotificationIconGrayForKey(String key, int iconSize) {
        FaceclawMediaNotificationListenerService service = activeService;
        int size = Math.max(1, Math.min(96, iconSize));
        if (service == null) {
            return new byte[0];
        }
        StatusBarNotification statusBarNotification = findActiveNotificationByKey(service, key);
        if (statusBarNotification == null || statusBarNotification.getNotification() == null) {
            return new byte[0];
        }
        Drawable drawable = loadNotificationIcon(service, statusBarNotification.getNotification());
        if (drawable == null) {
            return new byte[0];
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream(size * size);
        appendIconGrayBytes(drawable, size, out, service, -1, statusBarNotification.getPackageName());
        return out.toByteArray();
    }

    public static String getActiveNotificationsJson(int maxNotifications) {
        FaceclawMediaNotificationListenerService service = activeService;
        int limit = Math.max(0, Math.min(100, maxNotifications));
        if (service == null || limit == 0) {
            return "[]";
        }

        StatusBarNotification[] notifications;
        try {
            notifications = service.getActiveNotifications();
        } catch (SecurityException e) {
            Log.w(TAG, "notification access denied while reading notifications", e);
            return "[]";
        } catch (Throwable t) {
            Log.w(TAG, "failed to read notifications", t);
            return "[]";
        }
        if (notifications == null || notifications.length == 0) {
            return "[]";
        }

        Arrays.sort(notifications, new Comparator<StatusBarNotification>() {
            @Override
            public int compare(StatusBarNotification a, StatusBarNotification b) {
                long left = a == null ? 0 : a.getPostTime();
                long right = b == null ? 0 : b.getPostTime();
                return Long.compare(right, left);
            }
        });

        JSONArray out = new JSONArray();
        for (StatusBarNotification statusBarNotification : notifications) {
            if (out.length() >= limit) {
                break;
            }
            if (!shouldShowNotificationInList(service, statusBarNotification)) {
                continue;
            }
            try {
                out.put(buildNotificationJson(service, statusBarNotification));
            } catch (Throwable t) {
                Log.w(TAG, "failed to serialize notification", t);
            }
        }
        return out.toString();
    }

    public static boolean invokeNotificationAction(String key, int actionIndex) {
        FaceclawMediaNotificationListenerService service = activeService;
        StatusBarNotification statusBarNotification = findActiveNotificationByKey(service, key);
        if (statusBarNotification == null || statusBarNotification.getNotification() == null) {
            return false;
        }
        Notification.Action[] actions = statusBarNotification.getNotification().actions;
        if (actions == null || actionIndex < 0 || actionIndex >= actions.length) {
            return false;
        }
        PendingIntent intent = actions[actionIndex].actionIntent;
        if (intent == null) {
            return false;
        }
        try {
            intent.send();
            return true;
        } catch (PendingIntent.CanceledException e) {
            Log.w(TAG, "notification action pending intent was canceled", e);
            return false;
        } catch (Throwable t) {
            Log.w(TAG, "failed to invoke notification action", t);
            return false;
        }
    }

    public static boolean dismissNotification(String key) {
        FaceclawMediaNotificationListenerService service = activeService;
        if (service == null || key == null || key.isEmpty()) {
            return false;
        }
        try {
            service.cancelNotification(key);
            return true;
        } catch (SecurityException e) {
            Log.w(TAG, "notification access denied while dismissing notification", e);
            return false;
        } catch (Throwable t) {
            Log.w(TAG, "failed to dismiss notification", t);
            return false;
        }
    }

    private static void emitNotificationPosted(String key) {
        if (key == null || key.isEmpty() || notificationListeners.isEmpty()) {
            return;
        }
        for (FaceclawNotificationListener listener : notificationListeners) {
            mainHandler.post(() -> {
                try {
                    listener.onNotificationPosted(key);
                } catch (Throwable t) {
                    Log.w(TAG, "notification listener failed", t);
                }
            });
        }
    }

    private static void refreshActiveNotificationWakeKeys(FaceclawMediaNotificationListenerService service) {
        StatusBarNotification[] notifications;
        try {
            notifications = service.getActiveNotifications();
        } catch (Throwable t) {
            Log.w(TAG, "failed to refresh active notification wake keys", t);
            return;
        }
        synchronized (activeNotificationWakeKeys) {
            activeNotificationWakeKeys.clear();
            if (notifications == null) {
                return;
            }
            for (StatusBarNotification statusBarNotification : notifications) {
                if (shouldShowNotificationInList(service, statusBarNotification)) {
                    String key = statusBarNotification.getKey();
                    if (key != null && !key.isEmpty()) {
                        activeNotificationWakeKeys.add(key);
                    }
                }
            }
        }
    }

    private static boolean shouldEmitNotificationPosted(StatusBarNotification statusBarNotification) {
        String key = statusBarNotification.getKey();
        if (key == null || key.isEmpty()) {
            return true;
        }

        boolean alreadyActive;
        synchronized (activeNotificationWakeKeys) {
            alreadyActive = activeNotificationWakeKeys.contains(key);
            activeNotificationWakeKeys.add(key);
        }
        return !alreadyActive || !isPersistentNotification(statusBarNotification);
    }

    private static void forgetActiveNotificationWakeKey(StatusBarNotification statusBarNotification) {
        if (statusBarNotification == null) {
            return;
        }
        String key = statusBarNotification.getKey();
        if (key == null || key.isEmpty()) {
            return;
        }
        synchronized (activeNotificationWakeKeys) {
            activeNotificationWakeKeys.remove(key);
        }
    }

    private static boolean isPersistentNotification(StatusBarNotification statusBarNotification) {
        Notification notification = statusBarNotification.getNotification();
        if (notification == null) {
            return false;
        }
        int persistentFlags = Notification.FLAG_ONGOING_EVENT | Notification.FLAG_NO_CLEAR;
        return (notification.flags & persistentFlags) != 0;
    }

    private static boolean shouldShowNotificationIcon(FaceclawMediaNotificationListenerService service, StatusBarNotification statusBarNotification) {
        if (!shouldShowNotificationInList(service, statusBarNotification)) {
            return false;
        }
        Notification notification = statusBarNotification.getNotification();
        if ((notification.flags & Notification.FLAG_GROUP_SUMMARY) != 0) {
            return false;
        }
        return true;
    }

    private static boolean shouldShowNotificationInList(FaceclawMediaNotificationListenerService service, StatusBarNotification statusBarNotification) {
        if (statusBarNotification == null || statusBarNotification.getNotification() == null) {
            return false;
        }
        // Our own notifications stay out of the mirror: the foreground-service
        // one is noise, and the Timers app rings on the glasses itself (its
        // phone notification is for the phone), so mirroring it would stack a
        // notification modal over the ringing screen.
        if (service.getPackageName().equals(statusBarNotification.getPackageName())) {
            return false;
        }
        Notification notification = statusBarNotification.getNotification();
        if (Notification.CATEGORY_TRANSPORT.equals(notification.category)) {
            return false;
        }
        Bundle extras = notification.extras;
        if (extras != null && extras.containsKey("android.mediaSession")) {
            return false;
        }

        NotificationListenerService.RankingMap rankingMap = service.getCurrentRanking();
        if (rankingMap == null) {
            return true;
        }
        NotificationListenerService.Ranking ranking = new NotificationListenerService.Ranking();
        if (!rankingMap.getRanking(statusBarNotification.getKey(), ranking)) {
            return true;
        }
        int importance = ranking.getImportance();
        return importance > NotificationManager.IMPORTANCE_MIN;
    }

    private static String getNotificationDedupeGroupKey(StatusBarNotification statusBarNotification) {
        Notification notification = statusBarNotification.getNotification();
        if (notification.getGroup() == null && statusBarNotification.getOverrideGroupKey() == null) {
            return null;
        }
        String groupKey = statusBarNotification.getGroupKey();
        if (groupKey == null || groupKey.isEmpty()) {
            return null;
        }
        // Group children often share the same small icon. Emit only one icon for the group.
        return groupKey;
    }

    private static Drawable loadNotificationIcon(FaceclawMediaNotificationListenerService service, Notification notification) {
        try {
            Icon smallIcon = notification.getSmallIcon();
            if (smallIcon != null) {
                Drawable drawable = smallIcon.loadDrawable(service);
                if (drawable != null) {
                    // Status-bar small icons are alpha templates: the platform
                    // draws them tinted and ignores their color channels, which
                    // apps may fill with garbage (Discord ships noise there).
                    // Tint white so the shape comes from alpha alone, matching
                    // how the status bar renders them.
                    drawable.mutate();
                    drawable.setTint(Color.WHITE);
                    if (drawable instanceof BitmapDrawable) {
                        ((BitmapDrawable) drawable).setFilterBitmap(true);
                    }
                    return drawable;
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "failed to load small notification icon", t);
        }
        try {
            // Large icons are real color images (avatars, album art); keep color.
            Icon largeIcon = notification.getLargeIcon();
            if (largeIcon != null) {
                return largeIcon.loadDrawable(service);
            }
        } catch (Throwable t) {
            Log.w(TAG, "failed to load large notification icon", t);
        }
        return null;
    }

    private static void appendIconGrayBytes(Drawable drawable, int size, ByteArrayOutputStream out,
            FaceclawMediaNotificationListenerService service, int index, String packageName) {
        Bitmap bitmap = renderIconScaled(drawable, size);
        dumpIconDebugPng(service, index, packageName, bitmap);
        for (int y = 0; y < size; y++) {
            for (int x = 0; x < size; x++) {
                int color = bitmap.getPixel(x, y);
                int alpha = Color.alpha(color);
                double grayLinear = (0.2126 * Color.red(color) + 0.7152 * Color.green(color) + 0.0722 * Color.blue(color)) * alpha / (255.0 * 255.0);
                int gray = (int) Math.round(255.0 * Math.pow(Math.max(0.0, Math.min(1.0, grayLinear)), NOTIFICATION_ICON_GAMMA));
                out.write(gray & 0xff);
            }
        }
        bitmap.recycle();
    }

    /**
     * Render a drawable at the target size with proper downscaling. Detailed
     * sources (e.g. avatar bitmaps used as notification icons) are rendered at
     * native resolution and reduced by repeated halving: a single filtered pass
     * from, say, 126px to 24px samples too sparsely and turns fine detail into
     * speckle that reads as a garbled icon.
     */
    private static Bitmap renderIconScaled(Drawable drawable, int size) {
        int renderW = Math.max(size, drawable.getIntrinsicWidth());
        int renderH = Math.max(size, drawable.getIntrinsicHeight());
        Bitmap bitmap = Bitmap.createBitmap(renderW, renderH, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        drawable.setBounds(0, 0, renderW, renderH);
        drawable.draw(canvas);
        while (bitmap.getWidth() >= size * 2 && bitmap.getHeight() >= size * 2) {
            Bitmap halved = Bitmap.createScaledBitmap(bitmap, bitmap.getWidth() / 2, bitmap.getHeight() / 2, true);
            bitmap.recycle();
            bitmap = halved;
        }
        if (bitmap.getWidth() != size || bitmap.getHeight() != size) {
            Bitmap scaled = Bitmap.createScaledBitmap(bitmap, size, size, true);
            bitmap.recycle();
            bitmap = scaled;
        }
        return bitmap;
    }

    /**
     * Debug aid for garbled-icon reports: saves each rendered icon to
     * <externalFilesDir>/debug-icons/ (adb-pullable) so extraction problems can
     * be told apart from downstream compositing/transmission problems. Cheap:
     * runs at most once per icon-cache refresh on tiny bitmaps.
     */
    private static void dumpIconDebugPng(FaceclawMediaNotificationListenerService service, int index, String packageName, Bitmap bitmap) {
        if (index < 0) {
            return;
        }
        try {
            java.io.File dir = new java.io.File(service.getExternalFilesDir(null), "debug-icons");
            if (!dir.exists() && !dir.mkdirs()) {
                return;
            }
            String safeName = packageName == null ? "unknown" : packageName.replaceAll("[^A-Za-z0-9._-]", "_");
            java.io.File file = new java.io.File(dir, "icon-" + index + "-" + safeName + ".png");
            try (java.io.FileOutputStream stream = new java.io.FileOutputStream(file)) {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream);
            }
        } catch (Throwable t) {
            Log.w(TAG, "failed to dump debug icon", t);
        }
    }

    private static StatusBarNotification findActiveNotificationByKey(FaceclawMediaNotificationListenerService service, String key) {
        if (service == null || key == null || key.isEmpty()) {
            return null;
        }
        StatusBarNotification[] notifications;
        try {
            notifications = service.getActiveNotifications();
        } catch (Throwable t) {
            Log.w(TAG, "failed to find active notification", t);
            return null;
        }
        if (notifications == null) {
            return null;
        }
        for (StatusBarNotification statusBarNotification : notifications) {
            if (statusBarNotification != null && key.equals(statusBarNotification.getKey())) {
                return statusBarNotification;
            }
        }
        return null;
    }

    private static JSONObject buildNotificationJson(FaceclawMediaNotificationListenerService service, StatusBarNotification statusBarNotification)
            throws JSONException {
        Notification notification = statusBarNotification.getNotification();
        Bundle extras = notification.extras;
        JSONObject out = new JSONObject();
        out.put("key", statusBarNotification.getKey());
        out.put("packageName", statusBarNotification.getPackageName());
        out.put("appName", getNotificationAppName(service, statusBarNotification));
        out.put("postTime", statusBarNotification.getPostTime());
        out.put("when", notification.when);
        putString(out, "category", notification.category);
        if (extras != null) {
            putCharSequence(out, "title", firstNonEmpty(
                    extras.getCharSequence(Notification.EXTRA_TITLE_BIG),
                    extras.getCharSequence(Notification.EXTRA_TITLE)
            ));
            putCharSequence(out, "text", extras.getCharSequence(Notification.EXTRA_TEXT));
            putCharSequence(out, "bigText", extras.getCharSequence(Notification.EXTRA_BIG_TEXT));
            putCharSequence(out, "subText", extras.getCharSequence(Notification.EXTRA_SUB_TEXT));
            putCharSequence(out, "infoText", extras.getCharSequence(Notification.EXTRA_INFO_TEXT));
            putCharSequence(out, "summaryText", extras.getCharSequence(Notification.EXTRA_SUMMARY_TEXT));
            CharSequence[] textLines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
            JSONArray lines = new JSONArray();
            if (textLines != null) {
                for (CharSequence line : textLines) {
                    String text = charSequenceToString(line);
                    if (!text.isEmpty()) {
                        lines.put(text);
                    }
                }
            }
            out.put("lines", lines);
        } else {
            out.put("lines", new JSONArray());
        }

        JSONArray actionsJson = new JSONArray();
        Notification.Action[] actions = notification.actions;
        if (actions != null) {
            for (int index = 0; index < actions.length; index++) {
                Notification.Action action = actions[index];
                if (action == null) {
                    continue;
                }
                String title = charSequenceToString(action.title);
                if (title.isEmpty()) {
                    continue;
                }
                JSONObject actionJson = new JSONObject();
                actionJson.put("index", index);
                actionJson.put("title", title);
                actionJson.put("enabled", action.actionIntent != null);
                actionsJson.put(actionJson);
            }
        }
        out.put("actions", actionsJson);
        return out;
    }

    private static String getNotificationAppName(FaceclawMediaNotificationListenerService service, StatusBarNotification statusBarNotification) {
        Notification notification = statusBarNotification.getNotification();
        Bundle extras = notification.extras;
        if (extras != null) {
            String substituteName = charSequenceToString(extras.getCharSequence(EXTRA_SUBSTITUTE_APP_NAME));
            if (!substituteName.isEmpty()) {
                return substituteName;
            }
        }
        return getAppLabel(service, statusBarNotification.getPackageName());
    }

    private static String getAppLabel(FaceclawMediaNotificationListenerService service, String packageName) {
        if (packageName == null || packageName.isEmpty()) {
            return "";
        }
        try {
            CharSequence label = service
                    .getPackageManager()
                    .getApplicationLabel(service.getPackageManager().getApplicationInfo(packageName, 0));
            String text = charSequenceToString(label);
            return text.isEmpty() ? packageName : text;
        } catch (Throwable t) {
            return packageName;
        }
    }

    private static void putString(JSONObject out, String key, String value) throws JSONException {
        out.put(key, value == null ? "" : value);
    }

    private static void putCharSequence(JSONObject out, String key, CharSequence value) throws JSONException {
        out.put(key, charSequenceToString(value));
    }

    private static CharSequence firstNonEmpty(CharSequence first, CharSequence second) {
        return charSequenceToString(first).isEmpty() ? second : first;
    }

    private static String charSequenceToString(CharSequence value) {
        return value == null ? "" : value.toString();
    }
}
