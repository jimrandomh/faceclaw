package com.faceclaw.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Re-arms the persisted alarm schedule when the system would otherwise have
 * dropped it: after a reboot (AlarmManager alarms do not survive one), a
 * package update, or a wall-clock / time-zone change. Runs without the
 * JavaScript side; only the device-protected schedule file is needed.
 */
class FaceclawAlarmRescheduleReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        when (action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_LOCKED_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            Intent.ACTION_TIME_CHANGED,
            Intent.ACTION_TIMEZONE_CHANGED,
            "android.intent.action.QUICKBOOT_POWERON",
            "com.htc.intent.action.QUICKBOOT_POWERON" ->
                FaceclawAlarms.rescheduleAll(context, action)
            else -> {}
        }
    }
}
