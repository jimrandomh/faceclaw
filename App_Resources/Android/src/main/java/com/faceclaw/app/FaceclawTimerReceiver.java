package com.faceclaw.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Receives durable timer/alarm expiries even if the NativeScript side is asleep. */
public class FaceclawTimerReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !FaceclawTimerNotifications.ACTION_EXPIRE.equals(intent.getAction())) {
            return;
        }
        long timerId = intent.getLongExtra(FaceclawTimerNotifications.EXTRA_TIMER_ID, 0);
        if (timerId == 0) {
            return;
        }
        String title = intent.getStringExtra(FaceclawTimerNotifications.EXTRA_TITLE);
        String text = intent.getStringExtra(FaceclawTimerNotifications.EXTRA_TEXT);
        FaceclawTimerNotifications.showExpiredOnce(context, timerId, title, text);
    }
}
