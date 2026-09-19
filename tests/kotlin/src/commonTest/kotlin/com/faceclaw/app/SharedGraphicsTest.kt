package com.faceclaw.app

import kotlin.test.*

class SharedGraphicsTest {
    private fun hex(value: String) = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    @Test
    fun androidWireVectorsAndGrayQuantization() {
        val vectors =
            listOf(
                BleProtocol.buildAuthenticationRequest(101) to "080410651a0408011004",
                BleProtocol.PRELUDE_F5872_PAYLOAD to "0802109c01220a1a081206120408001000",
                BleProtocol.buildCreateInputPage(102) to
                    "080010661a2308011a1c0800100018c00420a0024801520964617368626f617264580162012028904e",
                BleProtocol.buildHeartbeat(103) to "080c106772020800",
                BleProtocol.buildSettingsQuery(104) to "0802106822020801",
                BleProtocol.buildShutdown(105, 1) to "080910695a020801",
                BleProtocol.buildFaceclawWakeControl(5, 0) to "08011000aa0606464301050000",
            )
        vectors.forEach { (actual, expected) -> assertContentEquals(hex(expected), actual) }
        val packed =
            BmpUtil.pack4bppFromGray8(
                byteArrayOf(0, 1, 7, 8, 15, 16, 23, 24, 127, -128, -9, -1),
                3,
                4,
            )
        assertContentEquals(hex("0000111012808ff0"), packed)
        assertContentEquals(hex("40311011121810182f10"), BleImageOptimizer.rleEncode(packed))
        assertContentEquals(
            hex("aa21400c01018000080410651a04080110041024"),
            BleProtocol.framePb(vectors.first().first, 128, 0, 64).single(),
        )
    }

    @Test
    fun splitStreamsExpiryAndCorruption() {
        val payload =
            BleProtocol.encodeVarintField(1, 3) +
                BleProtocol.encodeVarintField(2, 110) +
                BleProtocol.encodeBytesField(8, ByteArray(3900) { 55 })
        val frames = BleProtocol.framePb(payload, 224, 32, 17, 185)
        assertTrue(frames.all { it.size <= 185 })
        val stream = frames.reduce { a, b -> a + b }
        val receiver = MessageReceiver()
        assertTrue(receiver.receive("L", stream.copyOf(7), 0).isEmpty())
        val message = receiver.receive("L", stream.copyOfRange(7, stream.size), 1).single()
        assertContentEquals(payload, message.payload)
        assertEquals(3, message.command)
        assertEquals(110, message.magic)
        stream[stream.lastIndex] = (stream.last().toInt() xor 1).toByte()
        assertTrue(receiver.receive("L", stream, 2).isEmpty())
        receiver.receive("L", frames.first(), 10)
        assertTrue(receiver.receive("R", frames.drop(1).reduce { a, b -> a + b }, 11).isEmpty())
        assertTrue(receiver.receive("L", frames.drop(1).reduce { a, b -> a + b }, 5011).isEmpty())
        assertFailsWith<IllegalArgumentException> { BleProtocol.framePb(payload, 1, 0, 1, 10) }
        assertFailsWith<IllegalArgumentException> { BleProtocol.framePb(ByteArray(60000), 1, 0, 1) }
        val invalid = BleProtocol.framePb(byteArrayOf(0x1a, 0x7f), 224, 0, 2).single()
        assertTrue(receiver.receive("L", invalid, 6000).isEmpty())
    }

    @Test
    fun eventDecodeAcceptsValidatedPayloadWithoutStrippingAgain() {
        val event = BleProtocol.encodeVarintField(1, 12) + BleProtocol.encodeVarintField(2, 2)
        val payload = BleProtocol.encodeBytesField(13, BleProtocol.encodeBytesField(3, event))
        val received =
            MessageReceiver()
                .receive("L", BleProtocol.framePb(payload, 224, 1, 1).single(), 0)
                .single()
        val decoded = assertNotNull(G2Event.decodePayload(received.sid, received.payload))
        assertEquals("sys-event", decoded.kind)
        assertEquals(12, decoded.eventType)
        assertEquals(2, decoded.eventSource)
    }

    @Test
    fun retainedCompositionClippingDimmingAndBlanking() {
        val c = SurfaceCompositor()
        c.configureScreen(3, 2)
        c.configureSurface("app", 0, 0, 3, 2, 0, 0)
        c.submitSurface("app", ArrayByteReader(ByteArray(6) { 200.toByte() }), 0, 0, 3, 2, "1")
        c.configureSurface("shell", 0, 0, 3, 2, 1, 1)
        c.submitSurface("shell", ArrayByteReader(byteArrayOf(0, 1, -1, 0, 0, 0)), 0, 0, 3, 2, "2")
        c.setUnderlayDim(1, 128)
        assertContentEquals(byteArrayOf(100, 1, -1, 100, 100, 100), c.composite().gray)
        c.setSurfaceVisible("shell", false)
        assertContentEquals(ByteArray(6) { 100 }, c.composite().gray)
        c.configureSurface("opaque", 1, 0, 1, 2, 2, 0)
        c.submitSurface("opaque", ArrayByteReader(byteArrayOf(0, 0)), 0, 0, 1, 2, "3")
        assertContentEquals(byteArrayOf(100, 0, 100, 100, 0, 100), c.composite().gray)
        c.setBlanked(true)
        assertContentEquals(ByteArray(6), c.composite().gray)
        c.setBlanked(false)
        c.removeSurface("opaque")
        c.configureSurface("app", -1, 0, 3, 2, 0, 0)
        c.setUnderlayDim(0, 256)
        assertContentEquals(byteArrayOf(-56, -56, 0, -56, -56, 0), c.composite().gray)
    }

    @Test
    fun pngChunksAndPixels() {
        val png = SharedScreenshots.encode4BitGrayPng(byteArrayOf(0, 16, -1, 32, 48, 64), 3, 2)
        assertContentEquals(hex("89504e470d0a1a0a"), png.copyOf(8))
        fun intAt(offset: Int): Int =
            (0..3).fold(0) { n, i -> (n shl 8) or (png[offset + i].toInt() and 255) }
        var offset = 8
        val types = mutableListOf<String>()
        var compressed = ByteArray(0)
        while (offset < png.size) {
            val size = intAt(offset)
            val type = png.copyOfRange(offset + 4, offset + 8).decodeToString()
            types.add(type)
            if (type == "IHDR") {
                assertEquals(3, intAt(offset + 8))
                assertEquals(2, intAt(offset + 12))
                assertEquals(4, png[offset + 16].toInt())
                assertEquals(0, png[offset + 17].toInt())
            }
            if (type == "IDAT") compressed += png.copyOfRange(offset + 8, offset + 8 + size)
            offset += size + 12
        }
        assertEquals(listOf("IHDR", "IDAT", "IEND"), types)
        assertContentEquals(hex("0001f0002340"), inflateData(compressed, 6))
    }

    @Test
    fun wavHeaderAndHex() {
        assertEquals("007f80ff", BinaryEncoding.bytesToHex(byteArrayOf(0, 127, -128, -1)))
        assertContentEquals(
            hex(
                "524946462804000057415645666d74201000000001000100803e0000007d0000020010006461746104040000"
            ),
            BinaryEncoding.wavHeader(1028, 16000, 1),
        )
    }
}
