package com.faceclaw.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** The AlarmManager target: an item came due, start the ringing service. */
public class FaceclawAlarmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !FaceclawAlarms.ACTION_EXPIRE.equals(intent.getAction())) {
            return;
        }
        long id = intent.getLongExtra(FaceclawAlarms.EXTRA_ID, 0);
        if (id == 0) {
            return;
        }
        FaceclawAlarmService.ring(
                context.getApplicationContext(),
                id,
                intent.getStringExtra(FaceclawAlarms.EXTRA_TITLE),
                intent.getStringExtra(FaceclawAlarms.EXTRA_TEXT),
                intent.getStringExtra(FaceclawAlarms.EXTRA_KIND),
                intent.getIntExtra(FaceclawAlarms.EXTRA_SNOOZE_MINUTES, 10)
        );
    }
}
