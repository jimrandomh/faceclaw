package com.faceclaw.app

import kotlin.test.*

class FrameDisplayListTest {
    // Golden records emitted by display-list-authoring.test.cjs.
    private val menu = "077f0000000300020002000200022a00000096000000010002000200ffffffff0200080000ff24017e30020000000001812c8001812c1611010017328001812c16103001812c3023414031ff24017c30020000000001812c8001812c1611010017328001812c16103001812c30234140310200020001000103100400000000000000001f"
    private val multi = "0744000000030002000400010002000000000000000002000200010000ff010001006003000400000000000000001f0200000100000001000100020002feffffff7f00010001007f00"
    private val scroll = "078b000000030002000400020000070000009600000001000200040011223344556677880200020000000000ff250100300102300180f0800180f0161101001732800180f01610300180f0302341403101001102000200010008000000ff280101300100300180f0800180f0161101001732800180f01610300180f03023414031010017010016040002000000010310"
    // Clipped clear, clipped rounded rect, and replayed glyph + icon records with
    // placeholder atlas ids 0xbeef / 0xcafebabe, plus what they paint over a
    // nibble-1 16x8 screen (display-list-authoring.test.cjs).
    private val replay = "078100000002000300080004000007000000640000000000030089000000000000060004000288000001000100020002000000040003000000051010a00000000000000600040000ff2502000080c002000000000180c8800180c8161101001732800180c81610300180c830234031020000efbe4100000000000000ff01bebafeca04000100"
    private val replayPixels = "11111111111111111111111111111111111111111111111111fff28f111111111125522211111111112552221111111111222222111111111111111111111111"
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
        // Recorded from a since-removed menu-scroll-animation.test.cjs case (240ms slides):
        // a menu strip scrolling from row 0 to row 2.
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
            DrawProtocol.word(0) + byteArrayOf(32) + hex(multi) + DrawProtocol.word(0) + DrawProtocol.word(1)
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

    /** The TS golden's placeholder ids, replaced by ids registered in this process. */
    private fun registeredReplay(imageKnown: Boolean = true): ByteArray {
        val key = "stub-font".encodeToByteArray()
        val glyph = byteArrayOf(key.size.toByte()) + key + byteArrayOf(4, 1, 0, 65, 0, 0, 0, 0, 1, 3, 2) +
            byteArrayOf(0xa0.toByte(), 0, 0, 0, 0xe0.toByte(), 0, 0, 0)
        GlyphAtlas.register(ArrayByteReader(glyph))
        val fontId = GlyphAtlas.fontId("stub-font")
        val imageId = if (imageKnown) ImageAtlas.ensure("stub-replay-icon", 2, 2,
            ArrayByteReader(byteArrayOf(255.toByte(), 0, 128.toByte(), 255.toByte()))) else 0x7fffffff
        fun le(value: Int, bytes: Int) = (0 until bytes).joinToString("") { ((value ushr (8 * it)) and 255).toString(16).padStart(2, '0') }
        return hex(replay.replace("efbe", le(fontId, 2)).replace("bebafeca", le(imageId, 4)))
    }

    @Test fun replayedDrawsCompileToClippedImageAndTextCallsThatPaintLikeTheSoftwareRenderer() {
        val list = read(registeredReplay(), 1100)
        assertEquals(2, list.resources.size, "the icon and a font snapshot")
        val ids = intArrayOf(1, 2)
        val calls = list.calls(ids, 1100)
        assertEquals(listOf(DRAW_OP_CLEAR, DRAW_OP_ROUNDED_RECT, DRAW_OP_IMAGE, DRAW_OP_TEXT), calls.map { it[0].toInt() })
        assertTrue(calls.all { it[1].toInt() and DRAW_FLAG_CLIP != 0 })
        val resources = list.resources.withIndex().associate { (i, resource) -> ids[i] to resource.bytes }
        val screen = ByteArray(64) { 0x11 }
        val target = DisplayListRenderer.Target(screen, 16, 8)
        DisplayListRenderer(resources).execute(DrawProtocol.sequence(calls), target)
        val nibbles = (0 until 128).joinToString("") { target.get(it % 16, it / 16).toString(16) }
        assertEquals(replayPixels, nibbles)
    }

    // A window-frame rounded rect (display-list-authoring.test.cjs): no fill, a
    // border of 3, black outside the curve (revision 36), clipped short of its
    // bottom row, over a nibble-9 12x8 screen.
    private val frame = "072b00000002000100080006000000000000000000000000010088000000000000080005000000080006000300000300"
    private val framePixels = "999999999999990333333099993399993399993999999399993999999399993399993399999999999999999999999999"

    @Test fun roundedRectOutsideColorBridgesToTheTrailingByteAndPaintsLikeTheSoftwareRenderer() {
        val call = read(hex(frame)).calls(IntArray(0), 0).single()
        val plain = DrawProtocol.roundedRect(DrawValue.Integer(2), DrawValue.Integer(1), 8, 6, 3, 0, 3,
            depth = 0, clip = DrawClip(2, 1, 8, 5))
        assertContentEquals(plain + byteArrayOf(0), call)
        val target = DisplayListRenderer.Target(ByteArray(48) { 0x99.toByte() }, 12, 8)
        DisplayListRenderer(emptyMap()).execute(DrawProtocol.sequence(listOf(call)), target)
        assertEquals(framePixels, (0 until 96).joinToString("") { target.get(it % 12, it / 12).toString(16) })
        // Without the trailing byte the corners keep what was there; a color past 15 is rejected.
        val corners = DisplayListRenderer.Target(ByteArray(48) { 0x99.toByte() }, 12, 8)
        DisplayListRenderer(emptyMap()).execute(DrawProtocol.sequence(listOf(plain)), corners)
        assertEquals(9, corners.get(2, 1)); assertEquals(3, corners.get(5, 1))
        assertFails { DisplayListRenderer(emptyMap()).execute(DrawProtocol.sequence(listOf(plain + byteArrayOf(16))), corners) }
        assertFails { DrawProtocol.roundedRect(DrawValue.Integer(0), DrawValue.Integer(0), 8, 6, 3, 0, 3, outside = 16) }
    }

    @Test fun replayWithAnUnknownRecordDrawsNothing() {
        val list = read(registeredReplay(imageKnown = false), 1100)
        assertTrue(list.resources.isEmpty())
        assertTrue(list.calls(IntArray(0), 1100).isEmpty())
    }
}
