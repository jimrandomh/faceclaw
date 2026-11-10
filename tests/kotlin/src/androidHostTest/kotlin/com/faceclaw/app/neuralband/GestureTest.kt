// Ported from callbacked/kinesis (MIT, Copyright (c) 2026 callbacked): Tests/KinesisCoreTests/GestureTests.swift.
package com.faceclaw.app.neuralband

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun gesture(
    sequence: Int,
    time: Double = 100.0,
    action: String = "left",
    derived: String = "unknown",
    finger: String = "thumb",
    synthetic: Boolean = false,
) = BandGesture(
    sequence = sequence.toULong(),
    timestampUs = (sequence * 1000).toULong(),
    finger = finger,
    action = action,
    derivedAction = derived,
    synthetic = synthetic,
    receivedAt = time,
)

private fun swipe(direction: SwipeDirection) = RecognizedGesture.Swipe(direction)
private fun tap(tap: TapGesture) = RecognizedGesture.Tap(tap)

class GestureTest {
    @Test
    fun oneSwipeProducesOneActionAcrossRawDerivedAndRepeatedMessages() {
        val router = GestureRouter()
        val raw = gesture(1)
        assertEquals(swipe(SwipeDirection.LEFT), router.gesture(raw, 100.01))
        assertNull(router.gesture(raw, 100.02))
        assertNull(router.gesture(gesture(2, time = 100.03, action = "unknown", derived = "buttonLeft"), 100.04))
        assertEquals(swipe(SwipeDirection.LEFT), router.gesture(gesture(3, time = 100.5), 100.51))
    }

    @Test
    fun derivedFirstAndAllFourDirectionsWork() {
        val router = GestureRouter()
        assertEquals(swipe(SwipeDirection.RIGHT), router.gesture(gesture(1, action = "unknown", derived = "buttonRight"), 100.0))
        assertNull(router.gesture(gesture(2, time = 100.02, action = "right"), 100.03))
        assertEquals(swipe(SwipeDirection.UP), router.gesture(gesture(3, time = 101.0, action = "up"), 101.0))
        assertEquals(swipe(SwipeDirection.DOWN), router.gesture(gesture(4, time = 102.0, action = "down"), 102.0))
        assertEquals(swipe(SwipeDirection.LEFT), router.gesture(gesture(5, time = 103.0, action = "left"), 103.0))
    }

    @Test
    fun staleOrPartialOrSyntheticOrWrongFingerEventsCannotControlTheHost() {
        val router = GestureRouter()
        assertNull(router.gesture(gesture(1), 101.0))
        assertNull(router.gesture(gesture(2, time = 102.0), 100.0))
        assertNull(router.gesture(gesture(3, action = "partialLeft"), 100.0))
        assertNull(router.gesture(gesture(4, finger = "index"), 100.0))
        assertNull(router.gesture(gesture(5, synthetic = true), 100.0))
        assertEquals(swipe(SwipeDirection.LEFT), router.gesture(gesture(6), 100.02))
    }

    @Test
    fun reconnectCanRestartSequenceWithoutReplayingStaleInput() {
        val router = GestureRouter()
        assertEquals(swipe(SwipeDirection.LEFT), router.gesture(gesture(1), 100.0))
        router.reset()
        assertNull(router.gesture(gesture(1), 200.0))
        assertEquals(swipe(SwipeDirection.LEFT), router.gesture(gesture(1, time = 200.0), 200.0))
    }

    @Test
    fun enablingDoesNotReplayOldInputAndPausingIsImmediate() {
        val gate = ActionGate()
        assertFalse(gate.allows(eventTime = 100.0, now = 100.0, live = true, trusted = true))
        gate.arm(100.1)
        assertFalse(gate.allows(eventTime = 100.0, now = 100.2, live = true, trusted = true))
        assertTrue(gate.allows(eventTime = 100.2, now = 100.2, live = true, trusted = true))
        assertFalse(gate.allows(eventTime = 100.3, now = 100.3, live = true, trusted = true))
        gate.pause()
        assertFalse(gate.allows(eventTime = 101.0, now = 101.0, live = true, trusted = true))
    }

