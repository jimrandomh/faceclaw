package com.faceclaw.app;

import android.app.Notification;
import android.app.NotificationManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.Icon;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import java.io.ByteArrayOutputStream;

public class FaceclawMediaNotificationListenerService extends NotificationListenerService {
    private static final String TAG = "FaceclawNotify";
    private static final double NOTIFICATION_ICON_GAMMA = 1.6;

    private static volatile FaceclawMediaNotificationListenerService activeService;

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
    }

    @Override
    public void onListenerDisconnected() {
        if (activeService == this) {
            activeService = null;
        }
        super.onListenerDisconnected();
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
        int emitted = 0;
        for (StatusBarNotification statusBarNotification : notifications) {
            if (!shouldShowNotificationIcon(service, statusBarNotification)) {
                continue;
            }
            Drawable drawable = loadNotificationIcon(service, statusBarNotification.getNotification());
            if (drawable == null) {
                continue;
            }
            appendIconGrayBytes(drawable, size, out);
            emitted += 1;
            if (emitted >= limit) {
                break;
            }
        }
        return out.toByteArray();
    }

    private static boolean shouldShowNotificationIcon(FaceclawMediaNotificationListenerService service, StatusBarNotification statusBarNotification) {
        if (statusBarNotification == null || statusBarNotification.getNotification() == null) {
            return false;
        }
        if (service.getPackageName().equals(statusBarNotification.getPackageName())) {
            return false;
        }
        Notification notification = statusBarNotification.getNotification();
        if ((notification.flags & Notification.FLAG_GROUP_SUMMARY) != 0) {
            return false;
        }
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

    private static Drawable loadNotificationIcon(FaceclawMediaNotificationListenerService service, Notification notification) {
        try {
            Icon smallIcon = notification.getSmallIcon();
            if (smallIcon != null) {
                Drawable drawable = smallIcon.loadDrawable(service);
                if (drawable != null) {
                    return drawable;
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "failed to load small notification icon", t);
        }
        try {
            Icon largeIcon = notification.getLargeIcon();
            if (largeIcon != null) {
                return largeIcon.loadDrawable(service);
            }
        } catch (Throwable t) {
            Log.w(TAG, "failed to load large notification icon", t);
        }
        return null;
    }

    private static void appendIconGrayBytes(Drawable drawable, int size, ByteArrayOutputStream out) {
        Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        drawable.setBounds(0, 0, size, size);
        drawable.draw(canvas);
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
}
