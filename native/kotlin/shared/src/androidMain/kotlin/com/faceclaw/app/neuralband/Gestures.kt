// Ported from callbacked/kinesis (MIT, Copyright (c) 2026 callbacked): Sources/KinesisCore/Gestures.swift,
// by way of tetramo-labs/glassly (MIT). Faceclaw drops the raw EMG, band-model and firmware-update events.
package com.faceclaw.app.neuralband

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.truncate

/** Monotonic seconds, the default clock for event times. */
internal fun uptimeSeconds(): Double = System.nanoTime() / 1_000_000_000.0

enum class BandHand(val rawValue: String) {
    RIGHT("right"),
    LEFT("left");

    val id: String get() = rawValue
}

data class BandDevice(
    val address: String,
    val name: String,
    val rssi: Int? = null,
) {
    val id: String get() = address
}

data class Vector3(val x: Double, val y: Double, val z: Double) {
    operator fun get(index: Int): Double = when (index) {
        0 -> x
        1 -> y
        2 -> z
        else -> throw IndexOutOfBoundsException("Vector3 index $index")
    }

    operator fun plus(other: Vector3) = Vector3(x + other.x, y + other.y, z + other.z)
    operator fun minus(other: Vector3) = Vector3(x - other.x, y - other.y, z - other.z)
    operator fun times(scale: Double) = Vector3(x * scale, y * scale, z * scale)

    companion object {
        val ZERO = Vector3(0.0, 0.0, 0.0)
    }
}

/** Unit quaternion in captured wire order: w, x, y, z. */
data class Quaternion(val w: Double, val x: Double, val y: Double, val z: Double) {
    operator fun get(index: Int): Double = when (index) {
        0 -> w
        1 -> x
        2 -> y
        3 -> z
        else -> throw IndexOutOfBoundsException("Quaternion index $index")
    }
}

class BandEvent(val payload: Payload, val receivedAt: Double = uptimeSeconds()) {
    sealed class Payload {
        data class Devices(val devices: List<BandDevice>) : Payload()
        data class Battery(val level: Int) : Payload()
        data class BatteryStatus(val status: BandBatteryStatus?) : Payload()
        object Preparing : Payload()
        object Connected : Payload()
        object Disconnected : Payload()
        object Heartbeat : Payload()
        data class Gesture(val gesture: BandGesture) : Payload()
        data class DialState(val engaged: Boolean) : Payload()
        data class DialTurn(val delta: Double) : Payload()
        data class Gyro(val timestamp: ULong, val values: Vector3) : Payload()

        /** The band confirmed (or refused, or never answered) a change of motion streams. */
        data class MotionStreamsChanged(
            val streams: MotionStreams,
            val confirmedAfter: Double,
            val accepted: Boolean,
        ) : Payload()

        data class Orientation(val timestamp: ULong, val values: Quaternion) : Payload()

        /**
         * A decoded sensor data frame arrived (gesture, motion, orientation, or
         * raw emg). Tells streaming data apart from ack-only liveness.
         */
        object DataSeen : Payload()
        data class Handedness(val hand: BandHand) : Payload()
        data class HandednessFailure(val message: String) : Payload()
        data class CeremonyHTTP(val request: CeremonyHTTPRequest) : Payload()
        data class CeremonyStage(val stage: String) : Payload()

        /** The input channel read is waiting on a system Bluetooth pairing request. */
        object SystemPairingPending : Payload()
        data class DeviceInfo(val info: BandDeviceInfo) : Payload()
    }
}

data class BandGesture(
    val sequence: ULong,
    val timestampUs: ULong,
    val finger: String,
    val action: String,
    val derivedAction: String = "unknown",
    val synthetic: Boolean = false,
    val receivedAt: Double = uptimeSeconds(),
) {
    val gestureLabel: String?
        get() {
            if (synthetic) return null
            val label = LABELS[derivedAction] ?: LABELS[action] ?: return null
            return "${finger.capitalizedWords()} $label"
        }

    private companion object {
        val LABELS = mapOf(
            "singleTap" to "tap", "doubleTap" to "double tap", "buttonHold" to "hold",
            "buttonPress" to "pinch", "buttonRelease" to "release", "buttonHoldRelease" to "release",
            "buttonUp" to "swipe up", "buttonDown" to "swipe down",
            "buttonLeft" to "swipe left", "buttonRight" to "swipe right",
            "tap" to "tap", "doubletap" to "double tap", "press" to "pinch", "release" to "release",
            "up" to "swipe up", "down" to "swipe down", "left" to "swipe left", "right" to "swipe right",
        )
    }
}

