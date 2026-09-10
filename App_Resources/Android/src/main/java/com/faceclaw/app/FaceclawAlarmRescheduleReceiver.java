package com.faceclaw.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Re-arms the persisted alarm schedule when the system would otherwise have
 * dropped it: after a reboot (AlarmManager alarms do not survive one), a
 * package update, or a wall-clock / time-zone change. Runs without the
 * JavaScript side; only the device-protected schedule file is needed.
 */
public class FaceclawAlarmRescheduleReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (action == null) {
            return;
        }
        switch (action) {
            case Intent.ACTION_BOOT_COMPLETED:
            case Intent.ACTION_LOCKED_BOOT_COMPLETED:
            case Intent.ACTION_MY_PACKAGE_REPLACED:
            case Intent.ACTION_TIME_CHANGED:
            case Intent.ACTION_TIMEZONE_CHANGED:
            case "android.intent.action.QUICKBOOT_POWERON":
            case "com.htc.intent.action.QUICKBOOT_POWERON":
                FaceclawAlarms.rescheduleAll(context, action);
                break;
            default:
                break;
        }
    }
}