    @Test
    fun permissionAndLiveConnectionAreRequiredAtDispatch() {
        val gate = ActionGate()
        gate.arm(100.0)
        assertFalse(gate.allows(eventTime = 101.0, now = 101.0, live = false, trusted = true))
        assertFalse(gate.allows(eventTime = 101.0, now = 101.0, live = true, trusted = false))
        assertFalse(gate.allows(eventTime = 101.0, now = 102.0, live = true, trusted = true))
        assertTrue(gate.allows(eventTime = 102.0, now = 102.0, live = true, trusted = true))
    }

    @Test
    fun doubleTapsAreRecognizedOnceAndPartialPinchesAreIgnored() {
        val router = GestureRouter()
        assertEquals(
            tap(TapGesture.INDEX_DOUBLE_TAP),
            router.gesture(gesture(1, action = "doubletap", finger = "index"), 100.0),
        )
        assertNull(router.gesture(gesture(2, time = 100.03, action = "unknown", derived = "doubleTap", finger = "index"), 100.04))
        assertEquals(
            tap(TapGesture.MIDDLE_DOUBLE_TAP),
            router.gesture(gesture(3, time = 101.0, action = "unknown", derived = "doubleTap", finger = "middle"), 101.0),
        )
        assertNull(router.gesture(gesture(4, time = 102.0, action = "partialClick", finger = "index"), 102.0))
        assertNull(router.gesture(gesture(5, time = 103.0, action = "doubletap", finger = "middle", synthetic = true), 103.0))
    }

    @Test
    fun aSingleTapWaitsOutTheDoubleTapWindow() {
        val taps = TapResolver()
        val single = tap(TapGesture.INDEX_TAP)
        assertEquals(emptyList<RecognizedGesture>(), taps.resolve(single, 100.0))
        assertEquals(emptyList<RecognizedGesture>(), taps.flush(100.349))
        assertEquals(listOf(single), taps.flush(100.35))
        assertEquals(emptyList<RecognizedGesture>(), taps.flush(101.0))
    }

    @Test
    fun aDoubleTapReplacesTheTapItStartedWith() {
        val taps = TapResolver()
        assertEquals(emptyList<RecognizedGesture>(), taps.resolve(tap(TapGesture.INDEX_TAP), 100.0))
        assertEquals(emptyList<RecognizedGesture>(), taps.flush(100.28))
        assertEquals(listOf(tap(TapGesture.INDEX_DOUBLE_TAP)), taps.resolve(tap(TapGesture.INDEX_DOUBLE_TAP), 100.29))
        assertEquals(emptyList<RecognizedGesture>(), taps.flush(101.0))
        // The other finger's held tap is not the double tap's first pinch.
        assertEquals(emptyList<RecognizedGesture>(), taps.resolve(tap(TapGesture.MIDDLE_TAP), 102.0))
        assertEquals(
            listOf(tap(TapGesture.MIDDLE_TAP), tap(TapGesture.INDEX_DOUBLE_TAP)),
            taps.resolve(tap(TapGesture.INDEX_DOUBLE_TAP), 102.1),
        )
    }

    @Test
    fun theSecondPinchKeepsTheFirstTapWaitingForTheDoubleTapReport() {
        val taps = TapResolver()
        assertEquals(emptyList<RecognizedGesture>(), taps.resolve(tap(TapGesture.INDEX_TAP), 100.0))
        taps.touched("index", 100.2)
        assertEquals(emptyList<RecognizedGesture>(), taps.flush(100.3))
        taps.touched("index", 100.33)
        assertEquals(emptyList<RecognizedGesture>(), taps.flush(100.5))
        assertEquals(listOf(tap(TapGesture.INDEX_DOUBLE_TAP)), taps.resolve(tap(TapGesture.INDEX_DOUBLE_TAP), 100.55))
        assertEquals(emptyList<RecognizedGesture>(), taps.flush(102.0))
        // Another finger's edge leaves the held tap alone.
        assertEquals(emptyList<RecognizedGesture>(), taps.resolve(tap(TapGesture.INDEX_TAP), 103.0))
        taps.touched("middle", 103.2)
        assertEquals(listOf(tap(TapGesture.INDEX_TAP)), taps.flush(103.35))
    }

