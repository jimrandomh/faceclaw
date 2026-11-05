package com.faceclaw.app

import kotlin.test.*

/** Vectors are bytes captured from a RayNeo iO (Strix OS 1.0.5.12 / 1.0.4.12 + CFW) on 2026-11-01. */
class RayNeoIoProtocolTest {
    private fun hex(value: String) = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    private val phoneId = hex("fac582dfa91e")
    private val glassesId = hex("006a5e5f33c2")

    @Test
    fun crcAndFrames() {
        assertEquals(0x31c3, RayNeoIoProtocol.crc16Xmodem("123456789".encodeToByteArray()))
        val payload = hex("100001")
        val frame = RayNeoIoProtocol.encodeFrame(0x1234, RayNeoIoProtocol.BUSINESS_CFW, payload)
        assertEquals(13, frame.size)
        assertContentEquals(hex("aa55000712340" + "0f0100001"), frame.copyOfRange(0, 11))
        val decoded = RayNeoIoProtocol.decodeFrame(frame)!!
        assertEquals(0x1234, decoded.messageNumber)
        assertEquals(0xf0, decoded.business)
        assertContentEquals(payload, decoded.payload)
        frame[9] = 9
        assertNull(RayNeoIoProtocol.decodeFrame(frame))
    }

    @Test
    fun reassemblerSpansNotificationsAndSkipsJunk() {
        val a = RayNeoIoProtocol.encodeFrame(1, 15, ByteArray(300) { it.toByte() })
        val b = RayNeoIoProtocol.encodeFrame(2, 0xf0, hex("0195000001070024cf"))
        val stream = hex("0102") + a + b
        val r = RayNeoIoProtocol.FrameReassembler()
        val frames = RayNeoIoProtocol.writes(stream, 23).flatMap { r.ingest(it) }
        assertEquals(listOf(1, 2), frames.map { it.messageNumber })
        assertEquals(300, frames[0].payload.size)
        assertEquals(0, r.pendingBytes)
        // a corrupt head is skipped, the next good frame still decodes
        val bad = a.copyOf().also { it[20] = (it[20] + 1).toByte() }
        assertEquals(listOf(2), r.ingest(bad + b).map { it.messageNumber })
    }

    @Test
    fun handshakeMatchesCapture() {
        // the Mac harness's request (iOS platform byte, name "Amoli", model "Mac")
        assertContentEquals(
            hex("11002810000101110006fac582dfa91e120005416d6f6c69130001011600066950686f6e651700034d6163"),
            RayNeoIoProtocol.versionRequest(phoneId, "Amoli", "iPhone", "Mac", RayNeoIoProtocol.PLATFORM_IOS),
        )
        val reply = RayNeoIoProtocol.parseVersionReply(
            hex("11004a10000102110006006a5e5f33c212000e5261794e656f20694f2d323232391300010514000f3030364135453546333343323232391500010518000f303036413545354633334332323239"),
        )!!
        assertContentEquals(glassesId, reply.glassesId)
        assertEquals(2, reply.protocolVersion)
        assertEquals("006A5E5F33C2229", reply.serial)
        assertFalse(reply.accountBound)
        assertContentEquals(
            hex("18002a100004875e2013110020efed651a6aacd1834e8023891eaf80ec4a25814db5222e42655b71fdd373ab96"),
            RayNeoIoProtocol.guestAuthRequest(hex("875e2013"), phoneId, glassesId),
        )
        val authReply = hex("19002a1000042316e62111002082289251b37c1ddb76694d5a4bb4e911a79ad8f2867d7379bb8125f36ae6acac")
        assertTrue(RayNeoIoProtocol.isGuestAuthReply(authReply))
        assertTrue(RayNeoIoProtocol.verifyGuestAuthReply(authReply, phoneId, glassesId))
        assertFalse(RayNeoIoProtocol.verifyGuestAuthReply(authReply, hex("fac582dfa91f"), glassesId))
    }

