package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class Lc3PacketFramerTest {
    private class FakeCodec(var fail: Boolean = false) : Lc3Codec {
        var calls = 0
        override fun decodeFrames(packet: ByteArray, offset: Int, length: Int, pcmOut: ShortArray): Int {
            calls++
            assertEquals(0, offset)
            assertEquals(Lc3PacketFramer.LC3_BYTES, length)
            return if (fail) -1 else Lc3PacketFramer.SAMPLES_PER_PACKET
        }
    }

    private fun packet(counter: Int, ssr: Int = 0, angle: Int = 0): ByteArray {
        val p = ByteArray(Lc3PacketFramer.PACKET_BYTES)
        p[Lc3PacketFramer.COUNTER_OFFSET] = counter.toByte()
        p[Lc3PacketFramer.SSR_OFFSET] = (ssr and 0xff).toByte()
        p[Lc3PacketFramer.SSR_OFFSET + 1] = ((ssr shr 8) and 0xff).toByte()
        p[Lc3PacketFramer.ANGLE_OFFSET] = (angle and 0xff).toByte()
        p[Lc3PacketFramer.ANGLE_OFFSET + 1] = ((angle shr 8) and 0xff).toByte()
        return p
    }

    @Test
    fun countsRealDuplicateLateAndMissingPackets() {
        val codec = FakeCodec()
        val framer = Lc3PacketFramer(codec)
        val pcm = ShortArray(Lc3PacketFramer.SAMPLES_PER_PACKET)
        assertEquals(800, framer.decodePacket(packet(250), pcm))
        assertEquals(800, framer.decodePacket(packet(251), pcm))
        assertEquals(0, framer.decodePacket(packet(251), pcm)) // relayed by the other arm
        assertEquals(0, framer.decodePacket(packet(250), pcm)) // late copy (gap 255)
        assertEquals(800, framer.decodePacket(packet(254), pcm)) // 252, 253 lost
        assertEquals(800, framer.decodePacket(packet(1), pcm)) // wraps past 255 -> 0; 255, 0 lost
        assertEquals(0, framer.decodePacket(packet(129), pcm)) // gap 128 is late, not 127 losses
        assertEquals(4, framer.realPackets)
        assertEquals(3, framer.duplicatePackets)
        assertEquals(4, framer.missingPackets)
        assertEquals(0, framer.decodeErrors)
        assertEquals(4, codec.calls)
    }

    @Test
    fun parsesSignedTrailerAndRejectsBadInput() {
        val codec = FakeCodec()
        val framer = Lc3PacketFramer(codec)
        val pcm = ShortArray(Lc3PacketFramer.SAMPLES_PER_PACKET)
        framer.decodePacket(packet(7, ssr = -1234, angle = -45), pcm)
        assertEquals(-1234, framer.lastSsr)
        assertEquals(-45, framer.lastAngleDegrees)
        assertEquals(0, framer.decodePacket(ByteArray(10), pcm))
        assertEquals(0, framer.decodePacket(null, pcm))
        assertEquals(2, framer.decodeErrors)
        assertFailsWith<IllegalArgumentException> { framer.decodePacket(packet(8), ShortArray(10)) }
        codec.fail = true
        assertEquals(0, framer.decodePacket(packet(8), pcm))
        assertEquals(3, framer.decodeErrors)
        // A failed decode does not advance the counter, so 8 is still accepted afterwards.
        codec.fail = false
        assertEquals(800, framer.decodePacket(packet(8), pcm))
        assertEquals(2, framer.realPackets)
    }
}