    @Test
    fun aRepeatedTapOnTheSameFingerJoinsTheHeldOne() {
        val taps = TapResolver()
        assertEquals(emptyList<RecognizedGesture>(), taps.resolve(tap(TapGesture.INDEX_TAP), 100.0))
        assertEquals(emptyList<RecognizedGesture>(), taps.resolve(tap(TapGesture.INDEX_TAP), 100.2))
        assertEquals(listOf(tap(TapGesture.INDEX_DOUBLE_TAP)), taps.resolve(tap(TapGesture.INDEX_DOUBLE_TAP), 100.3))
        assertEquals(emptyList<RecognizedGesture>(), taps.flush(101.0))
        // Two taps the band never joined into a double tap are both sent.
        assertEquals(emptyList<RecognizedGesture>(), taps.resolve(tap(TapGesture.INDEX_TAP), 102.0))
        assertEquals(emptyList<RecognizedGesture>(), taps.resolve(tap(TapGesture.INDEX_TAP), 102.2))
        assertEquals(listOf(tap(TapGesture.INDEX_TAP), tap(TapGesture.INDEX_TAP)), taps.flush(102.55))
    }

    @Test
    fun otherGesturesReleaseHeldTapsAheadOfThemselvesAndResetDropsThem() {
        val taps = TapResolver()
        assertEquals(emptyList<RecognizedGesture>(), taps.resolve(tap(TapGesture.INDEX_TAP), 100.0))
        assertEquals(
            listOf(tap(TapGesture.INDEX_TAP), swipe(SwipeDirection.LEFT)),
            taps.resolve(swipe(SwipeDirection.LEFT), 100.1),
        )
        assertEquals(emptyList<RecognizedGesture>(), taps.resolve(tap(TapGesture.MIDDLE_TAP), 101.0))
        assertEquals(
            listOf(tap(TapGesture.MIDDLE_TAP), tap(TapGesture.MIDDLE_HOLD)),
            taps.resolve(tap(TapGesture.MIDDLE_HOLD), 101.1),
        )
        assertEquals(emptyList<RecognizedGesture>(), taps.resolve(tap(TapGesture.INDEX_TAP), 102.0))
        taps.reset()
        assertEquals(emptyList<RecognizedGesture>(), taps.flush(103.0))
    }

    @Test
    fun dialReversalAndReleaseDoNotCarryOverOldMovement() {
        val dial = DialRouter()
        assertEquals(0, dial.turn(delta = 1.0, sensitivity = 1.0, now = 100.0))
        assertEquals(0, dial.turn(delta = -1.0, sensitivity = 1.0, now = 100.1))
        assertEquals(-1, dial.turn(delta = -1.0, sensitivity = 1.0, now = 100.2))
        assertEquals(0, dial.turn(delta = 1.0, sensitivity = 1.0, now = 100.3))
        dial.reset()
        assertEquals(0, dial.turn(delta = 1.0, sensitivity = 1.0, now = 100.4))
        assertEquals(0, dial.turn(delta = Double.NaN, sensitivity = 1.0, now = 100.5))
        assertEquals(1, dial.turn(delta = 600.0, sensitivity = 1.0, now = 100.6))
        assertEquals(0, dial.turn(delta = 0.0, sensitivity = 1.0, now = 100.7))
    }

    @Test
    fun fractionalDialInputAccumulatesAcrossRateLimitAndSensitivityScales() {
        for (sensitivity in listOf(0.5, 1.0, 2.0, 4.0)) {
            val dial = DialRouter()
            val gate = ActionGate(minimumInterval = 0.0)
            gate.arm(100.0)
            var sent = 0
            for (index in 0 until 32) {
                val now = 100 + index * 0.04
                if (gate.allows(eventTime = now, now = now, live = true, trusted = true)) {
                    sent += dial.turn(delta = 0.125, sensitivity = sensitivity, now = now)
                }
            }
            sent += dial.turn(delta = 0.0, sensitivity = sensitivity, now = 101.4)
            assertEquals((2 * sensitivity).toInt(), sent)
        }
    }

