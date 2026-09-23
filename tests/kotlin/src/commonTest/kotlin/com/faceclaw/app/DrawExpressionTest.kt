package com.faceclaw.app

import kotlin.test.*

class DrawExpressionTest {
    private fun hex(s: String) = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private fun evaluate(code: ByteArray, elapsed: Long = 0): Pair<Int, Boolean> {
        val frame = DrawEvaluation(elapsed)
        return DrawExpression.evaluate(DrawReader(code), frame) to frame.animationPending
    }

    @Test fun integerWidthsSignExtensionAndReservedPrefixes() {
        val signed = mapOf(
            0 to "00", 63 to "3f", -64 to "40", -1 to "7f", 64 to "8040", -65 to "bfbf",
            8191 to "9fff", -8192 to "a000", 8192 to "c02000", -8193 to "dfdfff",
            1048575 to "cfffff", -1048576 to "d00000", 1048576 to "e0100000",
            -1048577 to "efefffff", 134217727 to "e7ffffff", -134217728 to "e8000000",
            134217728 to "f008000000", Int.MAX_VALUE to "f07fffffff", Int.MIN_VALUE to "f080000000",
        )
        for ((number, bytes) in signed) {
            assertContentEquals(hex(bytes), ExtendedVarint.signed(number))
            assertEquals(number, ExtendedVarint.read(DrawReader(hex(bytes)), true))
        }
        for (value in listOf(0u, 127u, 128u, 16383u, 16384u, 2097151u, 2097152u, 268435455u, 268435456u, UInt.MAX_VALUE)) {
            val bytes = ExtendedVarint.unsigned(value)
            assertEquals(value, ExtendedVarint.read(DrawReader(bytes), false).toUInt())
            for (n in 0 until bytes.size) assertFails { ExtendedVarint.read(DrawReader(bytes.copyOf(n)), false) }
        }
        for (prefix in 0xf1..0xff) assertFails { ExtendedVarint.read(DrawReader(byteArrayOf(prefix.toByte())), true) }
        assertEquals(-1, ExtendedVarint.read(DrawReader(hex("bfff")), true)) // valid non-minimal form
        assertFails { ExtendedVarint.evaluate(DrawReader(hex("ff05")), DrawEvaluation(0)) }
    }

    @Test fun arithmeticTypesStackErrorsAndTimeTracking() {
        val vectors = listOf(
            "0107010510" to 12, "0107010511" to 2, "0107010512" to 35,
            "0179010213" to -3, "0179010214" to -1, "017915" to 7,
            "0107010516" to 5, "0107010517" to 7, "01010109" to 9,
            "01040310" to 8, "010401070504" to 7,
            "010430010230202431" to -6,
            "020000c03f02000000402231" to 3,
            "01003001806430020000003f4031" to 50,
            "01f07fffffff010110" to Int.MIN_VALUE,
            "01f080000000017f13" to Int.MIN_VALUE,
            "01f080000000017f14" to 0,
        )
        for ((code, expected) in vectors) assertEquals(expected to false, evaluate(hex(code)), code)
        for (bad in listOf("", "10", "0101010013", "010130010110", "020000807f", "ff", "0180", "01013210")) {
            assertEquals(0 to false, evaluate(hex(bad)), bad)
        }
        assertEquals(0 to false, evaluate(ByteArray(66) { if (it % 2 == 0) 1 else 0 })) // stack overflow
        assertEquals(0 to false, evaluate(ByteArray(1025)))
        for (op in DrawExpression.SMOOTHSTEP..DrawExpression.EASE_IN_OUT_CUBIC) {
            assertEquals(0 to false, evaluate(hex("0200000000") + byteArrayOf(op.toByte(), 49)))
            assertEquals(1 to false, evaluate(hex("020000803f") + byteArrayOf(op.toByte(), 49)))
        }
        assertEquals(499 to true, evaluate(hex("0181f432"), 499))
        assertEquals(500 to false, evaluate(hex("0181f432"), 500))
        assertEquals(500 to false, evaluate(hex("0181f432"), 900))
        assertEquals(0 to false, evaluate(hex("0181f432ff"), 250)) // errors discard pending time
    }