/** Foundation's `capitalized`: words split on whitespace, first letter up, the rest down. */
internal fun String.capitalizedWords(): String {
    val out = StringBuilder(length)
    var startOfWord = true
    for (char in this) {
        if (char.isWhitespace()) {
            startOfWord = true
            out.append(char)
        } else {
            out.append(if (startOfWord) char.uppercase() else char.lowercase())
            startOfWord = false
        }
    }
    return out.toString()
}

enum class SwipeDirection(val rawValue: String) {
    LEFT("left"),
    RIGHT("right"),
    UP("up"),
    DOWN("down");

    val id: String get() = rawValue
    val label: String get() = "Swipe $rawValue"
    val symbol: String get() = "arrow.$rawValue"

    companion object {
        fun fromRawValue(rawValue: String): SwipeDirection? = entries.firstOrNull { it.rawValue == rawValue }
    }
}

class GestureRouter {
    private val seen = ArrayList<String>()
    private val last = HashMap<RecognizedGesture, Pair<String, Double>>()
    private val lastHold = HashMap<String, Double>()

    fun reset() {
        seen.clear()
        last.clear()
        lastHold.clear()
    }

    fun gesture(message: BandGesture, now: Double): RecognizedGesture? {
        val age = now - message.receivedAt
        if (message.synthetic || !(age >= -0.1 && age <= 0.35)) return null
        val derivedDirection = DERIVED_SWIPES[message.derivedAction]
        val gesture: RecognizedGesture
        val source: String
        val direction = derivedDirection ?: SwipeDirection.fromRawValue(message.action)
        if (message.finger == "thumb" && direction != null) {
            gesture = RecognizedGesture.Swipe(direction)
            source = if (derivedDirection == null) "raw" else "derived"
        } else {
            val derivedTap = DERIVED_TAPS[message.derivedAction]
            val action = derivedTap ?: message.action
            val tap = TapGesture.entries.firstOrNull { it.finger == message.finger && it.action == action } ?: return null
            gesture = RecognizedGesture.Tap(tap)
            source = if (derivedTap == null) "raw" else "derived"
        }
        val identity = "${message.sequence}:${message.timestampUs}:${message.finger}:${message.action}:${message.derivedAction}"
        if (seen.contains(identity)) return null
        seen.add(identity)
        if (seen.size > 128) seen.removeAt(0)
        val previous = last[gesture]
        if (previous != null && previous.first != source && abs(message.receivedAt - previous.second) < 0.18) {
            return null
        }
        if (gesture is RecognizedGesture.Tap && gesture.tap.action == "hold") {
            val repeated = lastHold[gesture.tap.finger]?.let { now - it < HOLD_REPEAT } ?: false
            lastHold[gesture.tap.finger] = now
            if (repeated) return null
        }
        last[gesture] = source to message.receivedAt
        return gesture
    }

    companion object {
        const val HOLD_REPEAT = 1.0
        val DERIVED_SWIPES = mapOf(
            "buttonLeft" to SwipeDirection.LEFT,
            "buttonRight" to SwipeDirection.RIGHT,
            "buttonUp" to SwipeDirection.UP,
            "buttonDown" to SwipeDirection.DOWN,
        )
        val DERIVED_TAPS = mapOf("singleTap" to "tap", "doubleTap" to "doubletap", "buttonHold" to "hold")
    }
}

sealed class RecognizedGesture {
    data class Swipe(val direction: SwipeDirection) : RecognizedGesture()
    data class Tap(val tap: TapGesture) : RecognizedGesture()

    val label: String
        get() = when (this) {
            is Swipe -> direction.label
            is Tap -> tap.label
        }
}

enum class TapGesture(val rawValue: String) {
    // An index hold is the dial, so only the middle finger has a hold of its own.
    INDEX_TAP("indexTap"),
    INDEX_DOUBLE_TAP("indexDoubleTap"),
    MIDDLE_TAP("middleTap"),
    MIDDLE_DOUBLE_TAP("middleDoubleTap"),
    MIDDLE_HOLD("middleHold");

    val id: String get() = rawValue
    val finger: String get() = if (this == INDEX_TAP || this == INDEX_DOUBLE_TAP) "index" else "middle"
    val action: String
        get() = when (this) {
            INDEX_TAP, MIDDLE_TAP -> "tap"
            INDEX_DOUBLE_TAP, MIDDLE_DOUBLE_TAP -> "doubletap"
            MIDDLE_HOLD -> "hold"
        }

