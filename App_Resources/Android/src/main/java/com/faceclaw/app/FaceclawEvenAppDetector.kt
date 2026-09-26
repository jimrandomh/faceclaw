package com.faceclaw.app

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.util.Log

class FaceclawEvenAppDetector private constructor() {
    companion object {
        private const val TAG = "FaceclawEvenApp"

        const val EVEN_PACKAGE_NAME = "com.even.sg"
        const val EVEN_NOTIFICATION_TITLE = "Even Notification Service"

        @JvmStatic
        fun isNotificationAccessEnabled(context: Context?): Boolean {
            if (context == null) {
                return false
            }
            val appContext = context.applicationContext
            val listenerComponent = ComponentName(appContext, FaceclawMediaNotificationListenerService::class.java)
            val enabledListeners = Settings.Secure.getString(
                appContext.contentResolver,
                "enabled_notification_listeners"
            )
            if (enabledListeners == null || enabledListeners.isEmpty()) {
                return false
            }
            val fullName = listenerComponent.flattenToString()
            val shortName = listenerComponent.flattenToShortString()
            return enabledListeners.contains(fullName)
                || enabledListeners.contains(shortName)
                || enabledListeners.contains(appContext.packageName)
        }

        @JvmStatic
        fun isEvenNotificationActive(context: Context?): Boolean {
            val hasAccess = isNotificationAccessEnabled(context)
            if (!hasAccess) {
                Log.i(TAG, "Can't check for Even Realities app notification, permission is not enabled")
                return false
            }
            val hasNotfication = FaceclawMediaNotificationListenerService.hasActiveNotificationTitle(EVEN_NOTIFICATION_TITLE)
            Log.i(TAG, "isEvenNotificationActive: $hasNotfication")
            return hasNotfication
        }

        /** Returns "opened", "not-installed", or "failed" for the phone UI. */
        @JvmStatic
        fun openEvenAppSettings(context: Context?): String {
            if (context == null) {
                return "failed"
            }
            val appContext = context.applicationContext
            try {
                // Settings may launch successfully and then immediately close for a
                // missing package, so check before starting the activity.
                appContext.packageManager.getApplicationInfo(EVEN_PACKAGE_NAME, 0)
                val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                intent.data = Uri.parse("package:$EVEN_PACKAGE_NAME")
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                appContext.startActivity(intent)
                return "opened"
            } catch (e: PackageManager.NameNotFoundException) {
                return "not-installed"
            } catch (t: Exception) {
                Log.w(TAG, "failed to open Even app settings", t)
                return "failed"
            }
        }

        @JvmStatic
        fun openNotificationAccessSettings(context: Context?) {
            if (context == null) {
                return
            }
            val appContext = context.applicationContext
            val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                appContext.startActivity(intent)
            } catch (t: Throwable) {
                Log.w(TAG, "failed to open notification access settings", t)
            }
        }
    }
}