    @Test fun smoothstepCoordinatesMatchFirmwareAndSurvivePresentTimeReset() {
        val value = DrawValue.animate(10, 110, 500) as DrawValue.Expression
        val code = "010a3001806e300181f432010010300181f43023414031"
        assertContentEquals(hex(code), value.program)
        for ((time, expected) in listOf(0L to 10, 125L to 25, 250L to 60, 375L to 94, 500L to 110, 900L to 110)) {
            assertEquals(expected to (time < 500), evaluate(value.program, time))
        }
        val continued = DrawValue.animate(10, 110, 500, elapsedMs = 250) as DrawValue.Expression
        assertEquals(60 to true, evaluate(continued.program, 0))
        assertEquals(110 to false, evaluate(continued.program, 250))
    }

    @Test fun animatedMenuBridgePreservesElapsedTimeAndTranslation() {
        // Tag 6 record emitted by the TypeScript bridge: elapsed=200, delta=(-2,-4), duration=300.
        val wire = hex("06030002000200020001001030020000fefffcffc8002a0000002c01ffffffff")
        val input = ArrayByteReader(wire)
        assertEquals(6, input.get().toInt())
        val row = MenuSelection.read(input, DrawRecordKind.ANIMATED_MENU_SELECTION).translated(10, 10)
        assertEquals(0, input.remaining())
        val motion = assertNotNull(row.animation)
        assertEquals(42, motion.token)
        assertEquals(300, motion.durationMs)
        assertEquals(-2, motion.dx)
        assertEquals(-4, motion.dy)
        val call = row.calls(7, motion.startedAt + 200).first()
        for ((elapsed, expected) in listOf(0L to (12 to 10), 100L to (13 to 12))) {
            val reader = DrawReader(call)
            assertEquals(8, reader.readU8())
            assertEquals(DRAW_FLAG_DEPTH, reader.readU8())
            assertEquals(2, reader.readS8())
            val frame = DrawEvaluation(elapsed)
            assertEquals(expected.first, ExtendedVarint.evaluate(reader, frame))
            assertEquals(expected.second, ExtendedVarint.evaluate(reader, frame))
            assertEquals(elapsed < 100, frame.animationPending)
        }
        for (end in 1 until wire.size) assertFails {
            MenuSelection.read(ArrayByteReader(wire.copyOf(end), 1), DrawRecordKind.ANIMATED_MENU_SELECTION)
        }
    }

    @Test fun menuCoordinatesUseTheSuppliedDuration() {
        val row = MenuSelection(0, 4, 2, 2, 0, 15, 16, 0, ByteArray(2),
            animation = MenuSelection.Animation(0, -4, 1000, 42, 120))
        val call = row.calls(7, 1000).first()
        for ((elapsed, y) in listOf(0L to 0, 60L to 2, 120L to 4)) {
            val reader = DrawReader(call)
            reader.readBytes(3) // opcode, flags, depth
            val frame = DrawEvaluation(elapsed)
            assertEquals(0, ExtendedVarint.evaluate(reader, frame))
            assertEquals(y, ExtendedVarint.evaluate(reader, frame))
            assertEquals(elapsed < 120, frame.animationPending)
        }
    }

    @Test fun playerSchedulesOnlyUnfinishedFramesAndCancelsStaleCallbacks() {
        val call = DrawProtocol.roundedRect(DrawValue.Integer(0), DrawValue.animate(0, 4, 300), 2, 2, 0, 15)
        val renderer = DisplayListRenderer(mapOf(1 to DrawProtocol.displayList(listOf(call))))
        val screen = DisplayListRenderer.Target(ByteArray(16), 4, 8)
        val output = DisplayListRenderer.Target(ByteArray(16), 4, 8)
        var now = 1000L
        val queued = mutableListOf<() -> Unit>()
        var cancelled = 0
        var displayed = 0
        val player = DisplayListPlayer(renderer, screen, output, { now }, { delay, callback ->
            assertEquals(45, delay)
            queued.add(callback);
            { cancelled++ }
        }, { displayed++ })
        player.present(1)
        assertEquals(15, output.get(0, 0))
        val first = queued.removeAt(0)
        now += 150
        first()
        assertEquals(15, output.get(0, 2))
        assertEquals(0, output.get(0, 0))
        val stale = queued.removeAt(0)
        player.present(1)
        assertEquals(15, output.get(0, 0))
        stale()
        assertEquals(3, displayed)
        now += 300
        queued.removeAt(0)()
        assertEquals(15, output.get(0, 4))
        assertFalse(renderer.animationPending)
        assertTrue(queued.isEmpty())
        player.present(1)
        val stopped = queued.removeAt(0)
        player.stop()
        stopped()
        assertEquals(5, displayed)
        assertTrue(cancelled >= 2)
    }
}
