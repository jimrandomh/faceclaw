package com.faceclaw.app

import kotlin.test.*

class GlassesRingLinkTest {
    private fun hex(value: String) = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private fun toHex(bytes: ByteArray) = bytes.joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
    private val mac = hex("b16a9f2f43dc")

    @Test fun macWireBytesAreLeastSignificantFirst() {
        assertEquals("b16a9f2f43dc", toHex(assertNotNull(macWireBytes("DC:43:2F:9F:6A:B1"))))
        assertNull(macWireBytes(""))
        assertNull(macWireBytes("DC:43:2F:9F:6A"))
        assertNull(macWireBytes("DC:43:2F:9F:6A:ZZ"))
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

    @Test fun unpairRequestWireShape() {
        // commandId=9 magic=0x21 unpairInfo(8){dev=RING(0), ringMac}
        assertEquals("0809" + "1021" + "420a" + "0800" + "1206b16a9f2f43dc", toHex(BleProtocol.buildRingUnpairRequest(0x21, mac)))
    }

    @Test fun ringChecksumMatchesCapturedEvenFrames() {
        // Frames from HCI snoops of Even's app (g2-kit-unofficial examples/ring-direct.ts).
        assertEquals("00971953f964016401000000080d003f0101", toHex(RingProtocol.buildPairAuth(1)))
        assertEquals("00f979f7b164016404000000020c001b64",
            toHex(RingProtocol.buildCheckedFrame(RingProtocol.CHAN_DEVICE, RingProtocol.KIND_REQ, 0x00, 0x02, 4, ByteArray(0))))
        assertEquals("002d946c0164026405000001010c002ac6",
            toHex(RingProtocol.buildCheckedFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_REQ, 0x01, 0x01, 5, ByteArray(0))))
        assertEquals("00d4c9ba7064016403000200051200807710ff3348bb69",
            toHex(RingProtocol.buildCheckedFrame(RingProtocol.CHAN_DEVICE, RingProtocol.KIND_DATA, 0x00, 0x05, 3, hex("10ff3348bb69"))))
    }

    @Test fun advStartCarriesBothTargetsLeastSignificantFirst() {
        val right = assertNotNull(macWireBytes("EC:D7:82:69:3C:CB"))
        val left = assertNotNull(macWireBytes("C4:5A:23:3D:F5:F8"))
        val frame = RingProtocol.buildAdvStart(9, right, left)
        assertValidRingFrame(frame)
        assertEquals("00" + "000a", toHex(frame.copyOfRange(10, 13)))
        assertEquals("cb3c6982d7ec" + "f8f53d235ac4", toHex(frame.copyOfRange(17, frame.size)))
        assertEquals("ffffffffffff".repeat(2),
            toHex(RingProtocol.buildAdvStart(9, ByteArray(6) { 0xff.toByte() }, ByteArray(6) { 0xff.toByte() }).copyOfRange(17, 29)))
    }

    @Test fun touchSwitchAndRemoveRingAreSets() {
        val on = RingProtocol.buildTouchSwitch(2, RingProtocol.TOUCH_SWITCH_SELECTOR_GLASSES, true)
        assertValidRingFrame(on)
        assertEquals("02" + "0007", toHex(on.copyOfRange(10, 13)))
        assertEquals("0201", toHex(on.copyOfRange(17, on.size)))
        assertEquals("0200", toHex(RingProtocol.buildTouchSwitch(2, 2, false).copyOfRange(17, 19)))

        val remove = RingProtocol.buildRemoveRingNotify(3)
        assertValidRingFrame(remove)
        assertEquals("02" + "0082" + "01", toHex(remove.copyOfRange(10, 13)) + toHex(remove.copyOfRange(17, remove.size)))
    }

    @Test fun legacyGlassesChannelFrames() {
        // Bytes from g2-firmware-emulator: the stock G2's pair-auth, the R1's battery
        // report (67%, then charging) and its non-target rejection.
        assertEquals("00358800", toHex(RingProtocol.LEGACY_GLASSES_PAIR_AUTH))
        val idle = assertNotNull(RingProtocol.parseLegacyBattery(hex("00098b004300")))
        assertEquals(67, idle.battery)
        assertEquals(0, idle.charging)
        assertEquals(1, assertNotNull(RingProtocol.parseLegacyBattery(hex("00098b004301"))).charging)
        assertNull(RingProtocol.parseLegacyBattery(hex("00098b006500")))   // 101%
        assertNull(RingProtocol.parseLegacyBattery(hex("00098b0043")))
        assertNull(RingProtocol.parseLegacyBattery(hex("000961000a000013cb0000")))
        assertTrue(RingProtocol.isLegacyTargetRejected(hex("00019600")))
        assertFalse(RingProtocol.isLegacyTargetRejected(hex("0001960000")))
        // Neither is mistaken for input.
        assertNull(FaceclawRingEventDecoder.decode(hex("00098b004300")))
        assertNull(FaceclawRingEventDecoder.decode(hex("00019600")))
    }

    @Test fun ringResponseStatusDecodes() {
        assertEquals("ok", RingProtocol.responseResult(0x03))
        assertEquals("error", RingProtocol.responseResult(0x07))
        assertEquals("refused", RingProtocol.responseResult(0x0b))
        assertEquals("unsupported", RingProtocol.responseResult(0x0f))
        assertNull(RingProtocol.responseResult(0x00))
        assertNull(RingProtocol.responseResult(0x02))
    }

    /** Outer CRC-32C and inner phone checksum both match the bytes. */
    private fun assertValidRingFrame(frame: ByteArray) {
        val crc32 = (frame[1].toInt() and 0xff) or ((frame[2].toInt() and 0xff) shl 8) or
            ((frame[3].toInt() and 0xff) shl 16) or ((frame[4].toInt() and 0xff) shl 24)
        assertEquals(RingProtocol.crc32(frame, 5, frame.size), crc32)
        val args = frame.copyOfRange(17, frame.size)
        val checksum = RingProtocol.phoneChecksum(frame[6].toInt(), frame[8].toInt() and 0xff,
            frame[10].toInt(), frame[11].toInt(), frame[12].toInt() and 0xff, args)
        assertEquals(checksum, (frame[15].toInt() and 0xff) or ((frame[16].toInt() and 0xff) shl 8))
        assertEquals(frame.size - 5, (frame[13].toInt() and 0xff) or ((frame[14].toInt() and 0xff) shl 8))
    }
}
