package com.faceclaw.wear

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.util.Log
import com.google.android.gms.wearable.Wearable
import org.json.JSONObject

/** The watch's own charge level and charging state, for the glasses' battery indicators. */
data class WatchBatteryState(val battery: Int?, val charging: Boolean) {
    fun toJson(): JSONObject = JSONObject()
        .put("battery", battery ?: JSONObject.NULL)
        .put("charging", charging)
}

/**
 * Reads the watch battery from the sticky ACTION_BATTERY_CHANGED broadcast
 * (no receiver needed) and reports it to the phone on /faceclaw/battery. Used
 * both by PhoneListenerService, which answers the phone's polls while the app
 * is closed, and by PhoneLink, which pushes changes while the app is open.
 */
object WatchBattery {
    private const val TAG = "FaceclawWear"

    fun read(context: Context): WatchBatteryState {
        val intent: Intent? = try {
            context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        } catch (error: Exception) {
            Log.w(TAG, "battery read failed", error)
            null
        }
        if (intent == null) return WatchBatteryState(null, false)
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val percent = if (level >= 0 && scale > 0) (level * 100 + scale / 2) / scale else null
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
        return WatchBatteryState(percent?.coerceIn(0, 100), charging)
    }

    /** Fire-and-forget: the phone never acks battery reports. */
    fun report(context: Context, nodeId: String, state: WatchBatteryState = read(context)) {
        val payload = state.toJson().toString()
        Log.d(TAG, "send ${Protocol.PATH_BATTERY} $payload")
        try {
            Wearable.getMessageClient(context.applicationContext)
                .sendMessage(nodeId, Protocol.PATH_BATTERY, payload.toByteArray(Charsets.UTF_8))
                .addOnFailureListener { error -> Log.w(TAG, "battery report failed", error) }
        } catch (error: Exception) {
            Log.w(TAG, "battery report failed", error)
        }
    }
}
