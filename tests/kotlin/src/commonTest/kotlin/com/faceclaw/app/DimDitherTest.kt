package com.faceclaw.app

import kotlin.test.*

class DimDitherTest {
    @Test fun contextMenuDimHalftonesLevelsThatWouldRoundAway() {
        // CONTEXT_MENU_DIM = 0.25: level 1 becomes a 1/0 halftone instead of black or 1.
        val (even, odd) = DimDither.tables(64)
        assertContentEquals(intArrayOf(0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4), even)
        assertContentEquals(intArrayOf(0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4), odd)
    }

    @Test fun everyFactorGivesMonotonicAdjacentPairsThatKeepVisiblePixels() {
        for (factor in 0..256) {
            val (even, odd) = DimDither.tables(factor)
            assertEquals(0, even[0])
            assertEquals(0, odd[0])
            for (level in 1..15) {
                val halfSteps = even[level] + odd[level]
                assertTrue(even[level] - odd[level] in 0..1, "factor=$factor level=$level")
                assertTrue(halfSteps in 1..2 * level, "factor=$factor level=$level")
                assertTrue(halfSteps >= even[level - 1] + odd[level - 1], "factor=$factor level=$level")
            }
        }
        val (even, odd) = DimDither.tables(256)
        assertContentEquals(IntArray(16) { it }, even)
        assertContentEquals(IntArray(16) { it }, odd)
    }

    @Test fun remapUsesTheEvenTableWhereShiftedXPlusYIsEven() {
        val even = IntArray(16) { 15 - it }
        val odd = IntArray(16) { it / 2 }
        val call = DrawProtocol.remapColors(0, 0, 3, 2, even, odd)
        assertContentEquals(byteArrayOf(DRAW_OP_REMAP_COLORS.toByte(), 0, 0, 0, 0, 0, 3, 0, 2, 0,
            0xfe.toByte(), 0xdc.toByte(), 0xba.toByte(), 0x98.toByte(), 0x76, 0x54, 0x32, 0x10,
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77), call)
        for (shift in listOf(0, 1)) {
            // Rows of 4 pixels: 4, 5, 6, 7 then 8, 9, 10, 11.
            val pixels = byteArrayOf(0x45, 0x67, 0x89.toByte(), 0xab.toByte())
            DisplayListRenderer(emptyMap()).execute(DrawProtocol.sequence(listOf(call)),
                DisplayListRenderer.Target(pixels, 4, 2).shifted(shift))
            val target = DisplayListRenderer.Target(pixels, 4, 2)
            for (y in 0..1) for (x in 0..3) {
                val source = 4 + y * 4 + x
                val expected = when {
                    x !in shift until shift + 3 -> source
                    (x + y) % 2 == 0 -> even[source]
                    else -> odd[source]
                }
                assertEquals(expected, target.get(x, y), "shift=$shift x=$x y=$y")
            }
        }
    }
}
