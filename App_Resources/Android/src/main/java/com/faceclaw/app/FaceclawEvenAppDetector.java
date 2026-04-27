package com.faceclaw.app;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import android.util.Log;

public final class FaceclawEvenAppDetector {
    private static final String TAG = "FaceclawEvenApp";

    public static final String EVEN_PACKAGE_NAME = "com.even.sg";
    public static final String EVEN_NOTIFICATION_TITLE = "Even Notification Service";

    private FaceclawEvenAppDetector() {
    }

    public static boolean isNotificationAccessEnabled(Context context) {
        if (context == null) {
            return false;
        }
        Context appContext = context.getApplicationContext();
        ComponentName listenerComponent = new ComponentName(appContext, FaceclawMediaNotificationListenerService.class);
        String enabledListeners = Settings.Secure.getString(
                appContext.getContentResolver(),
                "enabled_notification_listeners"
        );
        if (enabledListeners == null || enabledListeners.isEmpty()) {
            return false;
        }
        String fullName = listenerComponent.flattenToString();
        String shortName = listenerComponent.flattenToShortString();
        return enabledListeners.contains(fullName)
                || enabledListeners.contains(shortName)
                || enabledListeners.contains(appContext.getPackageName());
    }

    public static boolean isEvenNotificationActive(Context context) {
        boolean hasAccess = isNotificationAccessEnabled(context);
        if (!hasAccess) {
            Log.i(TAG, "Can't check for Even Realities app notification, permission is not enabled");
            return false;
        }
        boolean hasNotfication = FaceclawMediaNotificationListenerService.hasActiveNotificationTitle(EVEN_NOTIFICATION_TITLE);
        Log.i(TAG, "isEvenNotificationActive: " + hasNotfication);
        return hasNotfication;
    }

    public static void openEvenAppSettings(Context context) {
        if (context == null) {
            return;
        }
        Context appContext = context.getApplicationContext();
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.parse("package:" + EVEN_PACKAGE_NAME));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            appContext.startActivity(intent);
        } catch (Throwable t) {
            Log.w(TAG, "failed to open Even app settings", t);
            openNotificationAccessSettings(appContext);
        }
    }

    public static void openNotificationAccessSettings(Context context) {
        if (context == null) {
            return;
        }
        Context appContext = context.getApplicationContext();
        Intent intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            appContext.startActivity(intent);
        } catch (Throwable t) {
            Log.w(TAG, "failed to open notification access settings", t);
        }
    }
}
