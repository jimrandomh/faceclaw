// From tetramo-labs/glassly (MIT): bluetooth-sdk controllers/neuralband/NeuralBandPinch.kt.
package com.faceclaw.app.neuralband

/** The pinching finger as an index: 0 index, 1 middle; null for the thumb and anything else. */
fun bandFingerIndex(finger: String): Int? = when (finger) {
    "index" -> 0
    "middle" -> 1
    else -> null
}

/**
 * Adapts raw pinch edges to a press lifecycle. `touch_down` is immediate;
 * `tap_start` means a held press (the finger has stayed pinched for [HOLD_DELAY]);
 * `tap_end` is the release. Quick taps never produce `tap_start`.
 */
class NeuralBandPinch {
    private data class Press(val beganAt: Double, var holding: Boolean = false)
    private val presses = mutableMapOf<Int, Press>()

    fun reset() = presses.clear()

    /** Release active presses when the link closes so nothing is left held. */
    fun releaseAll(): List<Pair<String, Int>> {
        val fingers = presses.keys.sorted()
        reset()
        return fingers.map { "tap_end" to it }
    }

    fun receive(message: BandGesture, now: Double): Pair<String, Int>? {
        if (now - message.receivedAt < -0.1 || now - message.receivedAt > 0.35) return null
        val finger = bandFingerIndex(message.finger) ?: return null
        val press = message.action == "press" || message.derivedAction == "buttonPress"
        val release = message.action == "release" || message.derivedAction == "buttonRelease" || message.derivedAction == "buttonHoldRelease"
        if (press == release) return null
        if (press) {
            if (message.synthetic || finger in presses) return null
            presses[finger] = Press(now)
            return "touch_down" to finger
        }
        if (presses.remove(finger) == null) return null
        return "tap_end" to finger
    }

    fun flush(now: Double): List<Pair<String, Int>> {
        val lost = presses.keys.sorted().filter { now - presses.getValue(it).beganAt >= MAX_AGE }
        lost.forEach { presses.remove(it) }
        return lost.map { "tap_end" to it } + presses.keys.sorted().mapNotNull { finger ->
            val press = presses.getValue(finger)
            if (press.holding || now - press.beganAt < HOLD_DELAY) return@mapNotNull null
            press.holding = true
            "tap_start" to finger
        }
    }

    companion object {
        const val HOLD_DELAY = 0.4
        const val MAX_AGE = 10.0
    }
}
