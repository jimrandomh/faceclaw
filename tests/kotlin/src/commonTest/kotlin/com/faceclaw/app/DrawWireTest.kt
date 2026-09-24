package com.faceclaw.app

import kotlin.test.*

class DrawWireTest {
    private fun hex(value: String) = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    @Test fun encodersUseRevision28CoordinatesAndPreserveOtherWireBytes() {
        // Literal vectors pin the firmware grammar independently of the reader.
        val calls = listOf(
            DrawProtocol.image(0x1234, -32768, 32767, 0x1f, target = 511, depth = -128) to
                "0403ff018034120080ff7f1f",
            DrawProtocol.rectCopy(DrawProtocol.CURRENT, 1, 2, 3, 4, -5, -6) to
                "0200feff0100020003000400fbfffaff",
            DrawProtocol.stockText(-1, 2, 15, hex("41c3a9")) to "0300ffff02000f0341c3a9",
            DrawProtocol.text(511, -2, 3, 31, hex("01417f")) to "0500ff01feff03001f0301417f",
            DrawProtocol.playList(511, depth = 127) to "07027fff01",
            DrawProtocol.roundedRect(-1, 2, 640, 480, 65535, 15, 16) to
                "08007f028002e001ffff0f10",
            DrawProtocol.lut(640, 480, 256) to "0600000000008002e0010123456789abcdef",
            DrawProtocol.bbox(hex("ffffffffffffffff"), 4, 0, 0, 8, 2) to "010000000002010f10",
            DrawProtocol.bbox(hex("0f"), 1, 1, 0, 1, 1) to "01000101000000010001001f",
            DrawProtocol.clear(15, target = 511) to "0901ff010f",
        )
        for ((call, expected) in calls) assertContentEquals(hex(expected), call)
        assertContentEquals(hex("0100050007027fff01"), DrawProtocol.sequence(listOf(calls[4].first)))
        assertContentEquals(hex("1a0100050007027fff01"), DrawProtocol.message(listOf(calls[4].first)))
        assertContentEquals(hex("020100050007027fff01"), DrawProtocol.displayList(listOf(calls[4].first)))
        assertContentEquals(hex("1bffff"), DrawProtocol.root(DrawProtocol.SCREEN))
        val flat = DrawProtocol.screenCopy(640, 352)
        assertEquals(1, flat.size)
        assertContentEquals(hex("0200ffff000000008002600100000000"), flat[0])
        val shifted = DrawProtocol.screenCopy(640, 352, -32)
        assertEquals(2, shifted.size)
        assertContentEquals(hex("090000"), shifted[0])
        assertContentEquals(hex("0202e0ffff000000008002600100000000"), shifted[1])
    }

    @Test fun optimizerFieldsAreReencodedAndOpaqueBytesArePreserved() {
        val records = listOf(
            "1300020080ff7f1f" to "040000020080ff7f1f",
            "14ff01ffff02000f0341017f" to "0500ff01ffff02000f0341017f",
            "0fffff02001f0341c3a9" to "0300ffff02001f0341c3a9",
            "030001020134120f10" to "010000000102010f10",
            "060f10" to "01000100000000080002000f10",
            "090100020003000400fbfffaff" to "0200feff0100020003000400fbfffaff",
        )
        for ((record, expected) in records) {
            val calls = DrawProtocol.fromOptimized(hex(record), 8, 2)
            assertEquals(1, calls.size)
            assertContentEquals(hex(expected), calls.single(), record)
        }
        val nested = hex("0802") + records.take(2).fold(byteArrayOf()) { bytes, (record, _) ->
            val payload = hex(record)
            bytes + DrawProtocol.word(payload.size) + payload
        }
        val calls = DrawProtocol.fromOptimized(nested)
        assertEquals(2, calls.size)
        for (i in calls.indices) assertContentEquals(hex(records[i].second), calls[i])
        assertFails { DrawProtocol.fromOptimized(hex("1300020080ff7f")) }
        assertFails { DrawProtocol.fromOptimized(hex("1300020080ff7f1f00")) }
        assertFails { DrawProtocol.fromOptimized(hex("0fffff02001f0441c3a9")) }
    }

