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

    @Test fun directReportsMapLikeTheGlassesRelay() {
        // Frames captured on the direct link (bae80011), 2026-10-06.
        val down = assertNotNull(FaceclawRingEventDecoder.decode(hex("000961000a000013cb0000"))).event
        assertEquals(BleProtocol.EVENT_RING_PRESS, down.eventType)
        assertEquals(BleProtocol.EVENT_SOURCE_RING, down.eventSource)
        assertEquals(10, down.ringType)
        assertEquals(0xcb13L, down.ringTick)

        val tapHold = assertNotNull(FaceclawRingEventDecoder.decode(hex("0009610009020055d60200"))).event
        assertEquals(BleProtocol.EVENT_SHORT_THEN_LONG_PRESS, tapHold.eventType)
        assertEquals(2, tapHold.ringAux)
        assertEquals(0x02d655L, tapHold.ringTick)

        val swipe = assertNotNull(FaceclawRingEventDecoder.decode(hex("0009610004350009cc0000"))).event
        assertEquals(BleProtocol.EVENT_SCROLL_TOP, swipe.eventType)
        assertEquals(0x35, swipe.ringAux)
        assertEquals(0x00, swipe.ringSpeed)

        // Same mapping as the CFW relay for every wire type (gesture_fwd.c).
        val relayed = mapOf(0 to 9, 1 to 0, 2 to 3, 4 to 1, 5 to 2, 8 to 10, 9 to 11, 10 to 14, 3 to 127, 0xff to 127)
        for ((wire, sysEvent) in relayed) {
            val frame = hex("0009610000abcdefcdab89").also { it[4] = wire.toByte() }
            val event = assertNotNull(FaceclawRingEventDecoder.decode(frame)).event
            assertEquals(sysEvent, event.eventType, "wire type $wire")
            assertEquals(0x89abcdefL, event.ringTick)
        }
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
