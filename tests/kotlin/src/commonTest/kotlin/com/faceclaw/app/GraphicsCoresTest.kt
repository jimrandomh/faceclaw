package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertSame
import kotlin.test.assertTrue

class GraphicsCoresTest {
    private fun checksum(bytes: ByteArray): Long {
        var sum = 7L
        for (b in bytes) sum = sum * 31 + (b.toInt() and 0xff)
        return sum
    }

    @Test
    fun grayPacketHeaderAndFlatConversion() {
        // 3x2: opaque white, opaque mid, transparent white, half-alpha red, opaque black, opaque green
        val pixels = intArrayOf(
            0xffffffff.toInt(), 0xff808080.toInt(), 0x00ffffff,
            0x80ff0000.toInt(), 0xff000000.toInt(), 0xff00ff00.toInt(),
        )
        val packet = GrayPacket.fromArgb(pixels, 3, 2, 1f, false)
        assertEquals(4 + 6, packet.size)
        assertContentEquals(byteArrayOf(3, 0, 2, 0), packet.copyOfRange(0, 4))
        assertEquals(255, packet[4].toInt() and 0xff)
        assertEquals(128, packet[5].toInt() and 0xff)
        assertEquals(0, packet[6].toInt() and 0xff) // alpha 0 darkens to black
        assertEquals(76 * 128 / 255, packet[7].toInt() and 0xff) // luma 76 at half alpha
        assertEquals(0, packet[8].toInt() and 0xff)
        assertEquals(149, packet[9].toInt() and 0xff)
        val wide = GrayPacket.fromArgb(IntArray(300 * 2), 300, 2, 1f, false)
        assertContentEquals(byteArrayOf(0x2c, 1, 2, 0), wide.copyOfRange(0, 4))
    }

    @Test
    fun toneCurveDarkensMidtones() {
        val identity = GrayPacket.toneCurve(1f)
        assertEquals((0..255).toList(), identity.toList())
        val curve = GrayPacket.toneCurve(2.2f)
        assertEquals(0, curve[0])
        assertEquals(255, curve[255])
        assertEquals(56, curve[128])
        assertTrue(curve.toList() == curve.sorted())
    }

    @Test
    fun ditherIsDeterministicAndQuantized() {
        // A horizontal ramp over 16x4 so the diffusion has somewhere to go.
        val pixels = IntArray(16 * 4) { i -> val v = (i % 16) * 17; 0xff000000.toInt() or (v shl 16) or (v shl 8) or v }
        val a = GrayPacket.fromArgb(pixels, 16, 4, 1f, true)
        val b = GrayPacket.fromArgb(pixels, 16, 4, 1f, true)
        assertContentEquals(a, b)
        for (i in 4 until a.size) {
            val v = a[i].toInt() and 0xff
            assertTrue(v == 1 || (v % 16 == 0 && v in 16..240), "byte $i = $v")
        }
        // Mid-gray flat area dithers to a mix of two adjacent levels, never a solid.
        val flat = GrayPacket.fromArgb(IntArray(8 * 8) { 0xff7f7f7f.toInt() }, 8, 8, 1f, true)
        val levels = flat.drop(4).map { it.toInt() and 0xff }.toSet()
        assertEquals(setOf(112, 128), levels)
        assertEquals(2001783152304756847L, checksum(a))
    }

    @Test
    fun previewPaletteValues() {
        assertEquals(0xff000000.toInt(), PreviewPalette.argb(0, 0.7, false))
        assertEquals(0xffffffff.toInt(), PreviewPalette.argb(255, 0.7, false))
        assertEquals(0xff00ff00.toInt(), PreviewPalette.argb(255, 0.7, true))
        val gray = PreviewPalette.argb(128, 0.7, false)
        val v = gray and 0xff
        assertEquals(157, v)
        assertEquals(0xff000000.toInt() or (v shl 16) or (v shl 8) or v, gray)
        assertEquals(0xff000000.toInt() or (v shl 8), PreviewPalette.argb(128, 0.7, true))
        assertEquals(0xff808080.toInt(), PreviewPalette.argb(128, 1.0, false))
        val lut = PreviewPalette.lookupTable(0.7, false)
        assertSame(lut, PreviewPalette.lookupTable(0.7, false))
        assertEquals(256, lut.size)
        val expanded = PreviewPalette.expand(byteArrayOf(0, 0x80.toByte(), 0xff.toByte()), 0, 3, 0.7, false)
        assertContentEquals(intArrayOf(lut[0], lut[128], lut[255]), expanded)
    }

    @Test
    fun statusIconsAreStable() {
        val wifi = StatusIconArt.wifi(4)
        val cell = StatusIconArt.cell(2)
        val hotspot = StatusIconArt.hotspot()
        for (icon in listOf(wifi, cell, hotspot)) {
            assertEquals(24 * 24, icon.size)
            assertTrue(icon.any { it.toInt() != 0 })
        }
        assertTrue(StatusIconArt.wifi(0).count { it.toInt() != 0 } < wifi.count { it.toInt() != 0 })
        assertEquals(StatusIconArt.wifi(2).toList(), StatusIconArt.wifi(2).toList())
        assertEquals(listOf(-7515428168691714401L, -7643893777543336767L, 7675840471157348143L), listOf(checksum(wifi), checksum(cell), checksum(hotspot)))
        val scaled = StatusIconArt.scale(wifi, 12)
        assertEquals(144, scaled.size)
        assertSame(wifi, StatusIconArt.scale(wifi, 24))
    }
}
