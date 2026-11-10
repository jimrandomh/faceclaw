// From tetramo-labs/glassly (MIT): bluetooth-sdk NeuralBandPinchTest.kt.
package com.faceclaw.app.neuralband

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NeuralBandPinchTest {
    private fun message(action: String, time: Double, finger: String = "index",
                        derived: String = "unknown", synthetic: Boolean = false) = BandGesture(
        sequence = 1uL, timestampUs = 1000uL, finger = finger, action = action,
        derivedAction = derived, synthetic = synthetic, receivedAt = time,
    )

    @Test
    fun heldPinchStartsAndEndsMiniappHoldToTalkOnceForEitherFinger() {
        for ((finger, index) in listOf("index" to 0, "middle" to 1)) {
            val pinches = NeuralBandPinch()
            assertEquals("touch_down" to index, pinches.receive(message("press", 100.0, finger), 100.0))
            // A derived copy must neither duplicate the edge nor restart the hold delay.
            assertNull(pinches.receive(message("unknown", 100.2, finger, "buttonPress"), 100.2))
            assertTrue(pinches.flush(100.39).isEmpty())
            assertEquals(listOf("tap_start" to index), pinches.flush(100.41))
            assertTrue(pinches.flush(102.0).isEmpty())
            assertEquals("tap_end" to index, pinches.receive(message("unknown", 103.0, finger, "buttonHoldRelease"), 103.0))
            assertNull(pinches.receive(message("release", 103.01, finger), 103.01))
            assertTrue(pinches.flush(104.0).isEmpty())
        }
    }

    @Test
    fun quickAndDoublePinchesNeverStartListening() {
        val pinches = NeuralBandPinch()
        for (time in listOf(100.0, 100.2)) {
            assertEquals("touch_down" to 0, pinches.receive(message("press", time), time))
            assertTrue(pinches.flush(time + 0.1).isEmpty())
            assertEquals("tap_end" to 0, pinches.receive(message("release", time + 0.1), time + 0.1))
        }
        assertTrue(pinches.flush(101.0).isEmpty())
    }

    @Test
    fun fingersHaveIndependentHoldsAndReconnectDropsPendingHolds() {
        val pinches = NeuralBandPinch()
        pinches.receive(message("press", 100.0), 100.0)
        pinches.receive(message("press", 100.2, "middle"), 100.2)
        pinches.receive(message("release", 100.3), 100.3)
        assertEquals(listOf("tap_start" to 1), pinches.flush(100.61))
        pinches.reset()
        assertTrue(pinches.flush(102.0).isEmpty())
        assertNull(pinches.receive(message("release", 102.0, "middle"), 102.0))
        pinches.receive(message("press", 103.0), 103.0)
        pinches.reset()
        assertTrue(pinches.flush(104.0).isEmpty())
        pinches.receive(message("press", 105.0), 105.0)
        assertEquals(listOf("tap_start" to 0), pinches.flush(105.41))
    }

    @Test
    fun syntheticStalePartialAndUnpairedReleaseReportsCannotStartAHold() {
        val pinches = NeuralBandPinch()
        assertNull(pinches.receive(message("press", 100.0, synthetic = true), 100.0))
        assertNull(pinches.receive(message("press", 100.0), 101.0))
        assertNull(pinches.receive(message("press", 102.0), 100.0))
        assertNull(pinches.receive(message("press", 100.0, "thumb"), 100.0))
        assertNull(pinches.receive(message("partialClick", 100.0), 100.0))
        assertNull(pinches.receive(message("release", 100.0), 100.0))
        assertTrue(pinches.flush(101.0).isEmpty())
    }

    @Test
    fun aSyntheticReleaseEndsALostPinchAndAnOldPressEndsOnItsOwn() {
        val pinches = NeuralBandPinch()
        assertEquals("touch_down" to 0, pinches.receive(message("press", 100.0), 100.0))
        assertEquals("tap_end" to 0, pinches.receive(message("release", 100.5, synthetic = true), 100.5))
        assertNull(pinches.receive(message("release", 100.6), 100.6))
        assertEquals("touch_down" to 1, pinches.receive(message("press", 101.0, "middle"), 101.0))
        assertEquals(listOf("tap_start" to 1), pinches.flush(101.5))
        assertTrue(pinches.flush(110.9).isEmpty())
        assertEquals(listOf("tap_end" to 1), pinches.flush(111.0))
        assertNull(pinches.receive(message("release", 111.1, "middle"), 111.1))
    }

    @Test
    fun disconnectReleasesListeningAndPendingPressesOnlyOnce() {
        val pinches = NeuralBandPinch()
        pinches.receive(message("press", 100.0), 100.0)
        pinches.flush(100.41)
        pinches.receive(message("press", 101.0, "middle"), 101.0)
        assertEquals(listOf("tap_end" to 0, "tap_end" to 1), pinches.releaseAll())
        assertTrue(pinches.releaseAll().isEmpty())
        assertTrue(pinches.flush(102.0).isEmpty())
    }
}