    @Test fun everyTruncatedOrOverlongCallIsRejectedBeforeMutation() {
        val font = ByteArray(197)
        font[0] = 1
        font[67] = 193.toByte() // Glyph A.
        hex("0801011f").copyInto(font, 193)
        val resources = mapOf(
            1 to hex("0401000100f0"),
            2 to font,
            3 to DrawProtocol.displayList(emptyList()),
        )
        val renderer = DisplayListRenderer(resources, builtin = { _, _ ->
            DisplayListRenderer.BuiltinGlyph(hex("0801011f"), 1)
        })
        val calls = listOf(
            DrawProtocol.image(1, 0, 0, target = 1, depth = -1),
            DrawProtocol.rectCopy(DrawProtocol.CURRENT, 0, 0, 2, 2, 1, 1),
            DrawProtocol.stockText(0, 0, 15, hex("41")),
            DrawProtocol.text(2, 0, 0, 15, hex("41")),
            DrawProtocol.playList(3),
            DrawProtocol.roundedRect(0, 0, 4, 4, 1, 15),
            DrawProtocol.lut(8, 4, 128),
            DrawProtocol.bbox(ByteArray(16) { -1 }, 4, 0, 0, 8, 4),
        )
        val screen = ByteArray(16) { 0x12 }
        val target = DisplayListRenderer.Target(screen, 8, 4)
        val valid = DrawProtocol.roundedRect(0, 0, 4, 4, 0, 15)
        for (call in calls) {
            // Establish that each fixture is valid before testing malformed forms.
            renderer.execute(DrawProtocol.sequence(listOf(call)), target)
            screen.fill(0x12)
            val savedResources = resources.mapValues { it.value.copyOf() }
            val malformed = (0 until call.size).map { call.copyOf(it) } + listOf(call + byteArrayOf(0))
            for (bad in malformed) {
                assertFails { renderer.execute(DrawProtocol.sequence(listOf(valid, bad, valid)), target) }
                assertContentEquals(ByteArray(16) { 0x12 }, screen)
                for ((id, bytes) in savedResources) assertContentEquals(bytes, resources[id])
            }
        }
        val sequence = DrawProtocol.sequence(listOf(valid))
        for (length in 0 until sequence.size) {
            assertFails { renderer.execute(sequence.copyOf(length), target) }
            assertContentEquals(ByteArray(16) { 0x12 }, screen)
        }
        assertFails { renderer.execute(sequence + byteArrayOf(0), target) }
        assertContentEquals(ByteArray(16) { 0x12 }, screen)
    }

    @Test fun batchesRespectEncodedLengthsAndCallBudget() {
        val call = DrawProtocol.playList(511)
        val messages = DrawProtocol.messages(List(3) { call }, maxBytes = 15)
        assertEquals(listOf(15, 9), messages.map { it.size })
        assertContentEquals(hex("1a020004000700ff0104000700ff01"), messages[0])
        assertFails { DrawProtocol.messages(listOf(call), maxBytes = 8) }
        val many = DrawProtocol.messages(List(4097) { call })
        assertEquals(listOf(4096, 1), many.map { DrawProtocol.u16(it, 1) })
        assertTrue(DrawProtocol.messages(emptyList()).isEmpty())
    }

    @Test fun resourceReaderViewsUseRelativeOffsetsAndCannotEscapeTheirBounds() {
        val reader = ArrayByteReader(hex("ff123456ee"), 1, 4)
        assertEquals(0x12.toByte(), reader.get(0))
        assertEquals(0x3412.toShort(), reader.getShort())
        assertEquals(1, reader.remaining())
        assertFails { reader.get(ByteArray(2)) }
        assertEquals(0x56.toByte(), reader.get())
        assertEquals(0, reader.remaining())
        assertFails { reader.get() }
        assertFails { reader.get(3) }
        assertFails { reader.get(-1) }
        assertFails { ArrayByteReader(byteArrayOf(1), 1, 2) }
    }
}
