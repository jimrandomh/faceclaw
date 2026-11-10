// Ported from callbacked/kinesis (MIT, Copyright (c) 2026 callbacked): Sources/KinesisCore/PinchDial.swift,
// by way of tetramo-labs/glassly (MIT).
package com.faceclaw.app.neuralband

import kotlin.math.abs
import kotlin.math.exp

internal class PinchDial {
    var engaged = false
        private set
    private val pressedAt = HashMap<String, Double>()

    /** A press can only become a pinch if motion was already flowing when it began. */
    private var indexCanArm = false
    private var lastGyroAt: Double? = null
    private var lastDeviceTime: ULong? = null
    private var bias = Vector3.ZERO
    private var integral = Vector3.ZERO
    private var axis: Int? = null

    fun tick(now: Double) {
        val lastGyro = lastGyroAt
        if (lastGyro != null && now - lastGyro >= 0.35) {
            pressedAt.clear()
            release()
        }
        for ((finger, time) in pressedAt.entries.toList()) {
            if (now - time < 10) continue
            pressedAt.remove(finger)
            if (finger == "index") release()
        }
        val pressed = pressedAt["index"]
        val gyroAt = lastGyroAt
        if (!engaged && indexCanArm && pressed != null && now - pressed >= ARM_DELAY &&
            gyroAt != null && now - gyroAt < 0.35
        ) {
            release()
            engaged = true
        }
    }

    fun gesture(gesture: BandGesture, now: Double) {
        tick(now)
        if (gesture.synthetic || (gesture.finger != "index" && gesture.finger != "middle")) return
        val finger = gesture.finger
        val press = gesture.action == "press" || gesture.derivedAction == "buttonPress"
        val released = gesture.action == "release" ||
            gesture.derivedAction == "buttonRelease" || gesture.derivedAction == "buttonHoldRelease"
        if (press && pressedAt[finger] == null) {
            pressedAt[finger] = now
            if (finger == "index") indexCanArm = lastGyroAt?.let { now - it < 0.35 } ?: false
        }
        if (released) {
            pressedAt.remove(finger)
            if (finger == "index") {
                indexCanArm = false
                release()
            }
        }
    }

    fun gyro(timestamp: ULong, values: Vector3, now: Double): Double? {
        tick(now)
        val previous = lastDeviceTime
        lastDeviceTime = timestamp
        lastGyroAt = now
        if (previous == null || timestamp <= previous || timestamp - previous > 50_000uL) {
            if (engaged) {
                pressedAt.remove("index")
                release()
            }
            return null
        }
        val dt = (timestamp - previous).toDouble() / 1e6
        if (pressedAt.isEmpty() && (0 until 3).all { abs(values[it] - bias[it]) < 45 }) {
            bias += (values - bias) * (1 - exp(-dt / 2))
        }
        // Observed 0.07 gyro scale; this remains a relative, experimental estimate.
        val delta = (values - bias) * (0.07 * dt)
        if (!engaged) return null
        integral += delta
        if (axis == null) {
            val dominant = (0 until 3).maxBy { abs(integral[it]) }
            if (abs(integral[dominant]) >= 0.25) {
                axis = dominant
                return integral[dominant]
            }
        }
        return axis?.let { delta[it] }
    }

    private fun release() {
        engaged = false
        integral = Vector3.ZERO
        axis = null
    }

    companion object {
        /**
         * A tap is over in well under this. Only a pinch that outlasts it is a hold, so
         * neither press of a double tap arms the dial.
         */
        const val ARM_DELAY = 0.18
    }
}
