package com.faceclaw.app

import kotlin.test.*

class BrightnessPolicyTest {
    private fun report(lux: Int, reason: Int = 2, flags: Int = 11): ByteArray {
        val b = ByteArray(24)
        b[0] = 65; b[1] = 76; b[2] = 1; b[3] = reason.toByte(); b[4] = flags.toByte()
        val raw = lux * 10
        for (i in 0..3) b[6+i] = (raw ushr (8*i)).toByte()
        return b
    }

    @Test fun defaultMatchesMeasuredLightingPreferences() {
        val p = BrightnessPolicy()
        for ((raw, expected) in listOf(0 to 20, 2 to 26, 15 to 46, 50 to 100, 500 to 100)) {
            val b = report(0)
            b[6] = raw.toByte(); b[7] = (raw shr 8).toByte()
            p.resetSamples(); p.sample(b, 1000)
            assertEquals(expected, p.target, "raw ALS=$raw")
        }
    }

    @Test fun curveUsesConfiguredBoundsAndLogInterpolation() {
        val p = BrightnessPolicy()
        p.configure(true, 50, 10, 90, "0:0,99:100", 280)
        p.sample(report(9), 1000)
        assertEquals(50, p.target) // log(10) / log(100) = 1/2
        p.resetSamples(); p.sample(report(0), 2000); assertEquals(10, p.target)
        p.resetSamples(); p.sample(report(10000), 3000); assertEquals(90, p.target)
    }

    @Test fun onlySuccessfulPassivePollsDriveAuto() {
        val p = BrightnessPolicy()
        val initial = p.target
        for (reason in listOf(0, 1, 3, 4)) assertFalse(p.sample(report(0, reason), 1000))
        for (flags in listOf(0, 1, 3, 9, 10)) assertFalse(p.sample(report(0, flags = flags), 1000))
        assertFalse(p.sample(byteArrayOf(), 1000))
        assertEquals(initial, p.target)
        assertTrue(p.sample(report(0), 1000)); assertEquals(20, p.target)
    }

    @Test fun manualPersistsAcrossSamplesAndModeChangesUseLatestLight() {
        val p = BrightnessPolicy()
        p.configure(false, 70, 2, 80, "0:0,100:100", 450)
        p.sample(report(100), 1000); assertEquals(70, p.target)
        p.setMode(true, 50); assertEquals(80, p.target)
        p.setMode(false, 0); assertEquals(2, p.target)
        assertEquals(450, p.fadeMs)
    }

    @Test fun brightensFasterThanItDimsAndResetsStaleSamples() {
        val up = BrightnessPolicy(); val down = BrightnessPolicy()
        for (p in listOf(up, down)) p.configure(true, 50, 2, 100, "0:0,100:100", 280)
        up.sample(report(0), 1000); up.sample(report(100), 1500)
        down.sample(report(100), 1000); down.sample(report(0), 1500)
        assertTrue(up.target - 2 > 100 - down.target)
        down.sample(report(0), 20000); assertEquals(2, down.target)
    }

    @Test fun autoHoldsSmallChangesUntilTheyAccumulateToFivePoints() {
        val p = BrightnessPolicy()
        p.configure(true, 50, 20, 40, "0:0,1:20,2:25,3:45,4:50,5:100", 280)
        var now = 1000L
        fun sample(lux: Int, changed: Boolean, target: Int) {
            // Space readings beyond the smoothing window to isolate the deadband.
            now += 11000
            assertEquals(changed, p.sample(report(lux), now), "lux=$lux")
            assertEquals(target, p.target, "lux=$lux")
        }
        sample(0, true, 20)
        repeat(5) { sample(1, false, 20) } // Desired 24 stays suppressed.
        sample(2, true, 25) // Exact five-point increase is accepted.
        sample(3, false, 25) // Desired 29.
        sample(4, true, 30)
        sample(2, true, 25) // Exact five-point decrease is accepted too.
        sample(1, false, 25)
        sample(0, true, 20)
    }

    @Test fun boundsDoNotBypassDeadbandButExplicitChangesDo() {
        for ((initial, lux) in listOf(24 to 0, 36 to 5)) {
            val p = BrightnessPolicy()
            p.configure(false, initial, 20, 40, "0:0,5:100", 280)
            p.setMode(true, initial)
            assertFalse(p.sample(report(lux), 1000))
            assertEquals(initial, p.target)
            p.setMode(false, initial + 1)
            assertEquals(initial + 1, p.target) // Small manual changes remain exact.
            p.setMode(true, initial)
            assertEquals(if (lux == 0) 20 else 40, p.target)
        }
        val p = BrightnessPolicy()
        p.sample(report(0), 1000)
        p.configure(true, 50, 21, 100, BrightnessPolicy.DEFAULT_CURVE, 280)
        assertEquals(21, p.target) // An explicit bounds edit applies immediately.
    }

    @Test fun invalidCurveDoesNotPartiallyChangeLivePolicy() {
        val p = BrightnessPolicy()
        for (curve in listOf("", "0:0", "1:0,100:100", "0:0,1:80,2:50,3:100", "0:0,0:100", "0:0,NaN:100", "0:0,1:99")) {
            assertFailsWith<IllegalArgumentException> { p.configure(false, 90, 20, 80, curve, 0) }
            assertTrue(p.automatic); assertEquals(280, p.fadeMs)
        }
        p.configure(true, 50, 80, 20, "0:0,100:100", 0)
        p.sample(report(0), 1000); assertEquals(80, p.target)
    }
}
