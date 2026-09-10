package com.faceclaw.wear

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** A wake of the watch display that a tap on the pad may have caused. */
data class Wake(
    val id: Long,
    /** SystemClock.uptimeMillis when the app learned of the wake. */
    val uptimeMillis: Long,
    /**
     * The display was fully off (always-on disabled), so the activity was
     * stopped and the tap's job was to turn the screen on; a lone tap should
     * not also reach the glasses. False for an exit from ambient, where the
     * pad was already showing and a tap on it means a tap.
     */
    val fromScreenOff: Boolean,
)

/**
 * Which display wakes were taps. The system consumes the touch that wakes
 * the watch (from ambient or from off), so the pad never sees it; this
 * reports each wake so the pad can treat it as a virtual first tap. Wakes by
 * wrist raise are filtered out with the wrist-tilt gesture sensor, the same
 * signal tilt-to-wake uses. Rotary and button wakes are left to the pad to
 * cancel (a crown event follows straight away; a button wake leaves the app).
 * Lives for the activity's lifetime (start()/stop() from onCreate/onDestroy):
 * the sensor is a wake-up one, so a tilt is seen even while the activity sits
 * stopped behind an off display.
 */
class WakeTracker(context: Context) : SensorEventListener {
    private val sensorManager: SensorManager? = context.getSystemService(SensorManager::class.java)
    private val sensor: Sensor? = sensorManager?.getDefaultSensor(TYPE_WRIST_TILT_GESTURE, true)
        ?: sensorManager?.getDefaultSensor(TYPE_WRIST_TILT_GESTURE)
    private val handler = Handler(Looper.getMainLooper())
    private var running = false
    private var lastTiltAt = Long.MIN_VALUE / 2
    private var nextId = 1L

    private val _wakes = MutableStateFlow<Wake?>(null)
    /** The latest wake, or null once it was attributed to a wrist raise. */
    val wakes: StateFlow<Wake?> = _wakes.asStateFlow()

    fun start() {
        val manager = sensorManager ?: return
        val target = sensor ?: run { Log.i(TAG, "no wrist-tilt sensor: wakes are all taken for taps"); return }
        if (running) return
        running = manager.registerListener(this, target, SensorManager.SENSOR_DELAY_NORMAL, handler)
    }

    fun stop() {
        if (!running) return
        running = false
        sensorManager?.unregisterListener(this)
    }

    /** The display just woke with the app in front. Main thread. */
    fun onWake(fromScreenOff: Boolean) {
        val now = SystemClock.uptimeMillis()
        if (now - lastTiltAt <= TILT_GRACE_MS) {
            Log.d(TAG, "wake (fromScreenOff=$fromScreenOff): wrist raise, ignored")
            return
        }
        Log.d(TAG, "wake (fromScreenOff=$fromScreenOff): possible tap")
        _wakes.value = Wake(id = nextId++, uptimeMillis = now, fromScreenOff = fromScreenOff)
    }

    override fun onSensorChanged(event: SensorEvent) {
        lastTiltAt = SystemClock.uptimeMillis()
        val pending = _wakes.value
        if (pending != null && lastTiltAt - pending.uptimeMillis <= TILT_GRACE_MS) {
            Log.d(TAG, "wrist tilt: wake ${pending.id} was a wrist raise")
            _wakes.value = null
        } else {
            Log.d(TAG, "wrist tilt")
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private companion object {
        const val TAG = "FaceclawWear"
        /** Sensor.TYPE_WRIST_TILT_GESTURE ("android.sensor.wrist_tilt_gesture"): hidden in the SDK. */
        const val TYPE_WRIST_TILT_GESTURE = 26
        /** A tilt this close to a wake (either side) means the tilt caused it. */
        const val TILT_GRACE_MS = 500L
    }
}