    /** The motion in plain words: tap, double tap, or hold. */
    val motion: String get() = if (action == "doubletap") "double tap" else action
    val label: String get() = "${finger.capitalizedWords()} $motion"
}

/**
 * Holds a finger's single tap for the band's double-tap window. The band reports a
 * tap after the first pinch and a double tap after the second, so a single tap sent
 * at once fires alongside every double tap. The finger's press and release edges,
 * and a repeated tap report, restart the window: the double tap's report follows
 * the second release, so the window only has to reach the second pinch.
 */
class TapResolver {
    private class Held(val tap: RecognizedGesture, var at: Double, var count: Int)

    private val pending = LinkedHashMap<String, Held>()

    fun reset() {
        pending.clear()
    }

    /**
     * The gestures to send for [gesture] arriving now, in order. A single tap is held
     * (a repeat on the same finger joins it); a double tap on the same finger replaces
     * its held taps; anything else releases every held tap ahead of itself so order
     * is kept.
     */
    fun resolve(gesture: RecognizedGesture, now: Double): List<RecognizedGesture> {
        val tap = (gesture as? RecognizedGesture.Tap)?.tap
        if (tap == null || tap.action == "hold") return flushBefore(Double.POSITIVE_INFINITY) + gesture
        if (tap.action == "tap") {
            val released = flushBefore(Double.POSITIVE_INFINITY, except = tap.finger)
            val held = pending[tap.finger]
            if (held == null) {
                pending[tap.finger] = Held(gesture, now, 1)
            } else {
                held.at = now
                held.count += 1
            }
            return released
        }
        pending.remove(tap.finger)
        return flushBefore(Double.POSITIVE_INFINITY) + gesture
    }

    /** A press or release edge on [finger]: its held tap waits for what follows. */
    fun touched(finger: String, now: Double) {
        pending[finger]?.at = now
    }

    /** The held taps whose window has closed, oldest first. */
    fun flush(now: Double): List<RecognizedGesture> = flushBefore(now - WINDOW)

    private fun flushBefore(cutoff: Double, except: String? = null): List<RecognizedGesture> {
        val due = pending.entries.filter { it.key != except && it.value.at <= cutoff }.sortedBy { it.value.at }
        due.forEach { pending.remove(it.key) }
        return due.flatMap { entry -> List(entry.value.count) { entry.value.tap } }
    }

    companion object {
        const val WINDOW = 0.35
    }
}

class DialRouter {
    private var remainder = 0.0
    private var lastDispatch = Double.NEGATIVE_INFINITY
    private var lastInput = Double.NEGATIVE_INFINITY

    fun reset() {
        remainder = 0.0
        lastDispatch = Double.NEGATIVE_INFINITY
        lastInput = Double.NEGATIVE_INFINITY
    }

    fun turn(delta: Double, sensitivity: Double, now: Double): Int {
        if (!delta.isFinite() || !sensitivity.isFinite() || !now.isFinite() || sensitivity !in 0.5..4.0) return 0
        if (now - lastInput > 0.35) reset()
        lastInput = now
        if (remainder * delta < 0) remainder = 0.0
        // One media-key step per two degrees in the relative gyro estimate at 1x.
        // Limit output to one step and discard excess whole steps after a fast flick.
        remainder = min(2.0, max(-2.0, remainder + delta * sensitivity * 0.5))
        if (!(now - lastDispatch >= 0.08)) return 0
        val steps = min(1, max(-1, truncate(remainder).toInt()))
        if (steps == 0) return 0
        remainder %= 1.0
        lastDispatch = now
        return steps
    }
}

class ActionGate(private val minimumInterval: Double = 0.4) {
    private var armedAt = Double.POSITIVE_INFINITY
    private var lastAction = Double.NEGATIVE_INFINITY

    fun arm(time: Double) {
        armedAt = time
        lastAction = Double.NEGATIVE_INFINITY
    }

    fun pause() {
        armedAt = Double.POSITIVE_INFINITY
    }

    fun allows(eventTime: Double, now: Double, live: Boolean, trusted: Boolean): Boolean {
        val allowed = live && trusted && eventTime >= armedAt && now - eventTime <= 0.35 &&
            now - eventTime >= -0.1 && now - lastAction >= minimumInterval
        if (!allowed) return false
        lastAction = now
        return true
    }
}

/** Which motion streams the band sends, besides gestures. */
data class MotionStreams(val gyro: Boolean, val orientation: Boolean) {
    companion object {
        val ALL = MotionStreams(gyro = true, orientation = true)
        val NONE = MotionStreams(gyro = false, orientation = false)
    }
}
