package com.faceclaw.app

import kotlin.random.Random
import kotlin.test.*

internal expect fun testPlatform(): ProtocolPlatform

internal expect fun inflateRecords(records: List<ByteArray>): List<ByteArray>

internal fun record(packets: List<ByteArray>): ByteArray =
    packets.flatMap { it.slice(9 until it.size - 2) }.toByteArray()

private fun hex(value: String) = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

private fun u16(bytes: ByteArray, offset: Int) =
    (bytes[offset].toInt() and 255) or ((bytes[offset + 1].toInt() and 255) shl 8)

class ProtocolTest {
    @Test
    fun javaGoldenPacketsAndCrc() {
        assertEquals(0x29b1, CfwTransport.crc("123456789".encodeToByteArray()))
        assertEquals(0xffff, CfwTransport.crc(byteArrayOf()))
        // Captured from the Java implementation before migration, including sequence wrap.
        val expected =
            listOf(
                "aa21ff0c0101f000830b0f0078c331323334862b",
                "aa21000c0101f000033536373839616263648c7b",
                "aa2101050101f000436566de70",
            )
        val actual = CfwTransport.frame("123456789abcdef".encodeToByteArray(), 255, 3, 23)
        assertEquals(expected.size, actual.size)
        expected.zip(actual).forEach { (a, b) -> assertContentEquals(hex(a), b) }
    }

    @Test
    fun framingBoundariesAndValidation() {
        for (size in listOf(0, 1, 247, 252, 253, 65535)) {
            val data = ByteArray(size) { it.toByte() }
            for (mtu in listOf(23, 247, 512, 517)) {
                val packets = CfwTransport.frame(data, 255, 2, mtu)
                packets.forEachIndexed { i, packet ->
                    assertTrue(packet.size <= mtu - 3)
                    assertEquals((255 + i) and 255, packet[2].toInt() and 255)
                    assertEquals(packet.size - 8, packet[3].toInt() and 255)
                    assertEquals(
                        2 or (if (i == 0) 128 else 0) or (if (i == packets.lastIndex) 64 else 0),
                        packet[8].toInt() and 255,
                    )
                    assertEquals(
                        CfwTransport.crc(packet.copyOfRange(8, packet.size - 2)),
                        u16(packet, packet.size - 2),
                    )
                }
                val stream = record(packets)
                assertEquals(size, u16(stream, 1))
                assertEquals(CfwTransport.crc(data), u16(stream, 3))
                assertContentEquals(data, stream.copyOfRange(5, stream.size))
            }
        }
        for (invalid in listOf<ByteArray?>(null, ByteArray(65536))) assertFailsWith<
            IllegalArgumentException
        > {
            CfwTransport.frame(invalid, 0, 3, 23)
        }
        for (stream in listOf(-1, 256)) assertFailsWith<IllegalArgumentException> {
            CfwTransport.frame(byteArrayOf(), stream, 3, 23)
        }
        for (lens in listOf(0, 4)) assertFailsWith<IllegalArgumentException> {
            CfwTransport.frame(byteArrayOf(), 0, lens, 23)
        }
        for (mtu in listOf(22, 518)) assertFailsWith<IllegalArgumentException> {
            CfwTransport.frame(byteArrayOf(), 0, 3, mtu)
        }
    }

    @Test
    fun streamingCompressionRoundTripsAndResets() {
        val transport = CfwTransport(testPlatform())
        try {
            val text = "shared history 👓 ".repeat(300).encodeToByteArray()
            val inputs = listOf(text, text, byteArrayOf(), byteArrayOf(), text, text)
            val records = inputs.mapIndexed { i, data ->
                if (i == 5) transport.reset()
                record(transport.encode(data, i, if (i < 4) 3 else 1, 247))
            }
            assertTrue(records[1].size < records[0].size)
            assertTrue(records[0][0].toInt() and CfwTransport.RESET_CONTEXT != 0)
            assertEquals(0, records[1][0].toInt() and CfwTransport.RESET_CONTEXT)
            assertTrue(records[4][0].toInt() and CfwTransport.RESET_CONTEXT != 0)
            assertTrue(records[5][0].toInt() and CfwTransport.RESET_CONTEXT != 0)
            inputs.zip(inflateRecords(records)).forEach { (a, b) -> assertContentEquals(a, b) }
            transport.close()
            transport.close()
            val reopened = record(transport.encode(text, 10, 1, 512))
            assertTrue(reopened[0].toInt() and CfwTransport.RESET_CONTEXT != 0)
            assertContentEquals(text, inflateRecords(listOf(reopened)).single())
        } finally {
            transport.close()
        }
    }