    @Test
    fun releasingOrLosingMotionDiscardsPendingDialSteps() {
        val dial = DialRouter()
        assertEquals(1, dial.turn(delta = 2.0, sensitivity = 1.0, now = 100.0))
        assertEquals(0, dial.turn(delta = 2.0, sensitivity = 1.0, now = 100.01))
        dial.reset()
        assertEquals(0, dial.turn(delta = 0.0, sensitivity = 1.0, now = 100.1))
        assertEquals(1, dial.turn(delta = 2.0, sensitivity = 1.0, now = 100.2))
        assertEquals(0, dial.turn(delta = 2.0, sensitivity = 1.0, now = 100.21))
        assertEquals(0, dial.turn(delta = 0.0, sensitivity = 1.0, now = 101.0))
    }

    @Test
    fun aFastDialFlickCannotSendABurstOrQueueMoreVolumeChanges() {
        val dial = DialRouter()
        assertEquals(1, dial.turn(delta = 20.0, sensitivity = 4.0, now = 100.0))
        assertEquals(0, dial.turn(delta = 0.0, sensitivity = 4.0, now = 100.1))
        assertEquals(-1, dial.turn(delta = -20.0, sensitivity = 4.0, now = 100.2))
        assertEquals(0, dial.turn(delta = 0.0, sensitivity = 4.0, now = 100.3))
    }

    @Test
    fun interleavedRawAndDerivedGesturesAreCountedOncePerGesture() {
        val router = GestureRouter()
        assertEquals(swipe(SwipeDirection.LEFT), router.gesture(gesture(1, action = "left"), 100.0))
        assertEquals(swipe(SwipeDirection.RIGHT), router.gesture(gesture(2, time = 100.01, action = "right"), 100.01))
        assertNull(router.gesture(gesture(3, time = 100.02, action = "unknown", derived = "buttonLeft"), 100.02))
        assertNull(router.gesture(gesture(4, time = 100.03, action = "unknown", derived = "buttonRight"), 100.03))
        assertEquals(swipe(SwipeDirection.LEFT), router.gesture(gesture(5, time = 100.04, action = "left"), 100.04))
    }

    @Test
    fun gestureIdentityIncludesTheFinger() {
        val router = GestureRouter()
        assertEquals(tap(TapGesture.INDEX_TAP), router.gesture(gesture(1, action = "tap", finger = "index"), 100.0))
        assertEquals(tap(TapGesture.MIDDLE_TAP), router.gesture(gesture(1, action = "tap", finger = "middle"), 100.0))
    }

    @Test
    fun aMiddleHoldIsAGestureAndAnIndexHoldIsNot() {
        val router = GestureRouter()
        fun hold(finger: String, sequence: ULong) = BandGesture(
            sequence = sequence,
            timestampUs = sequence,
            finger = finger,
            action = "press",
            derivedAction = "buttonHold",
            synthetic = false,
            receivedAt = 100.0,
        )
        assertEquals(tap(TapGesture.MIDDLE_HOLD), router.gesture(hold("middle", 1uL), 100.0))
        // Holding the index finger is the dial, so it never fires an action of its own.
        assertNull(router.gesture(hold("index", 2uL), 100.0))
        // The band repeats the hold's message while it lasts: one gesture per hold.
        fun repeat(sequence: ULong, time: Double) = hold("middle", sequence).copy(receivedAt = time)
        assertNull(router.gesture(repeat(3uL, 100.3), 100.3))
        assertNull(router.gesture(repeat(4uL, 100.6), 100.6))
        assertNull(router.gesture(repeat(5uL, 100.9), 100.9))
        assertNull(router.gesture(repeat(6uL, 101.2), 101.2))
        assertEquals(tap(TapGesture.MIDDLE_HOLD), router.gesture(repeat(7uL, 103.0), 103.0))
        assertTrue(TapGesture.MIDDLE_HOLD.label == "Middle hold" && TapGesture.MIDDLE_HOLD.finger == "middle")
        assertTrue(TapGesture.INDEX_DOUBLE_TAP.motion == "double tap" && TapGesture.MIDDLE_TAP.motion == "tap")
    }
}
