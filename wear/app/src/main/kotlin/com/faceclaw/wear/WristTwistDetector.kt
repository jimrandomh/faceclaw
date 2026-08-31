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
import kotlin.math.abs

/** How fast the wrist has to turn before a twist counts. */
enum class TwistSensitivity(val label: String, val threshold: Float) {
    /** Only a brisk flick; rad/s about the forearm. */
    LOW("Low", 5.0f),
    NORMAL("Normal", 3.6f),
    HIGH("High", 2.6f);

    fun next(): TwistSensitivity = entries[(ordinal + 1) % entries.size]
}

/**
 * "Twist the wrist twice" = back. The gyroscope's x axis runs along the
 * forearm on a watch, so a wrist twist (pronation / supination) is a burst of
 * angular velocity about x. Two brisk twists in the same direction, each
 * short and separated by 120–900 ms, fire the gesture; the wrist coming back
 * between them spins the other way and is ignored. The direction is not
 * fixed (away or toward), so it works on either wrist, and the twists must be
 * quick: a slow arm rotation never crosses the rate threshold.
 *
 * Same status as FingerTapDetector: a heuristic with a toggle, not a
 * classifier.
 */
class WristTwistDetector(
    context: Context,
    private val sensitivity: () -> TwistSensitivity,
    /** elapsedRealtime before which samples are ignored (the watch's own haptics). */
    private val quietUntil: () -> Long,
    /** False while the watch is off the wrist; twists then never fire. */
    private val onBody: () -> Boolean,
    private val onDoubleTwist: () -> Unit,
) : SensorEventListener {
    private val sensorManager: SensorManager? = context.getSystemService(SensorManager::class.java)
    private val sensor: Sensor? = sensorManager?.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
    private val handler = Handler(Looper.getMainLooper())

    private var inBurst = false
    /** Slow average of |rate| outside bursts: how much the arm is rotating anyway. */
    private var activity = 0f
    private var lastMotionNs = 0L
    private var burstStartNs = 0L
    private var burstSign = 0
    private var firstTwistNs = 0L
    private var firstTwistSign = 0
    private var running = false

    val available: Boolean get() = sensor != null

    fun start(): Boolean {
        val manager = sensorManager ?: return false
        val target = sensor ?: return false
        if (running) return true
        running = manager.registerListener(this, target, SAMPLING_PERIOD_US, handler)
        Log.i(TAG, "wrist-twist detector ${if (running) "started" else "failed to start"}")
        return running
    }

    fun stop() {
        if (!running) return
        running = false
        sensorManager?.unregisterListener(this)
        inBurst = false
        firstTwistNs = 0L
    }

    override fun onSensorChanged(event: SensorEvent) {
        val rate = event.values[0]
        val now = event.timestamp
        if (SystemClock.elapsedRealtime() < quietUntil() || !onBody()) {
            inBurst = false
            firstTwistNs = 0L
            return
        }
        val threshold = sensitivity().threshold

        if (!inBurst) {
            val magnitude = abs(rate)
            // A twist pair only starts from a still-ish wrist: general arm
            // rotation (reaching, gesturing) produced same-sign burst pairs
            // that read as the gesture.
            val still = activity < threshold * ACTIVITY_FRACTION && now - lastMotionNs > STILLNESS_BEFORE_TWIST_NS
            if (magnitude > threshold && (still || firstTwistNs != 0L)) {
                inBurst = true
                burstStartNs = now
                burstSign = if (rate > 0) 1 else -1
            } else {
                activity += (magnitude - activity) * ACTIVITY_ALPHA
                if (magnitude > threshold * ACTIVITY_FRACTION) lastMotionNs = now
            }
            return
        }
        // In a burst: wait for the rate to drop back under the threshold.
        if (abs(rate) > threshold * BURST_END_FRACTION && (if (rate > 0) 1 else -1) == burstSign) return
        inBurst = false
        val duration = now - burstStartNs
        if (duration > MAX_BURST_NS) return // a slow sweep, not a flick

        val sinceFirst = now - firstTwistNs
        if (firstTwistNs != 0L && burstSign == firstTwistSign && sinceFirst in MIN_GAP_NS..MAX_GAP_NS) {
            firstTwistNs = 0L
            onDoubleTwist()
        } else if (firstTwistNs == 0L || sinceFirst > MAX_GAP_NS || burstSign != firstTwistSign) {
            // The return twist (opposite sign) does not start a new pair; a
            // fresh same-direction twist does.
            if (firstTwistNs == 0L || sinceFirst > MAX_GAP_NS) {
                firstTwistNs = now
                firstTwistSign = burstSign
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private companion object {
        const val TAG = "FaceclawWear"
        const val SAMPLING_PERIOD_US = 10_000
        const val MAX_BURST_NS = 350_000_000L
        const val MIN_GAP_NS = 120_000_000L
        const val MAX_GAP_NS = 900_000_000L
        const val BURST_END_FRACTION = 0.5f
        const val ACTIVITY_ALPHA = 0.04f
        const val ACTIVITY_FRACTION = 0.35f
        const val STILLNESS_BEFORE_TWIST_NS = 300_000_000L
    }
}
