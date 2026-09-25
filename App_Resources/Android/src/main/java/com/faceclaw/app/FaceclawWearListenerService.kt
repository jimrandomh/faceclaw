package com.faceclaw.app

import android.util.Log

import com.google.android.gms.wearable.CapabilityInfo
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService

/**
 * Play services starts this service (in the app process) for every Data
 * Layer message under /faceclaw and for capability changes, whether or not
 * the app is running. It only forwards to FaceclawWearBridge, which owns the
 * hand-off to the JS side.
 */
class FaceclawWearListenerService : WearableListenerService() {
    override fun onMessageReceived(event: MessageEvent) {
        Log.d("FaceclawWear", "service onMessageReceived " + event.path + " from " + event.sourceNodeId)
        FaceclawWearBridge.getInstance(this).handleMessage(event)
    }

    override fun onCapabilityChanged(info: CapabilityInfo) {
        FaceclawWearBridge.getInstance(this).handleCapabilityChanged(info)
    }
}
