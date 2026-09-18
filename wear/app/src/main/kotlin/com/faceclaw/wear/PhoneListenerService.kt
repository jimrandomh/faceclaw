package com.faceclaw.wear

import android.util.Log
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService

/**
 * Play services starts this (in the watch app's process) for messages under
 * /faceclaw/battery whether or not the app is open, so the phone can poll
 * the watch battery for the glasses' indicator while the watch sits idle.
 * Everything else the phone sends (acks, events, the state item) is only
 * meaningful to a running PhoneLink and is not routed here.
 */
class PhoneListenerService : WearableListenerService() {
    override fun onMessageReceived(event: MessageEvent) {
        if (event.path != Protocol.PATH_BATTERY_REQUEST) return
        Log.d(TAG, "battery request from ${event.sourceNodeId}")
        WatchBattery.report(this, event.sourceNodeId)
    }

    private companion object {
        const val TAG = "FaceclawWear"
    }
}
