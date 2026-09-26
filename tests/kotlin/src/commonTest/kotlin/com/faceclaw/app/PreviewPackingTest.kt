package com.faceclaw.app

import kotlin.test.*

class PreviewPackingTest {
    private fun level(value: Byte): Int = minOf(15, ((value.toInt() and 255) + 8) / 16)

    @Test
    fun everyPairOfGrayValuesHasTheSameWireEncoding() {
        val pixels = ByteArray(65536 * 2) { if (it % 2 == 0) (it / 512).toByte() else (it / 2).toByte() }
        val packed = BmpUtil.pack4bppFromGray8(pixels, 512, 256)
        for (i in packed.indices) {
            assertEquals((level(pixels[i * 2]) * 16 + level(pixels[i * 2 + 1])).toByte(), packed[i], "pair $i")
        }
        for (v in 0..255) assertEquals(level(v.toByte()), BmpUtil.nibbleForGray(v))
    }

    @Test
    fun oddWidthsPadEveryRowAndIgnoreTrailingInput() {
        for (width in listOf(1, 3, 5, 639, 641)) {
            val height = 7
            val pixels = ByteArray(width * height + 13) { (it * 73 + 19).toByte() }
            val stride = (width + 1) / 2
            val packed = BmpUtil.pack4bppFromGray8(pixels, width, height)
            assertEquals(stride * height, packed.size)
            for (y in 0 until height) {
                for (x in 0 until width) {
                    val byte = packed[y * stride + x / 2].toInt() and 255
                    assertEquals(level(pixels[y * width + x]), if (x % 2 == 0) byte / 16 else byte % 16)
                }
                assertEquals(0, packed[(y + 1) * stride - 1].toInt() and 15)
            }
        }
        assertContentEquals(ByteArray(4), BmpUtil.pack4bppFromGray8(null, 3, 2))
        assertContentEquals(ByteArray(4), BmpUtil.pack4bppFromGray8(ByteArray(5) { -1 }, 3, 2))
        assertTrue(BmpUtil.pack4bppFromGray8(null, 0, 2).isEmpty())
    }

    @Test
    fun wireFramesSkipPreviewButExplicitReadbackIncludesLatestShellAndPixels() {
        val compositor = SurfaceCompositor(false)
        compositor.configureScreen(3, 2)
        compositor.configureSurface("app", 0, 0, 3, 2, 0, SurfaceCompositor.TRANSPARENCY_OPAQUE)
        // One white 2x1 shell layer at (0,0), with no dimming or selection.
        val header = listOf(1, 1, 0, 0, 2, 1, 256, 0, 0).flatMap { listOf(it.toByte(), (it shr 8).toByte()) }.toByteArray()
        compositor.setShellScene(ArrayByteReader(header + byteArrayOf(-16, -16)))
        val wire = compositor.applyAndComposite("app", ArrayByteReader(ByteArray(6) { 32 }), 0, 0, 3, 2, "first")
        assertSame(wire.screenGray, wire.gray) // ShellScene.preview allocates its own pixels.
        assertContentEquals(ByteArray(6) { 32 }, wire.screenGray)
        assertEquals(1, wire.shellScene.layers.size)
        val preview = assertNotNull(compositor.previewComposite())
        assertContentEquals(byteArrayOf(-16, -16, 32, 32, 32, 32), preview.gray)
        assertEquals(wire.fingerprint, preview.fingerprint)
        assertContentEquals(wire.screenGray, preview.screenGray)

        // Updates while hidden retain the newest frame. Preview reads don't
        // consume the wire sequence or affect the next submitted frame.
        val newer = compositor.applyAndComposite("app", ArrayByteReader(ByteArray(6) { 64 }), 0, 0, 3, 2, "second")
        assertEquals(wire.seq + 1, newer.seq)
        assertSame(newer.screenGray, newer.gray)
        assertContentEquals(byteArrayOf(-16, -16, 64, 64, 64, 64), compositor.previewComposite()!!.gray)
        compositor.setBlanked(true)
        assertContentEquals(ByteArray(6), compositor.previewComposite()!!.gray)
        compositor.setBlanked(false)
        assertContentEquals(byteArrayOf(-16, -16, 64, 64, 64, 64), compositor.previewComposite()!!.gray)
    }
}
