package com.faceclaw.app

import kotlin.test.*

class VoiceEndpointDetectorTest {
    @Test fun silenceEndsOnlyAfterSpeechAndFiresOnce() {
        val detector = VoiceEndpointDetector()
        repeat(6) { assertFalse(detector.acceptLevel(100.0, 800)) }
        repeat(10) { assertFalse(detector.accept(ShortArray(800) { 2000 }, 800)) }
        repeat(17) { assertFalse(detector.acceptLevel(100.0, 800)) }
        assertTrue(detector.acceptLevel(100.0, 800))
        assertFalse(detector.acceptLevel(100.0, 800))
        detector.reset()
        assertFalse(detector.acceptLevel(100.0, 800))
    }

    @Test fun pausesResetWhenSpeechResumesAndContinuousSpeechIsBounded() {
        val detector = VoiceEndpointDetector()
        repeat(6) { assertFalse(detector.acceptLevel(0.0, 800)) }
        assertFalse(detector.acceptLevel(2000.0, 800))
        repeat(17) { assertFalse(detector.acceptLevel(0.0, 800)) }
        assertFalse(detector.acceptLevel(2000.0, 800))
        repeat(17) { assertFalse(detector.acceptLevel(0.0, 800)) }
        assertTrue(detector.acceptLevel(0.0, 800))
        detector.reset()
        repeat(6) { assertFalse(detector.acceptLevel(0.0, 800)) }
        repeat(593) { assertFalse(detector.acceptLevel(2000.0, 800)) }
        assertTrue(detector.acceptLevel(2000.0, 800))
    }

    @Test fun quietRoomTimesOutOnSampleClockAndNoiseCalibrationIsRelative() {
        val detector = VoiceEndpointDetector()
        repeat(119) { assertFalse(detector.acceptLevel(0.0, 800)) }
        assertTrue(detector.acceptLevel(0.0, 800))
        detector.reset()
        repeat(6) { assertFalse(detector.acceptLevel(1000.0, 800)) }
        repeat(20) { assertFalse(detector.acceptLevel(2000.0, 800)) }
        assertFalse(detector.acceptLevel(4000.0, 800))
        repeat(17) { assertFalse(detector.acceptLevel(1000.0, 800)) }
        assertTrue(detector.acceptLevel(1000.0, 800))
    }
}
