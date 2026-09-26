package com.faceclaw.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** The AlarmManager target: an item came due, start the ringing service. */
class FaceclawAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent == null || FaceclawAlarms.ACTION_EXPIRE != intent.action) {
            return
        }
        val id = intent.getLongExtra(FaceclawAlarms.EXTRA_ID, 0)
        if (id == 0L) {
            return
        }
        FaceclawAlarmService.ring(
            context.applicationContext,
            id,
            intent.getStringExtra(FaceclawAlarms.EXTRA_TITLE),
            intent.getStringExtra(FaceclawAlarms.EXTRA_TEXT),
            intent.getStringExtra(FaceclawAlarms.EXTRA_KIND),
            intent.getIntExtra(FaceclawAlarms.EXTRA_SNOOZE_MINUTES, 10)
        )
    }
}
