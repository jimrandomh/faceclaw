package com.faceclaw.app

import kotlin.math.abs
import kotlin.math.sqrt
import kotlin.test.*

class ImuOrientationTest {
    private val s = sqrt(0.5)

    private fun assertVec(expected: DoubleArray, actual: DoubleArray, what: String) {
        for (i in 0..2) assertTrue(abs(expected[i] - actual[i]) < 1e-9, "$what: expected ${expected.toList()}, got ${actual.toList()}")
    }

    /** The poses measured on hardware (level, 45° up, 45° to the right) read the G2's values on every model. */
    @Test fun measuredPosesMatchTheG2Frame() {
        val level = doubleArrayOf(0.0, 0.0, 1.0)
        val up = doubleArrayOf(s, 0.0, s)
        val right = doubleArrayOf(0.0, s, s)
        val g1 = listOf(doubleArrayOf(0.0, 1.0, 0.0), doubleArrayOf(0.0, s, -s), doubleArrayOf(-s, s, 0.0))
        for ((name, canonical, raw) in listOf(Triple("level", level, g1[0]), Triple("up", up, g1[1]), Triple("right", right, g1[2]))) {
            assertVec(canonical, ImuOrientation.toCanonical(GlassesType.G1, raw[0], raw[1], raw[2]), "G1 $name")
            assertVec(canonical, ImuOrientation.toCanonical(GlassesType.G2, canonical[0], canonical[1], canonical[2]), "G2 $name")
        }
    }
}