    @Test
    fun incompressibleMaximumFallsBackWithoutPoisoningHistory() {
        val transport = CfwTransport(testPlatform())
        try {
            val data = Random(42).nextBytes(65535)
            val raw = record(transport.encode(data, 255, 3, 517))
            assertEquals(3 or CfwTransport.RESET_CONTEXT, raw[0].toInt())
            val next = record(transport.encode(data.copyOf(1000), 0, 3, 517))
            assertTrue(next[0].toInt() and CfwTransport.RESET_CONTEXT != 0)
            val decoded = inflateRecords(listOf(raw, next))
            assertContentEquals(data, decoded[0])
            assertContentEquals(data.copyOf(1000), decoded[1])
        } finally {
            transport.close()
        }
    }

    @Test
    fun ackBatchesAndMalformedPackets() {
        for (count in 1..4) {
            val packet = ackPacket(count)
            val acks = assertNotNull(CfwTransport.parseAcks(packet))
            assertEquals(count, acks.size)
            acks.forEachIndexed { i, ack ->
                assertFalse(ack.nack)
                assertEquals(255 - i, ack.streamId)
                assertEquals(0x1234 + i, ack.messageId)
                assertEquals(2, ack.lens)
                assertEquals(0x4567 + i, ack.size)
                assertEquals(0xabcd + i, ack.checksum)
            }
            assertEquals(255, assertNotNull(CfwTransport.parseAck(packet)).streamId)
            // Every bit of the payload (including ACK trailers and CRC) is protected.
            for (i in 8 until packet.size) {
                val corrupt = packet.copyOf()
                corrupt[i] = (corrupt[i].toInt() xor 1).toByte()
                assertNull(CfwTransport.parseAcks(corrupt))
            }
        }
        assertTrue(assertNotNull(CfwTransport.parseAck(ackPacket(1, 3))).nack)
        assertNull(CfwTransport.parseAcks(ackPacket(2, 3)))
        assertNull(CfwTransport.parseAcks(ackPacket(5)))
        assertNull(CfwTransport.parseAcks(ackPacket(1, 2)))
        for (index in listOf(0, 1, 3, 4, 5, 6, 7)) {
            val corrupt = ackPacket(1)
            corrupt[index] = (corrupt[index].toInt() xor 1).toByte()
            assertNull(CfwTransport.parseAcks(corrupt))
        }
        val wrongLens = ackPacket(1)
        wrongLens[12] = 3
        sealAck(wrongLens)
        assertNull(CfwTransport.parseAcks(wrongLens))
        for (size in 0..18) assertNull(CfwTransport.parseAcks(ByteArray(size)))
        assertNull(CfwTransport.parseAcks(null))
    }

    @Test
    fun ackMatchingAndReplay() {
        val input = byteArrayOf(1, 2, 3)
        val message = message(input = input)
        input[0] = 99
        assertContentEquals(byteArrayOf(1, 2, 3), message.message)
        fun ack(
            lens: Int,
            stream: Int = 100,
            nack: Boolean = false,
            size: Int = 3,
            checksum: Int = message.cfwChecksum,
            id: Int = 0,
        ) = CfwTransport.Ack(nack, stream, id, lens, size, checksum)
        assertFalse(message.acceptCfwAck(null))
        assertFalse(message.acceptCfwAck(ack(1, stream = 99)))
        assertFalse(message.acceptCfwAck(ack(1, size = 4)))
        assertFalse(message.acceptCfwAck(ack(1, checksum = 0)))
        assertFalse(message.acceptCfwAck(ack(3)))
        assertFalse(message.acceptCfwAck(ack(1, id = 1)))
        assertEquals(0, message.cfwAckLenses)
        assertFalse(message.acceptCfwAck(ack(1)))
        assertFalse(message.acceptCfwAck(ack(1)))
        assertTrue(message.acceptCfwAck(ack(2)))
        assertFalse(message.acceptCfwAck(ack(1, nack = true, size = 0, checksum = 0)))
        assertFalse(message.acceptCfwAck(ack(2)))
        message.ackDeadlineAtMs = 500
        message.ackPayload = byteArrayOf(1)
        message.prepareCfwReplay(101)
        assertEquals(1, message.cfwRetries)
        assertFalse(message.cfwRetryPending)
        assertEquals(0, message.cfwAckLenses)
        assertEquals(0L, message.ackDeadlineAtMs)
        assertTrue(message.ackPayload.isEmpty())
        assertFalse(message.acceptCfwAck(ack(1)))
        assertFalse(message.acceptCfwAck(ack(1, stream = 101)))
        assertTrue(message.acceptCfwAck(ack(2, stream = 101)))
        var callbacks = 0
        message.onAck = MessageCallback { callbacks++ }
        message.onAck!!.run()
        assertEquals(1, callbacks)
    }