    @Test
    fun envelopes() {
        assertContentEquals(
            hex("080110011a027b7d"),
            RayNeoIoProtocol.encodeEnvelope(RayNeoIoProtocol.Envelope(RayNeoIoProtocol.OTA_VERSION, "{}")),
        )
        val status = RayNeoIoProtocol.decodeEnvelope(hex(GENERAL_STATUS))!!
        assertEquals(1, status.type)
        assertEquals(98, RayNeoIoProtocol.batteryFromLauncherJson(status.json))
        assertEquals(100, RayNeoIoProtocol.batteryFromLauncherJson("""{"cmd":"battery_change","payload":{"value":100,"mode":1}}"""))
        assertEquals(-1, RayNeoIoProtocol.batteryFromLauncherJson("""{"cmd":"screen_status","payload":{"value":1}}"""))
        val request = RayNeoIoProtocol.Envelope(1, RayNeoIoProtocol.GENERAL_STATUS_REQUEST, sequence = 300, mode = RayNeoIoProtocol.MODE_REQUEST)
        val back = RayNeoIoProtocol.decodeEnvelope(RayNeoIoProtocol.encodeEnvelope(request))!!
        assertEquals(300, back.sequence)
        assertEquals(RayNeoIoProtocol.MODE_REQUEST, back.mode)
        assertEquals(request.json, back.json)
    }

    @Test
    fun cfwLink() {
        assertContentEquals(hex("100001"), RayNeoIoProtocol.controlPacket(RayNeoIoProtocol.CTRL_QUERY))
        val record = ByteArray(500) { it.toByte() }
        val packets = RayNeoIoProtocol.cfwPackets(record, 0x95, 240)
        assertEquals(listOf(0x81, 0x01, 0x41), packets.map { it[0].toInt() and 255 })
        assertTrue(packets.all { it[1] == 0x95.toByte() })
        assertContentEquals(record, packets.flatMap { it.drop(2) }.toByteArray())
        assertEquals(0xc1, RayNeoIoProtocol.cfwPackets(ByteArray(5), 1)[0][0].toInt() and 255)

        val ack = RayNeoIoProtocol.parseCfwAck(hex("0195000001070024cf"))!!
        assertFalse(ack.nack)
        assertEquals(0x95, ack.streamId)
        assertEquals(0, ack.messageId)
        assertEquals(1, ack.lens)
        assertEquals(7, ack.size)
        assertEquals(0xcf24, ack.checksum)
        assertTrue(RayNeoIoProtocol.parseCfwAck(hex("0395000002070024cf"))!!.nack)
        assertNull(RayNeoIoProtocol.parseCfwAck(hex("0195000003070024cf")))

        // Glassly v13 IDENT, then the Faceclaw fork's with the revision string appended
        val v13 = RayNeoIoProtocol.parseIdent(hex("110d1c02dc00f00000010d007f474c4153534c594346572d494f2f31330019"))!!
        assertEquals(540, v13.width)
        assertEquals(220, v13.height)
        assertEquals(240, v13.maxChunk)
        assertEquals(13, v13.revision)
        assertEquals("GLASSLYCFW-IO/13", v13.name)
        assertFalse(v13.faceclaw)
        val fc = RayNeoIoProtocol.parseIdent(hex("110d1c02dc00f00000010d00ff474c4153534c594346572d494f2f3133001946616365636c61772f333800"))!!
        assertTrue(fc.faceclaw)
        assertEquals(38, fc.faceclawRevision)
        assertFalse(fc.brightnessControl)
        val bright = RayNeoIoProtocol.parseIdent(hex("110d1c02dc00f00000010d00ff474c4153534c594346572d494f2f3133001946616365636c61772f33380062726967687433302061" + "6c73313600"))!!
        assertEquals(listOf("bright30", "als16"), bright.features)
        assertEquals(38, bright.faceclawRevision)
        assertTrue(bright.brightnessControl)
        // a Glassly build with no display lists has no brightness control, whatever else it says
        assertFalse(RayNeoIoProtocol.Ident(540, 220, 240, 13, 0x7f, "x", -1, listOf("bright30", "als16")).brightnessControl)

        val als = ByteArray(25)
        als[0] = 0x1f; als[1] = 65; als[2] = 76; als[3] = 1
        assertEquals(24, RayNeoIoProtocol.parseAlsReport(als)!!.size)
        assertEquals(65, RayNeoIoProtocol.parseAlsReport(als)!![0].toInt())
        assertNull(RayNeoIoProtocol.parseAlsReport(als.copyOf(24)))
        assertNull(RayNeoIoProtocol.parseAlsReport(als.copyOf().also { it[3] = 2 }))
        assertNull(RayNeoIoProtocol.parseAlsReport(als.copyOf().also { it[0] = 0x15 }))

        assertEquals(1, RayNeoIoProtocol.parsePageState(hex("130100")))
        val g = RayNeoIoProtocol.parseGesture(hex("0703010a000000"))!!
        assertEquals(3, g.eventType)
        assertEquals(1, g.source)
        assertEquals(10L, g.tick)
    }

