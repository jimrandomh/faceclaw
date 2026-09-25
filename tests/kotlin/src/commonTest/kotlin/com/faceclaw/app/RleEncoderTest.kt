package com.faceclaw.app

import kotlin.random.Random
import kotlin.test.*

class RleEncoderTest {
    /** Deliberately simple per-pixel reference, independent of the byte scan. */
    private fun reference(packed: ByteArray): ByteArray {
        val output = ArrayList<Byte>()
        var color = -1
        var count = 0
        fun flush() {
            while (count > 0) {
                val n = minOf(count, 65535)
                when {
                    n <= 15 -> output.add((n * 16 + color).toByte())
                    n <= 255 -> { output.add(color.toByte()); output.add(n.toByte()) }
                    else -> { output.add(color.toByte()); output.add(0); output.add(n.toByte()); output.add((n / 256).toByte()) }
                }
                count -= n
            }
        }
        for (byte in packed) for (pixel in listOf((byte.toInt() and 255) / 16, byte.toInt() and 15)) {
            if (pixel != color) { flush(); color = pixel }
            count++
        }
        flush()
        return output.toByteArray()
    }

    @Test fun allTwoByteInputsPreserveExactTokensAcrossNibbleBoundaries() {
        for (value in 0..65535) {
            val packed = byteArrayOf((value / 256).toByte(), value.toByte())
            assertContentEquals(reference(packed), BleImageOptimizer.rleEncode(packed), "input $value")
        }
        assertContentEquals(ByteArray(0), BleImageOptimizer.rleEncode(ByteArray(0)))
    }

    @Test fun longRunsAndEveryTokenBoundaryAtBothNibbleAlignments() {
        for (length in listOf(1, 2, 14, 15, 16, 254, 255, 256, 65534, 65535, 65536, 131070, 131071)) {
            for (prefix in 0..1) for (color in listOf(0, 7, 15)) {
                val values = List(prefix) { (color + 1) % 16 } + List(length) { color } + listOf((color + 2) % 16)
                val packed = ByteArray((values.size + 1) / 2) { i ->
                    (values[i * 2] * 16 + (values.getOrNull(i * 2 + 1) ?: 0)).toByte()
                }
                assertContentEquals(reference(packed), BleImageOptimizer.rleEncode(packed), "$prefix/$length/$color")
            }
        }
    }

    @Test fun noiseAndMixedRunsPreserveExactWireOutput() {
        val random = Random(123)
        repeat(100) {
            val data = random.nextBytes(random.nextInt(1, 4096))
            assertContentEquals(reference(data), BleImageOptimizer.rleEncode(data))
            repeat(20) {
                val start = random.nextInt(data.size)
                data.fill((random.nextInt(16) * 17).toByte(), start, minOf(data.size, start + random.nextInt(1, 200)))
            }
            assertContentEquals(reference(data), BleImageOptimizer.rleEncode(data))
        }
        val screen = ByteArray(640 * 480 / 2) { 0x77 }
        assertContentEquals(reference(screen), BleImageOptimizer.rleEncode(screen))
    }
}
