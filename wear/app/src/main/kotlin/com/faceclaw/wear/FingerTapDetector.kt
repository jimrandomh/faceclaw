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
import kotlin.math.max
import kotlin.math.sqrt

/** How hard a fingertip tap has to hit before it counts. */
enum class TapSensitivity(val label: String, val threshold: Float, val maxActivity: Float) {
    /** Only firm taps; most resistant to false positives. */
    LOW("Low", 4.0f, 1.0f),
    NORMAL("Normal", 2.6f, 1.4f),
    /** Light taps; expect the odd stray click when moving about. */
    HIGH("High", 1.7f, 1.9f);

    fun next(): TapSensitivity = entries[(ordinal + 1) % entries.size]
}

/**
 * Fingertip ("tip tap") gestures: tapping the index finger against the
 * thumb sends a short, sharp acceleration impulse down the wrist. Wear OS
 * keeps its own pinch gesture to itself, so this reads the linear
 * acceleration sensor directly while the pad is showing and looks for brief
 * spikes above a quiet baseline: an impulse that rises past the threshold
 * and falls back within MAX_SPIKE_MS is a tap; anything longer is the arm
 * moving. Taps are suppressed while the baseline activity is high (walking,
 * gesturing), and a second tap inside the double-tap window makes a double.
 *
 * A heuristic, not a classifier: good enough for a deliberate tap with the
 * wrist held still, tunable through TapSensitivity, and off in a toggle.
 */
class FingerTapDetector(
    context: Context,
    private val sensitivity: () -> TapSensitivity,
    /** elapsedRealtime before which samples are ignored (the watch's own haptics). */
    private val quietUntil: () -> Long,
    /** False while the watch is off the wrist; taps then never fire. */
    private val onBody: () -> Boolean,
    private val onTap: () -> Unit,
    private val onDoubleTap: () -> Unit,
) : SensorEventListener {
    private val sensorManager: SensorManager? = context.getSystemService(SensorManager::class.java)
    private val sensor: Sensor? = sensorManager?.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
        ?: sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    private val subtractGravity = sensor?.type == Sensor.TYPE_ACCELEROMETER
    private val handler = Handler(Looper.getMainLooper())

    private val gravity = floatArrayOf(0f, 0f, SensorManager.GRAVITY_EARTH)
    /** Slow average of the magnitude outside spikes: how much the arm is moving. */
    private var activity = 0f
    private var inSpike = false
    /** Last sample that counted as the arm moving; a tap needs stillness before it. */
    private var lastMotionNs = 0L
    private var spikeStartNs = 0L
    private var refractoryUntilNs = 0L
    private var lastTapNs = 0L
    private var pendingSingle: Runnable? = null
    private var running = false

    val available: Boolean get() = sensor != null

    /** Start listening; false when the watch has no usable accelerometer. */
    fun start(): Boolean {
        val manager = sensorManager ?: return false
        val target = sensor ?: return false
        if (running) return true
        running = manager.registerListener(this, target, SAMPLING_PERIOD_US, handler)
        Log.i(TAG, "tip-tap detector ${if (running) "started" else "failed to start"} on ${target.name}")
        return running
    }

    fun stop() {
        if (!running) return
        running = false
        sensorManager?.unregisterListener(this)
        pendingSingle?.let { handler.removeCallbacks(it) }
        pendingSingle = null
        inSpike = false
    }

    override fun onSensorChanged(event: SensorEvent) {
        var x = event.values[0]
        var y = event.values[1]
        var z = event.values[2]
        if (subtractGravity) {
            // Raw accelerometer fallback: strip a slowly tracked gravity vector.
            gravity[0] += (x - gravity[0]) * GRAVITY_ALPHA
            gravity[1] += (y - gravity[1]) * GRAVITY_ALPHA
            gravity[2] += (z - gravity[2]) * GRAVITY_ALPHA
            x -= gravity[0]
            y -= gravity[1]
            z -= gravity[2]
        }
        val magnitude = sqrt(x * x + y * y + z * z)
        val now = event.timestamp
        val level = sensitivity()

        if (SystemClock.elapsedRealtime() < quietUntil() || !onBody()) {
            // Our own vibration motor (or a desk being bumped): not a finger.
            // Also forget any spike in progress so its tail can't complete it.
            inSpike = false
            refractoryUntilNs = now + REFRACTORY_NS
            return
        }

        if (!inSpike) {
            val still = activity < level.maxActivity && now - lastMotionNs > STILLNESS_BEFORE_TAP_NS
            if (magnitude > level.threshold && still && now > refractoryUntilNs) {
                inSpike = true
                spikeStartNs = now
            } else {
                activity += (magnitude - activity) * ACTIVITY_ALPHA
                if (magnitude > level.maxActivity) lastMotionNs = now
            }
            return
        }

        val durationNs = now - spikeStartNs
        if (magnitude < level.threshold * SPIKE_END_FRACTION) {
            inSpike = false
            refractoryUntilNs = now + REFRACTORY_NS
            if (durationNs <= MAX_SPIKE_NS) {
                registerTap(now)
            } else {
                activity = max(activity, magnitude)
                lastMotionNs = now
            }
        } else if (durationNs > MAX_SPIKE_NS) {
            // Sustained acceleration is the arm moving, not a tap.
            inSpike = false
            refractoryUntilNs = now + REFRACTORY_NS
            activity += (magnitude - activity) * MOVEMENT_ALPHA
            lastMotionNs = now
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private fun registerTap(nowNs: Long) {
        val pending = pendingSingle
        if (pending != null && nowNs - lastTapNs <= DOUBLE_TAP_WINDOW_NS) {
            handler.removeCallbacks(pending)
            pendingSingle = null
            lastTapNs = 0L
            onDoubleTap()
            return
        }
        lastTapNs = nowNs
        val fire = Runnable {
            pendingSingle = null
            onTap()
        }
        pendingSingle = fire
        handler.postDelayed(fire, DOUBLE_TAP_WINDOW_MS)
    }

    private companion object {
        const val TAG = "FaceclawWear"
        /** 100 Hz: under the 200 Hz line that needs HIGH_SAMPLING_RATE_SENSORS. */
        const val SAMPLING_PERIOD_US = 10_000
        const val MAX_SPIKE_NS = 90_000_000L
        /** The hand has to be still this long before an impulse can be a tap. */
        const val STILLNESS_BEFORE_TAP_NS = 250_000_000L
        const val REFRACTORY_NS = 140_000_000L
        const val DOUBLE_TAP_WINDOW_MS = 380L
        const val DOUBLE_TAP_WINDOW_NS = DOUBLE_TAP_WINDOW_MS * 1_000_000L
        const val SPIKE_END_FRACTION = 0.5f
        const val ACTIVITY_ALPHA = 0.04f
        const val MOVEMENT_ALPHA = 0.3f
        const val GRAVITY_ALPHA = 0.05f
    }
}