    @Test
    fun recordsShareTheG2Encoder() {
        // the G2 envelope is unchanged by the record/packet split
        val g2 = CfwTransport.frame("123456789abcdef".encodeToByteArray(), 255, 3, 23)
        assertContentEquals(hex("aa21ff0c0101f000830b0f0078c331323334862b"), g2[0])
        // an iO record carries the same flags/length/CRC header
        val t = CfwTransport(testPlatform())
        val message = ByteArray(64) { (it % 7).toByte() }
        val rec = t.encodeRecord(message, CfwTransport.BOTH)
        assertEquals(CfwTransport.BOTH or CfwTransport.COMPRESSED or CfwTransport.RESET_CONTEXT, rec[0].toInt())
        assertEquals(CfwTransport.crc(message), (rec[3].toInt() and 255) or ((rec[4].toInt() and 255) shl 8))
        assertContentEquals(message, inflateRecords(listOf(rec))[0])
        // the next record continues the same compression context
        val second = t.encodeRecord(message, CfwTransport.BOTH)
        assertEquals(CfwTransport.BOTH or CfwTransport.COMPRESSED, second[0].toInt())
        t.close()
    }

    @Test
    fun advertisement() {
        assertEquals("00:6A:5E:5F:33:C2", RayNeoIoBle.macFromManufacturerData(hex("07006a5e5f33c2130000000000000001")))
        assertNull(RayNeoIoBle.macFromManufacturerData(hex("0800")))
        assertTrue(RayNeoIoBle.matchesName("RayNeo iO-2229"))
        assertFalse(RayNeoIoBle.matchesName("Even G2_32_L_693CCB"))
    }

    private companion object {
        const val GENERAL_STATUS = "080110011aa6037b2267656e6572616c537461747573223a7b226175746f6d617469634272696768746e657373223a66616c73652c2262617474657279223a39382c22626174745f74656d70223a33342c22626c7565746f6f746841646472657373223a2230303a36413a35453a35463a33333a4332222c226272696768746e657373223a312c226465766963654e616d65223a225261794e656f20694f2d32323239222c2269734368617267696e67223a747275652c2263686172676554797065223a302c2273637265656e537461747573223a312c2268616c6c537461747573223a302c226d6963537461747573223a302c22666f6375734d6f6465223a7b22656e61626c65223a302c22656e61626c65476c617373436c6f7365223a312c22706f6c696379223a7b226175746f223a312c22626567696e223a2230393a3030222c22656e64223a2231383a3030222c227765656b646179223a5b302c312c322c332c342c352c365d7d7d2c22707265736372697074696f6e223a7b22656e61626c65223a312c22646567726565223a222d332c302c2d322e37352c30222c227064223a223633227d7d7d"
    }
}
