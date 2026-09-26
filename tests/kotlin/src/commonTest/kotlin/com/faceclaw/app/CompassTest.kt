package com.faceclaw.app

import kotlin.test.*

class CompassTest {
    private fun hex(text: String) = text.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    @Test
    fun receiverPayloadAndAndroidFrameDecodeTheSameCompassSample() {
        val payload = hex("080f1000520308e702a2060c434d010302038c0098badcfe")
        for (flag in listOf(1, 6)) {
            val frame = BleProtocol.framePb(payload, 8, flag, 15).single()
            val received = MessageReceiver().receive("R", frame, 0).single()
            val shared = assertNotNull(BleProtocol.parseCompassPayload(received.sid, received.flag, received.payload))
            val android = assertNotNull(BleProtocol.parseCompassEvent(BleProtocol.parseFrame(frame)))
            assertEquals(359, shared.headingDegrees)
            assertEquals(15, shared.command)
            assertEquals(3, shared.magneticAccuracy)
            assertEquals(2, shared.magneticAnomalies)
            assertEquals(3, shared.orientationSource)
            assertEquals(0x8c, shared.diagnosticFlags)
            assertEquals(0xfedcba98L, shared.sampleTimeMs)
            assertEquals(android.sampleTimeMs, shared.sampleTimeMs)
        }
        assertNull(BleProtocol.parseCompassPayload(9, 1, payload))
        assertNull(BleProtocol.parseCompassPayload(8, 0x20, payload))
        assertNull(BleProtocol.parseCompassPayload(8, 1, hex("080f1000520308e802")))
        assertNull(BleProtocol.parseCompassPayload(8, 1, byteArrayOf()))
        for (size in 9 until payload.size) {
            val legacy = assertNotNull(BleProtocol.parseCompassPayload(8, 1, payload.copyOf(size)))
            assertEquals(359, legacy.headingDegrees)
            assertEquals(-1, legacy.diagnosticFlags)
        }
        for (command in listOf(16, 17)) {
            val calibration = assertNotNull(BleProtocol.parseCompassPayload(8, 1, byteArrayOf(8, command.toByte(), 16, 0)))
            assertEquals(command, calibration.command)
            assertEquals(-1, calibration.headingDegrees)
        }
    }
}
