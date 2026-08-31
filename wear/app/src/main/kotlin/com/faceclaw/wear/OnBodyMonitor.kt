package com.faceclaw.wear

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * Whether the watch is on a wrist, from the low-latency off-body sensor.
 * The motion-sensor gestures (tip taps, wrist twists) only make sense on a
 * wrist: on a desk, a buzzing phone next to the watch reads as a fingertip
 * tap. Watches without the sensor are assumed worn.
 */
class OnBodyMonitor(context: Context) : SensorEventListener {
    private val sensorManager: SensorManager? = context.getSystemService(SensorManager::class.java)
    private val sensor: Sensor? = sensorManager?.getDefaultSensor(Sensor.TYPE_LOW_LATENCY_OFFBODY_DETECT)
    private val handler = Handler(Looper.getMainLooper())
    private var running = false

    @Volatile
    var onBody: Boolean = true
        private set

    fun start() {
        val manager = sensorManager ?: return
        val target = sensor ?: return
        if (running) return
        running = manager.registerListener(this, target, SensorManager.SENSOR_DELAY_NORMAL, handler)
    }

    fun stop() {
        if (!running) return
        running = false
        sensorManager?.unregisterListener(this)
        onBody = true
    }

    override fun onSensorChanged(event: SensorEvent) {
        val worn = event.values.firstOrNull()?.let { it >= 0.5f } ?: true
        if (worn != onBody) {
            onBody = worn
            Log.i(TAG, if (worn) "watch on wrist: motion gestures enabled" else "watch off wrist: motion gestures paused")
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private companion object {
        const val TAG = "FaceclawWear"
    }
}
