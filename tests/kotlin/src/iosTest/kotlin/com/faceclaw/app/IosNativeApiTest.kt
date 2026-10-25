package com.faceclaw.app

import kotlin.test.*

class IosNativeApiTest {
    @Test
    fun binaryFacadeRoundTripsAndSlices() {
        val bytes = byteArrayOf(0, -1, 2, -128)
        assertContentEquals(bytes, bytes.data().byteArray())
        assertTrue(byteArrayOf().data().byteArray().isEmpty())
        val reader = IosByteReader(bytes.data())
        assertEquals(0, reader.get().toInt())
        val target = ByteArray(5)
        reader.get(target, 1, 3)
        assertContentEquals(byteArrayOf(0, -1, 2, -128, 0), target)
        assertEquals(0, reader.remaining())
        val protocol = IosProtocol()
        val auth = protocol.authentication(101)
        val frames = protocol.frame(auth, 128, 0, 64, 185)
        val result = IosMessageReceiver().receive("L", frames.single(), 0).single()
        assertEquals(101, result.magic)
        assertContentEquals(auth.byteArray(), result.payload.byteArray())
    }

    @Test
    fun bgraPacketsConvertWithTheSharedGrayTone() {
        // 2x1: opaque orange, half-transparent white (B, G, R, A in memory).
        val bgra = byteArrayOf(2, 0, 1, 0, 0x20, 0x80.toByte(), 0xff.toByte(), 0xff.toByte(),
            0xff.toByte(), 0xff.toByte(), 0xff.toByte(), 0x80.toByte())
        val argb = intArrayOf(0xffff8020.toInt(), 0x80ffffff.toInt())
        val protocol = IosProtocol()
        for (dither in listOf(false, true)) {
            assertContentEquals(GrayPacket.fromArgb(argb, 2, 1, 2.2f, dither),
                protocol.grayPacket(bgra.data(), 2.2f, dither).byteArray())
        }
        assertEquals(0UL, protocol.grayPacket(bgra.copyOf(10).data(), 1f, false).length)
        assertEquals(0UL, protocol.grayPacket(byteArrayOf(0, 0, 1, 0).data(), 1f, false).length)
    }

    @Test
    fun compassFacadePreservesTheEndOfTheCrcFreePayload() {
        val protocol = IosProtocol()
        val payload = byteArrayOf(8, 15, 16, 0, 82, 3, 8, -25, 2).data()
        assertEquals(359, protocol.compassInput(payload, 8, 1)?.headingDegrees)
        assertNull(protocol.compassInput(payload, 8, 0))
    }

    @Test
    fun nativeCompositorClipsPartialUpdatesBeforeCoalescing() {
        val compositor = IosSurfaceCompositor(3, 2)
        compositor.configure("app", 0, 0, 3, 2, 0, false)
        compositor.submit("app", byteArrayOf(10, 20, 30, 40, 50, 60).data(), -1, 0, 3, 2)
        assertContentEquals(byteArrayOf(20, 30, 0, 50, 60, 0), compositor.composite().byteArray())
        compositor.submit("app", byteArrayOf(99).data(), 2, 1, 1, 1)
        assertContentEquals(byteArrayOf(20, 30, 0, 50, 60, 99), compositor.composite().byteArray())
        compositor.blank(true)
        assertContentEquals(ByteArray(6), compositor.composite().byteArray())
        compositor.blank(false)
        assertEquals(99, compositor.composite().byteArray().last().toInt())
    }
}
