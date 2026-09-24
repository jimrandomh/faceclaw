package com.faceclaw.app

import kotlin.test.*

class FrameDisplayListTest {
    // Golden records emitted by display-list-authoring.test.cjs.
    private val menu = "077e0000000300020002000200022a00000096000000010002000200ffffffff0200080000ff24017e30020000000001812c8001812c1611010017328001812c16103001812c3023414031ff24017c30020000000001812c8001812c1611010017328001812c16103001812c302341403102000200010001030400000000000000001f"
    private val multi = "0744000000030002000400010002000000000000000002000200010000ff010001006003000400000000000000001f0200000100000001000100020002feffffff7f00010001007f00"
    private val scroll = "078a000000030002000400020000070000009600000001000200040011223344556677880200020000000000ff250100300102300180f0800180f0161101001732800180f01610300180f0302341403101001102000200010008000000ff280101300100300180f0800180f0161101001732800180f01610300180f030234140310100170100160400020000000103"
    private fun hex(s: String) = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private fun read(bytes: ByteArray, now: Long = 1150): FrameDisplayList {
        val reader = ArrayByteReader(bytes)
        assertEquals(DrawRecordKind.DISPLAY_LIST, reader.get().toInt())
        return FrameDisplayList.read(reader, now).also { assertEquals(0, reader.remaining()) }
    }

    @Test fun authoredExpressionsRebindOnPresentAndTranslateWithTheSurface() {
        val row = read(hex(menu)).translated(10, 10)
        assertEquals(1, row.resources.size)
        fun coordinates(now: Long, elapsed: Long): Triple<Int, Int, Boolean> {
            val call = DrawReader(row.calls(intArrayOf(7), now).first())
            assertEquals(DRAW_OP_ROUNDED_RECT, call.readU8())
            assertEquals(DRAW_FLAG_DEPTH, call.readU8())
            assertEquals(2, call.readS8())
            val frame = DrawEvaluation(elapsed)
            val x = ExtendedVarint.evaluate(call, frame)
            val y = ExtendedVarint.evaluate(call, frame)
            return Triple(x, y, frame.animationPending)
        }
        assertEquals(Triple(12, 10, true), coordinates(1150, 0))
        assertEquals(Triple(13, 12, false), coordinates(1150, 150))
        assertEquals(coordinates(1150, 75), coordinates(1225, 0), "another PRESENT preserves progress")
        assertEquals(Triple(13, 12, false), coordinates(1400, 0))
        val later = hex(menu).also { it[18] = 200.toByte() } // envelope 5 + elapsed offset 13
        assertEquals(read(hex(menu)).fingerprint, read(later).fingerprint)
        val other = hex(menu).also { it[14] = 43 } // timeline token
        assertNotEquals(read(hex(menu)).fingerprint, read(other).fingerprint)
    }

    @Test fun animatedCopySourcesRebindOnPresentAndDestinationsTranslate() {
        // Emitted by menu-scroll-animation.test.cjs: a menu strip scrolling from row 0 to row 2.
        val list = read(hex(scroll)).translated(10, 10)
        fun copy(elapsed: Long): List<Int> {
            val call = DrawReader(list.calls(intArrayOf(5), 1150).first())
            assertEquals(DRAW_OP_RECT_COPY, call.readU8())
            assertEquals(DRAW_FLAG_DEPTH, call.readU8())
            assertEquals(0, call.readS8())
            val frame = DrawEvaluation(elapsed)
            val values = listOf(call.readU16(), ExtendedVarint.evaluate(call, frame), ExtendedVarint.evaluate(call, frame),
                call.readU16(), call.readU16(), ExtendedVarint.evaluate(call, frame), ExtendedVarint.evaluate(call, frame))
            call.requireDone()
            return values + if (frame.animationPending) 1 else 0
        }
        // 150 of 240 ms elapsed before this PRESENT; the source row is not translated with the surface.
        assertEquals(listOf(5, 0, 1, 2, 2, 14, 12, 1), copy(0))
        assertEquals(listOf(5, 0, 2, 2, 2, 14, 12, 0), copy(90))
    }

    @Test fun localResourceIdsAreResolvedAndScreenCopiesStayAtScreenDepth() {
        val list = read(hex(multi)).translated(10, 10)
        val calls = list.calls(intArrayOf(41, 42), 1150)
        assertContentEquals(DrawProtocol.image(41, 13, 12, 31, depth = 2), calls[0])
        assertContentEquals(DrawProtocol.rectCopy(42, 0, 0, 1, 1, 15, 12, depth = 2), calls[1])
        assertContentEquals(DrawProtocol.rectCopy(DrawProtocol.SCREEN, 12, 12, 1, 1, 12, 12, depth = 0), calls[2])
        val scene = ShellScene(emptyList(), listOf(read(hex(multi))))
        assertEquals(2, scene.retainedResources.size)
        for (right in listOf(false, true)) {
            val pixels = scene.preview(ByteArray(64) { 32 }, 8, 8, right)
            assertEquals(240, pixels[16 + if (right) 3 else 5].toInt() and 255)
            assertEquals(96, pixels[16 + if (right) 4 else 6].toInt() and 255)
            assertEquals(32, pixels[18].toInt() and 255)
        }
        val cache = ResourceCacheState()
        val planner = ScenePlanner(cache)
        val screen = ByteArray(32) { 0x22 }
        planner.plan(screen, 8, 8, null, scene, 1)
        val ids = scene.retainedResources.map { cache.resourceId(it) }
        assertTrue(ids.all { it >= 0 }); assertNotEquals(ids[0], ids[1])
        planner.plan(screen, 8, 8, null, scene, 1)
        assertEquals(ids, scene.retainedResources.map { cache.resourceId(it) })
    }

    @Test fun frameAndShellSubmissionUseTheSameGenericDecoder() {
        val c = SurfaceCompositor()
        c.configureScreen(8, 8)
        c.configureSurface("app", 0, 0, 8, 8, 0, 0)
        c.submitSurface("app", ArrayByteReader(ByteArray(64) { 32 }), 0, 0, 8, 8, "list",
            ArrayByteReader(hex(multi)))
        val frame = c.composite()
        assertEquals(2, frame.shellScene.retainedResources.size)
        assertEquals(240, frame.gray[21].toInt() and 255)
        assertTrue(frame.screenGray.all { it.toInt() == 32 })
        // One opaque 1x1 shell layer, with one generic list after its pixels.
        val layer = DrawProtocol.word(1) + DrawProtocol.word(1) + DrawProtocol.word(0) + DrawProtocol.word(0) +
            DrawProtocol.word(1) + DrawProtocol.word(1) + DrawProtocol.word(256) + DrawProtocol.word(1) +
            DrawProtocol.word(0) + byteArrayOf(32) + hex(multi)
        val shell = ShellScene.decode(ArrayByteReader(layer))
        assertEquals(2, shell.retainedResources.size)
        assertEquals(240, shell.preview(ByteArray(64) { 32 }, 8, 8)[21].toInt() and 255)
    }

    @Test fun rejectsTruncationBadResourcesAndTrailingData() {
        val bytes = hex(multi)
        for (end in 1 until bytes.size) assertFails { read(bytes.copyOf(end)) }
        assertFails { read(bytes.copyOf().also { it[40] = 9 }) } // first image's local resource
        val trailing = bytes + byteArrayOf(0)
        trailing[1] = (trailing[1] + 1).toByte()
        assertFails { read(trailing) }
    }
}
