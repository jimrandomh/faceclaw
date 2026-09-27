package com.faceclaw.app

import kotlin.test.*

class GlassesRingLinkTest {
    private fun hex(value: String) = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private fun toHex(bytes: ByteArray) = bytes.joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
    private val mac = hex("b16a9f2f43dc")

    @Test fun ringMacWireBytesAreLeastSignificantFirst() {
        assertEquals("b16a9f2f43dc", toHex(assertNotNull(ringMacWireBytes("DC:43:2F:9F:6A:B1"))))
        assertNull(ringMacWireBytes(""))
        assertNull(ringMacWireBytes("DC:43:2F:9F:6A"))
        assertNull(ringMacWireBytes("DC:43:2F:9F:6A:ZZ"))
    }

    @Test fun disconnectRequestWireShape() {
        // commandId=8 magic=0x21 disconnectInfo(7){dev=0, ringMac}
        assertEquals("080810213a0a08001206b16a9f2f43dc", toHex(BleProtocol.buildRingDisconnectRequest(0x21, mac)))
    }

    @Test fun connectRequestWireShape() {
        // commandId=6 magic=0x21 ringInfo(5){connectRing=[01], ringMac, ringName="R1"}
        assertEquals("08061021" + "2a" + "0f" + "0a0101" + "1206b16a9f2f43dc" + "1a025231",
            toHex(BleProtocol.buildRingConnectRequest(0x21, true, mac, "R1".encodeToByteArray())))
    }

    @Test fun parsesGlassesReportsThroughFraming() {
        // A RING_CONNECT_INFO notification: ringInfo{connectRing, ringMac, ringName, connRet=0}.
        val info = hex("0a0101") + hex("1206") + mac + hex("1a025231") + hex("2000")
        val pb = hex("0806") + hex("1005") + byteArrayOf(0x2a, info.size.toByte()) + info
        val frame = BleProtocol.parseFrame(BleProtocol.framePb(pb, BleProtocol.SID_SECURITY_AUTH, 1, 1).single())
        val report = assertNotNull(BleProtocol.parseRingConnectInfo(frame.pb))
        assertEquals("b16a9f2f43dc", toHex(assertNotNull(report.ringMac)))
        assertEquals("R1", report.ringName)
        assertEquals(0, report.code)

        // even-g2-protocol's captured sid-0x91 "Device Identity": {1:1, 2:19, 3:{1:mac, 2:1}}
        val event = hex("08011013" + "1a0a" + "0a06b16a9f2f43dc" + "1001")
        val eventFrame = BleProtocol.parseFrame(BleProtocol.framePb(event, BleProtocol.SID_RING_DATA, 1, 1).single())
        val ringEvent = assertNotNull(BleProtocol.parseRingDataEvent(eventFrame.pb))
        assertEquals("b16a9f2f43dc", toHex(assertNotNull(ringEvent.ringMac)))
        assertEquals(1, ringEvent.code)

        assertNull(BleProtocol.parseRingConnectInfo(BleProtocol.buildAuthenticationRequest(3)))
    }
}
