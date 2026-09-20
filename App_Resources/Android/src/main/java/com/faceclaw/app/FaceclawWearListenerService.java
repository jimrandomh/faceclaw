package com.faceclaw.app;

import android.util.Log;

import com.google.android.gms.wearable.CapabilityInfo;
import com.google.android.gms.wearable.MessageEvent;
import com.google.android.gms.wearable.WearableListenerService;

/**
 * Play services starts this service (in the app process) for every Data
 * Layer message under /faceclaw and for capability changes, whether or not
 * the app is running. It only forwards to FaceclawWearBridge, which owns the
 * hand-off to the JS side.
 */
public class FaceclawWearListenerService extends WearableListenerService {
    @Override
    public void onMessageReceived(MessageEvent event) {
        Log.d("FaceclawWear", "service onMessageReceived " + event.getPath() + " from " + event.getSourceNodeId());
        FaceclawWearBridge.getInstance(this).handleMessage(event);
    }

    @Override
    public void onCapabilityChanged(CapabilityInfo info) {
        FaceclawWearBridge.getInstance(this).handleCapabilityChanged(info);
    }
}
