package com.faceclaw.app

import kotlin.test.*

class RingInputTest {
    private fun hex(value: String) = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    // Exact packet emitted by the emulated CFW receiver, including a tick > INT_MAX.
    private val packet = hex("08026a151a13080e1002a2060c524901010aabcd00efcdab89")

    @Test fun preservesOriginalClockAndRawFieldsThroughTheNativeDecoder() {
        val decoded = assertNotNull(G2Event.decodePayload(224, packet))
        assertEquals("sys-event", decoded.kind)
        assertEquals(14, decoded.eventType)
        assertEquals(2, decoded.eventSource)
        assertEquals(0x89abcdefL, decoded.ringTick)
        assertEquals(10, decoded.ringType)
        assertEquals(171, decoded.ringAux)
        assertEquals(205, decoded.ringSpeed)
        // Exercise framing and CRC removal too (Android's entry point).
        val frame = BleProtocol.framePb(packet, 224, 1, 1).single()
        val native = assertNotNull(G2Event.decode(BleProtocol.parseFrame(frame)))
        assertEquals(decoded.ringTick, native.ringTick)
    }

    @Test fun legacyAndInvalidExtensionsNeverInventATimestamp() {
        assertEquals(-1L, assertNotNull(G2Event.decodePayload(224, hex("08026a041a02080e"))).ringTick)
        for (offset in listOf(9,13,14,15,16,20)) {
            val bad = packet.copyOf(); bad[offset] = (bad[offset].toInt() + 1).toByte()
            assertEquals(-1L, assertNotNull(G2Event.decodePayload(224, bad)).ringTick)
        }
        for (tick in listOf(0L,1L,0xffffffffL)) {
            val p = packet.copyOf()
            for (i in 0..3) p[21+i] = (tick shr (i*8)).toByte()
            assertEquals(tick, assertNotNull(G2Event.decodePayload(224,p)).ringTick)
        }
    }
}