    @Test
    fun evictionWaitsForAllEarlierReplayableCommands() {
        val earlier = message(input = byteArrayOf(19, 0, 0))
        val eviction = message(input = byteArrayOf(22, 1, 0, 0, 0))
        val upload = message(input = byteArrayOf(21, 1, 0))
        assertFalse(CfwMessageWindow.canSend(listOf(earlier), eviction))
        earlier.cfwAckLenses = 3 // Still retained behind an unresolved window head.
        assertFalse(CfwMessageWindow.canSend(listOf(earlier), eviction))
        assertTrue(CfwMessageWindow.canSend(emptyList(), eviction))
        assertTrue(CfwMessageWindow.canSend(listOf(message(sid = 1)), eviction))
        assertTrue(CfwMessageWindow.canSend(listOf(earlier), upload))
        assertTrue(CfwMessageWindow.canSend(listOf(eviction), upload))
    }

    @Test
    fun orderedCompletionAndWholeWindowRecovery() {
        val head = message()
        val tail = message()
        val stock = message(sid = 1)
        val window = listOf(stock, head, tail)
        tail.cfwAckLenses = 3
        assertNull(CfwMessageWindow.acknowledgedHead(window))
        assertTrue(CfwMessageWindow.replayWindow(window, 100).isEmpty())
        head.ackDeadlineAtMs = 100
        assertTrue(CfwMessageWindow.replayWindow(window, 99).isEmpty())
        assertEquals(listOf(head, tail), CfwMessageWindow.replayWindow(window, 100))
        head.cfwAckLenses = 3
        assertSame(head, CfwMessageWindow.acknowledgedHead(window))
        assertTrue(CfwMessageWindow.replayWindow(window, 100).isEmpty())
        tail.cfwRetryPending = true
        assertEquals(listOf(head, tail), CfwMessageWindow.replayWindow(window, 100))
        head.cfwRetryPending = true
        assertNull(CfwMessageWindow.acknowledgedHead(window))
    }

    @Test
    fun magicPoolExhaustionLruAndReleaseRecords() {
        var now = 123L
        val platform =
            object : ProtocolPlatform by testPlatform() {
                override fun elapsedRealtimeMs() = now
            }
        val pool = BleMagicPool(platform)
        assertEquals((100..255).toList(), List(156) { pool.allocate() })
        assertFailsWith<IllegalStateException> { pool.allocate() }
        pool.release(1, 101, "first", "ack")
        pool.release(1, 100, null, null)
        now = 456
        pool.release(2, 101, "other", "timeout") // duplicate release must not allocate twice
        assertEquals(101, pool.allocate())
        assertEquals(100, pool.allocate())
        assertFailsWith<IllegalStateException> { pool.allocate() }
        val first = assertNotNull(pool.getReleaseRecord(1, 101))
        assertEquals(123L, first.releasedAtMs)
        assertEquals("first", first.label)
        assertEquals(456L, assertNotNull(pool.getReleaseRecord(2, 101)).releasedAtMs)
        assertEquals("", assertNotNull(pool.getReleaseRecord(1, 100)).reason)
        for (invalid in listOf(-1, 99, 256)) {
            pool.release(1, invalid, "bad", "bad")
            assertNull(pool.getReleaseRecord(1, invalid))
        }
    }
}

private fun message(sid: Int = CfwTransport.SID, input: ByteArray = byteArrayOf(1, 2, 3)) =
    OutboundMessage("test", "test", sid, 0, 100, input, 500, 0, false)

private fun ackPacket(count: Int, kind: Int = 1): ByteArray {
    val packet = ByteArray(19 + (count - 1) * 7)
    packet[0] = 0xaa.toByte()
    packet[1] = 0x12
    packet[3] = (packet.size - 8).toByte()
    packet[4] = 1
    packet[5] = 1
    packet[6] = 0xf0.toByte()
    packet[8] = kind.toByte()
    packet[12] = 2
    fun put16(offset: Int, value: Int) {
        packet[offset] = value.toByte()
        packet[offset + 1] = (value ushr 8).toByte()
    }
    for (i in 0 until count) {
        val offset = if (i == 0) 9 else 17 + (i - 1) * 7
        packet[offset] = (255 - i).toByte()
        put16(offset + 1, 0x1234 + i)
        put16(offset + (if (i == 0) 4 else 3), 0x4567 + i)
        put16(offset + (if (i == 0) 6 else 5), 0xabcd + i)
    }
    sealAck(packet)
    return packet
}

private fun sealAck(packet: ByteArray) {
    val crc = CfwTransport.crc(packet.copyOfRange(8, packet.size - 2))
    packet[packet.size - 2] = crc.toByte()
    packet[packet.size - 1] = (crc ushr 8).toByte()
}
