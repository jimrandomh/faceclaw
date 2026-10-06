package com.faceclaw.app

import kotlin.test.*

class VideoFrameScalerTest {
    private val identity = ByteArray(256) { it.toByte() }

    private fun scale(scaler: VideoFrameScaler, luma: ByteArray, lut: ByteArray = identity): IntArray {
        val out = ByteArray(scaler.outputWidth * scaler.outputHeight)
        scaler.scale(luma, 0, scaler.sourceWidth, 1, lut, out)
        return IntArray(out.size) { out[it].toInt() and 0xff }
    }

    @Test fun twoToOneDownscaleAveragesEachBox() {
        // 4x2 source -> 2x1: each output is the mean of a 2x2 box.
        val luma = byteArrayOf(0, 100, 200.toByte(), 200.toByte(), 20, 80, 100, 100)
        val scaler = VideoFrameScaler(4, 2, 0, 2, 1)
        assertContentEquals(intArrayOf(50, 150), scale(scaler, luma))
    }

    @Test fun largeDownscaleStaysWithinTheTapBudget() {
        // 100:1 horizontally still averages only MAX_TAPS samples, spread across the box.
        val luma = ByteArray(200) { (if (it % 100 < 50) 0 else 200).toByte() }
        val scaler = VideoFrameScaler(200, 1, 0, 2, 1)
        assertContentEquals(intArrayOf(100, 100), scale(scaler, luma))
    }

    @Test fun upscaleIsNearestNeighbor() {
        val scaler = VideoFrameScaler(2, 1, 0, 4, 2)
        assertContentEquals(intArrayOf(10, 10, 90, 90, 10, 10, 90, 90), scale(scaler, byteArrayOf(10, 90)))
    }

    @Test fun offsetAndStridesSelectTheVisiblePlane() {
        // A 2x2 visible crop at (1, 1) of a 4-wide plane, with interleaved samples (pixelStride 2).
        val plane = ByteArray(40)
        fun put(x: Int, y: Int, v: Int) { plane[(1 + y) * 10 + 1 + x * 2] = v.toByte() }
        put(0, 0, 11); put(1, 0, 22); put(0, 1, 33); put(1, 1, 44)
        val scaler = VideoFrameScaler(2, 2, 0, 2, 2)
        val out = ByteArray(4)
        scaler.scale(plane, 11, 10, 2, identity, out)
        assertContentEquals(byteArrayOf(11, 22, 33, 44), out)
    }

    @Test fun rotationsMatchTheContainerClockwiseConvention() {
        // Coded 3x2:  1 2 3
        //             4 5 6
        val luma = byteArrayOf(1, 2, 3, 4, 5, 6)
        assertContentEquals(intArrayOf(4, 1, 5, 2, 6, 3), scale(VideoFrameScaler(3, 2, 90, 2, 3), luma))
        assertContentEquals(intArrayOf(6, 5, 4, 3, 2, 1), scale(VideoFrameScaler(3, 2, 180, 3, 2), luma))
        assertContentEquals(intArrayOf(3, 6, 2, 5, 1, 4), scale(VideoFrameScaler(3, 2, 270, 2, 3), luma))
    }

    @Test fun normalizeRotationSnapsToQuarterTurns() {
        assertEquals(0, VideoFrameScaler.normalizeRotation(0))
        assertEquals(90, VideoFrameScaler.normalizeRotation(90))
        assertEquals(270, VideoFrameScaler.normalizeRotation(-90))
        assertEquals(180, VideoFrameScaler.normalizeRotation(540))
        assertEquals(0, VideoFrameScaler.normalizeRotation(359))
    }

    @Test fun limitedRangeStretchesAndMonochromeThresholds() {
        val gray = VideoFrameScaler.toneLut(limitedRange = true, gamma = 1f, monochrome = false)
        assertEquals(0, gray[16].toInt() and 0xff)
        assertEquals(0, gray[0].toInt() and 0xff)
        assertEquals(255, gray[235].toInt() and 0xff)
        assertEquals(255, gray[255].toInt() and 0xff)
        val mono = VideoFrameScaler.toneLut(limitedRange = false, gamma = 2.2f, monochrome = true)
        assertEquals(0, mono[127].toInt() and 0xff)
        assertEquals(255, mono[128].toInt() and 0xff)
        // Gamma darkens midtones but leaves the ends alone.
        val photo = VideoFrameScaler.toneLut(limitedRange = false, gamma = 2.2f, monochrome = false)
        assertTrue((photo[128].toInt() and 0xff) < 64)
        assertEquals(255, photo[255].toInt() and 0xff)
    }
}
