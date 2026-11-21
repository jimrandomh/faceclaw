package com.faceclaw.app

import kotlin.io.encoding.Base64
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Replays a recording with the reference renderer, the way tools/screen-recording-visualizer
 * does in JavaScript: the starting state, then each message's effect on each lens it went to
 * as that lens acknowledges it. Messages planned before the recording are already in the state.
 */
internal class RecordingReplay(text: String) {
    val records: List<Map<String, Any?>> = text.lines().filter { it.isNotEmpty() }.map { Json.parseObject(it) }

    class Lens(val right: Boolean) {
        val resources = HashMap<Int, ByteArray>()
        var width = 0
        var height = 0
        var screen = ByteArray(0)
        var composition = ByteArray(0)
        var root = DrawProtocol.SCREEN
        var builtin: ((Int, Int) -> DisplayListRenderer.BuiltinGlyph)? = null

        fun size(width: Int, height: Int) {
            if (width == this.width && height == this.height) return
            this.width = width
            this.height = height
            screen = ByteArray((width + 1) / 2 * height)
            composition = ByteArray(screen.size)
        }

        private fun renderer() = DisplayListRenderer(resources, builtin, rightLens = right)

        /** What the glasses show [elapsedMs] after the last PRESENT. */
        fun render(elapsedMs: Long = 0) {
            renderer().render(root, DisplayListRenderer.Target(screen, width, height),
                DisplayListRenderer.Target(composition, width, height), elapsedMs)
        }

        fun apply(b: ByteArray) {
            when (b[0].toInt() and CFW_MSG_TYPE_MASK) {
                CFW_MSG_UPLOAD_RESOURCE -> {
                    var p = 3
                    repeat(DrawProtocol.u16(b, 1)) {
                        val id = DrawProtocol.u16(b, p)
                        val total = DrawProtocol.u16(b, p + 2) or (DrawProtocol.u16(b, p + 4) shl 16)
                        val offset = DrawProtocol.u16(b, p + 6)
                        val n = DrawProtocol.u16(b, p + 8)
                        val existing = resources[id]
                        val bytes = if (existing != null && existing.size == total && offset > 0) existing else ByteArray(total).also { resources[id] = it }
                        b.copyInto(bytes, offset, p + 10, p + 10 + n)
                        p += 10 + n
                    }
                }
                CFW_MSG_EVICT_RESOURCE -> repeat(DrawProtocol.u16(b, 1)) { resources.remove(DrawProtocol.u16(b, 3 + it * 2)) }
                CFW_MSG_CREATE_SURFACE -> repeat(DrawProtocol.u16(b, 1)) {
                    val p = 3 + it * 6
                    resources.getOrPut(DrawProtocol.u16(b, p)) { DrawProtocol.rawImage(DrawProtocol.u16(b, p + 2), DrawProtocol.u16(b, p + 4)) }
                }
                CFW_MSG_DRAW_CALLS -> renderer().execute(b.copyOfRange(1, b.size), DisplayListRenderer.Target(screen, width, height))
                CFW_MSG_SET_ROOT_DISPLAY_LIST -> root = DrawProtocol.u16(b, 1)
                CFW_MSG_PRESENT -> render()
            }
        }
    }

    val lenses = arrayOf(Lens(false), Lens(true))
    val header: Map<String, Any?> get() = records.first()

    fun ofType(type: String) = records.filter { it["type"] == type }

    private fun bytes(value: Any?): ByteArray = Base64.decode(value as String)

    fun run(): RecordingReplay {
        assertEquals("header", header["type"])
        assertEquals(ScreenRecorder.FORMAT, header["format"])
        assertEquals(ScreenRecorder.VERSION, header["version"].asInt())
        val width = header["width"].asInt()!!
        val height = header["height"].asInt()!!
        if (width > 0 && height > 0) for (lens in lenses) lens.size(width, height)
        val payloads = HashMap<Int, ByteArray>()
        val targets = HashMap<Int, Int>()
        val applied = HashSet<Int>()
        val glyphs = HashMap<Int, DisplayListRenderer.BuiltinGlyph>()
        val advances = HashMap<Pair<Int, Int>, Int>()
        val builtin = { cp: Int, next: Int ->
            val glyph = glyphs[cp]
            DisplayListRenderer.BuiltinGlyph(glyph?.image ?: byteArrayOf(0, 1, 1, 0), advances[cp to next] ?: 0, glyph?.x ?: 0, glyph?.y ?: 0)
        }
        for (lens in lenses) lens.builtin = builtin
        for (record in records) when (record["type"]) {
            "state" -> for ((index, lens) in lenses.withIndex()) {
                if (record["lenses"].asInt()!! and (1 shl index) == 0) continue
                lens.size(record["width"].asInt()!!, record["height"].asInt()!!)
                record["screen"]?.let { bytes(it).copyInto(lens.screen) }
                lens.root = record["root"].asInt()!!
                lens.resources.clear()
                for (resource in record["resources"].asArray()!!) {
                    val entry = resource.asObject()!!
                    lens.resources[entry["id"].asInt()!!] = bytes(entry["data"])
                }
                lens.render()
            }
            "stock-font" -> {
                for (entry in record["glyphs"].asArray()!!) {
                    val glyph = entry.asObject()!!
                    val image = byteArrayOf(0, glyph["width"].asInt()!!.toByte(), glyph["height"].asInt()!!.toByte()) + bytes(glyph["pixels"])
                    glyphs[glyph["cp"].asInt()!!] = DisplayListRenderer.BuiltinGlyph(image, 0, glyph["x"].asInt()!!, glyph["y"].asInt()!!)
                }
                for (entry in record["advances"].asArray()!!) {
                    val triple = entry.asArray()!!
                    advances[triple[0].asInt()!! to triple[1].asInt()!!] = triple[2].asInt()!!
                }
            }
            "msg" -> {
                val id = record["id"].asInt()!!
                val payload = record["payload"] ?: continue
                if (record["sid"].asInt() != CfwTransport.SID || record["baseline"] == true) continue
                payloads[id] = bytes(payload)
                targets[id] = record["lenses"].asInt()!!
            }
            "lens-ack" -> {
                val id = record["id"].asInt()!!
                val lens = record["lens"].asInt()!!
                val payload = payloads[id] ?: continue
                if (record["nack"] == true || targets[id]!! and lens == 0 || !applied.add(id * 4 + lens)) continue
                lenses[lens - 1].apply(payload)
            }
        }
        return this
    }

    /** The last phone-side composite in the recording, packed 4bpp. */
    fun lastScreen(): ByteArray = decodeScreen(ofType("screen").last())

    fun decodeScreen(record: Map<String, Any?>): ByteArray {
        val width = record["width"].asInt()!!
        val height = record["height"].asInt()!!
        assertEquals("deflate", record["encoding"])
        return inflateData(bytes(record["pixels"]), (width + 1) / 2 * height)
    }
}

/**
 * Left for scripts/update-screen-recording-fixtures.sh to copy into tests/fixtures, where the
 * visualizer's own tests replay them. Only the JVM run has a build directory to write to.
 */
internal fun writeRecordingFixture(name: String, text: String) {
    try {
        if (fileExists("build")) writeFileData("build/screen-recording-$name", text.encodeToByteArray())
    } catch (_: Throwable) {
    }
}

class ScreenRecorderTest {
    private class FakeClock : ProtocolPlatform by testPlatform() {
        var nowMs = 5_000L
        override fun elapsedRealtimeMs(): Long = nowMs
    }

    private fun recorder(clock: FakeClock, maxBytes: Long = ScreenRecorder.MAX_BYTES) =
        ScreenRecorder(clock, { 1_700_000_000_000L + clock.nowMs }, maxBytes, { "wall@$it" })

    private fun cfw(payload: ByteArray, kind: String = "resources") =
        OutboundMessage(kind, "$kind ${payload.size}B", CfwTransport.SID, 0, 17, payload, 3000, -1, true)

    @Test
    fun recordsAreJsonLinesWithTheHeaderFirst() {
        val clock = FakeClock()
        val recorder = recorder(clock)
        assertEquals("", recorder.encodeToString())
        recorder.log(1, "I", "before begin is dropped")
        recorder.begin("g2", 640, 480)
        clock.nowMs += 3
        recorder.log(clock.nowMs, "W", "a \"quoted\"\nline")
        val message = cfw(byteArrayOf(28), "image")
        message.frameId = 9
        message.setImageUpdatePosition(4, 1, 1)
        recorder.messageWriting(clock.nowMs, message, listOf(ByteArray(20), ByteArray(7)))
        recorder.messageWritten(clock.nowMs + 2, message, true)
        recorder.lensAck(clock.nowMs + 40, message, 1, false)
        recorder.lensAck(clock.nowMs + 45, message, 2, true)
        recorder.messageTimedOut(clock.nowMs + 50, message)
        message.prepareCfwReplay(18)
        recorder.messageWriting(clock.nowMs + 60, message, listOf(ByteArray(20)))
        recorder.messageAcked(clock.nowMs + 90, message)
        recorder.end()
        recorder.log(clock.nowMs, "I", "after end is dropped")
        val id = message.traceId
        assertEquals("""
            |{"type":"header","t":5000,"format":"faceclaw-screen-recording","version":1,"wallClockMs":1700000005000,"localTime":"wall@1700000005000","glasses":"g2","width":640,"height":480}
            |{"type":"log","t":5003,"level":"W","text":"a \"quoted\"\nline"}
            |{"type":"msg","t":5003,"id":$id,"attempt":1,"kind":"image","label":"image 1B","sid":240,"magic":17,"arm":"L","lenses":3,"frame":9,"update":4,"part":1,"parts":1,"wire":[20,7],"payload":"HA=="}
            |{"type":"sent","t":5005,"id":$id,"attempt":1,"ok":true}
            |{"type":"lens-ack","t":5043,"id":$id,"lens":1}
            |{"type":"lens-ack","t":5048,"id":$id,"lens":2,"nack":true}
            |{"type":"timeout","t":5053,"id":$id}
            |{"type":"msg","t":5063,"id":$id,"attempt":2,"magic":18,"wire":[20]}
            |{"type":"ack","t":5093,"id":$id}
            |{"type":"end","t":5003,"truncated":false}
            |""".trimMargin(), recorder.encodeToString())
        // Every line is JSON on its own, and payloads are standard base64 at each padding length.
        for (size in 0..4) {
            val bytes = ByteArray(size) { (250 + it).toByte() }
            val one = recorder(clock)
            one.begin("none", 0, 0)
            one.messageWriting(0, cfw(bytes), emptyList())
            val line = Json.parseObject(one.encodeToString().lines()[1])
            assertContentEquals(bytes, Base64.decode(line["payload"] as String))
        }
    }

    @Test
    fun messagesPlannedBeforeTheRecordingAreMarkedAndNotReplayed() {
        val clock = FakeClock()
        // The state already has the 4x2 screen cleared to 5; replaying that clear's message
        // again after the later copy would undo it.
        val before = cfw(DrawProtocol.message(listOf(DrawProtocol.clear(5))))
        val recorder = recorder(clock)
        val screen = ByteArray(4) { 0x55 }
        recorder.begin("g2", 4, 2, OutboundMessage.lastTraceId(), listOf(
            ScreenRecorder.DeviceState(ScreenRecorder.LENS_BOTH, 4, 2, screen, DrawProtocol.SCREEN, emptyList())))
        val after = listOf(
            cfw(DrawProtocol.message(listOf(DrawProtocol.bbox(byteArrayOf(0x12, 0x34, 0, 0), 2, 0, 0, 4, 1)))),
            cfw(byteArrayOf(CFW_MSG_PRESENT.toByte()), "image"),
        )
        for (message in listOf(after[0], before, after[1])) {
            recorder.messageWriting(clock.nowMs, message, listOf(ByteArray(12)))
            for (lens in 1..2) recorder.lensAck(clock.nowMs, message, lens, false)
            recorder.messageAcked(clock.nowMs, message)
        }
        recorder.end()
        val replay = RecordingReplay(recorder.encodeToString()).run()
        val messages = replay.ofType("msg")
        assertEquals(listOf(null, true, null), messages.map { it["baseline"] })
        assertNotNull(messages[1]["payload"], "its bytes still count toward bandwidth")
        for (lens in replay.lenses) assertContentEquals(byteArrayOf(0x12, 0x34, 0x55, 0x55), lens.composition)
    }

    @Test
    fun aRecordingLeftRunningStopsAtItsSizeLimit() {
        val clock = FakeClock()
        val recorder = recorder(clock, 4_000)
        recorder.begin("g2", 640, 480)
        assertFalse(recorder.isTruncated)
        for (i in 0 until 20) recorder.messageWriting(clock.nowMs, cfw(ByteArray(500)), emptyList())
        assertTrue(recorder.isTruncated)
        recorder.end()
        val records = RecordingReplay(recorder.encodeToString()).records
        assertTrue(records.count { it["type"] == "msg" } in 1..7)
        assertEquals(listOf("mark", "end"), records.takeLast(2).map { it["type"] })
        assertEquals(true, records.last()["truncated"])
    }

    @Test
    fun phoneCompositesAreDeflatedAndRepeatsDropped() {
        val clock = FakeClock()
        val recorder = recorder(clock)
        recorder.begin("none", 6, 2)
        val gray = ByteArray(12) { (it * 16).toByte() }
        recorder.addScreen("phone", gray, 6, 2)
        recorder.addScreen("phone", gray.copyOf(), 6, 2)
        recorder.addScreen("phone", null, 6, 2)
        gray[0] = 0xf0.toByte()
        clock.nowMs += 10
        recorder.addScreen("phone", gray, 6, 2)
        recorder.end()
        val replay = RecordingReplay(recorder.encodeToString())
        assertEquals(listOf(5000, 5010), replay.ofType("screen").map { it["t"].asInt() })
        assertContentEquals(BmpUtil.pack4bppFromGray8(gray, 6, 2), replay.lastScreen())
    }

    @Test
    fun frameTimingsReachTheRecordingIncludingTreesAlreadyOpen() {
        val clock = FakeClock()
        val timings = FrameTimingsCore(clock, { 1_700_000_000_000L + clock.nowMs }, { "t" }, { "wall@$it" }, {}, {})
        val closed = timings.startFrame("render:earlier")
        timings.finishFrame(closed, "sent")
        val root = timings.startFrame("input:tap")
        clock.nowMs += 2
        timings.spanStart(root, "paint")
        val done = timings.startFrame("render:window", root)
        timings.finishFrame(done, "discarded: superseded")
        val open = timings.startFrame("render:shell", root)
        clock.nowMs += 3

        val recorder = recorder(clock)
        recorder.begin("g2", 640, 480)
        timings.attachSink(recorder)
        clock.nowMs += 4
        timings.annotate(open, "fg=launcher")
        timings.spanEnd(root, "paint")
        timings.finishFrame(open, "sent")
        val later = timings.startFrame("render:clock")
        timings.detachSink(recorder)
        timings.finishFrame(later, "sent")
        timings.finishFrame(root, "sent")
        recorder.end()

        val lines = recorder.encodeToString().lines().drop(1).dropLast(2)
        assertEquals("""
            |{"type":"frame","t":5000,"id":$root,"reason":"input:tap","wallClockMs":1700000005000}
            |{"type":"frame-log","t":5002,"id":$root,"thread":"t","text":"span paint start"}
            |{"type":"frame-log","t":5002,"id":$root,"thread":"t","text":"spawned frame#$done (render:window)"}
            |{"type":"frame-log","t":5002,"id":$root,"thread":"t","text":"spawned frame#$open (render:shell)"}
            |{"type":"frame","t":5002,"id":$done,"parent":$root,"reason":"render:window","wallClockMs":1700000005002}
            |{"type":"frame-log","t":5002,"id":$done,"thread":"t","text":"finished: discarded: superseded"}
            |{"type":"frame-end","t":5002,"id":$done,"outcome":"discarded: superseded"}
            |{"type":"frame","t":5002,"id":$open,"parent":$root,"reason":"render:shell","wallClockMs":1700000005002}
            |{"type":"frame-note","t":5009,"id":$open,"text":"fg=launcher"}
            |{"type":"frame-log","t":5009,"id":$root,"thread":"t","text":"span paint end (7ms)"}
            |{"type":"frame-log","t":5009,"id":$open,"thread":"t","text":"finished: sent"}
            |{"type":"frame-end","t":5009,"id":$open,"outcome":"sent"}
            |{"type":"frame","t":5009,"id":$later,"reason":"render:clock","wallClockMs":1700000005009}
            """.trimMargin(), lines.joinToString("\n"))
        // A second sink replaces the first, and detaching the stale one leaves it attached.
        val second = recorder(clock)
        second.begin("g2", 640, 480)
        timings.attachSink(recorder)
        timings.attachSink(second)
        timings.detachSink(recorder)
        timings.finishFrame(timings.startFrame("render:again"), "sent")
        second.end()
        assertEquals(1, RecordingReplay(second.encodeToString()).ofType("frame-end").size)
    }

    /**
     * Every draw opcode, flag and resource format through one recording, replayed here by the
     * reference renderer. The recording and what it must look like become a fixture that the
     * visualizer's JavaScript interpreter is held to (tests/screen-recording.test.cjs).
     */
    @Test
    fun everyDrawOpcodeReplaysOnBothLenses() {
        val clock = FakeClock()
        val width = 96
        val height = 64
        val stride = width / 2
        val screen = ByteArray(stride * height) { (((it % stride) / 3 + it / stride) % 16 * 17).toByte() }
        fun packed(w: Int, h: Int, pixel: (Int, Int) -> Int): ByteArray {
            val rows = ByteArray((w + 1) / 2 * h)
            for (y in 0 until h) for (x in 0 until w) {
                val at = y * ((w + 1) / 2) + x / 2
                rows[at] = (rows[at].toInt() or (pixel(x, y) shl (if (x % 2 == 0) 4 else 0))).toByte()
            }
            return rows
        }
        // Resources already on the glasses: a small raw image of odd width, and an RLE one.
        val small = byteArrayOf(0, 5, 3) + packed(5, 3) { x, y -> (x * 3 + y * 5) % 16 }
        val rle = byteArrayOf(DrawProtocol.RLE.toByte(), 6, 4, 0x3f, 0x0a, 20, 0x15)
        // A two-glyph font: 'A' (4x5) and 'B' (3x5), each a small image record.
        val glyphA = byteArrayOf(0, 4, 5) + packed(4, 5) { x, y -> if ((x + y) % 2 == 0) 15 else 6 }
        val glyphB = byteArrayOf(0, 3, 5) + packed(3, 5) { x, _ -> if (x == 1) 0 else 12 }
        val font = ByteArray(193 + glyphA.size + glyphB.size)
        font[0] = DrawProtocol.FONT.toByte()
        DrawProtocol.word(193).copyInto(font, 1 + ('A'.code - 32) * 2)
        DrawProtocol.word(193 + glyphA.size).copyInto(font, 1 + ('B'.code - 32) * 2)
        glyphA.copyInto(font, 193)
        glyphB.copyInto(font, 193 + glyphA.size)
        // Stock-font glyphs live in a process-wide registry, so use code points nothing else will.
        val stock = intArrayOf(0xe7a1, 0xe7a2)
        val registration = ByteSink()
        for ((index, cp) in stock.withIndex()) {
            val w = 3 + index * 2
            // [cp u32][ofsX s16][inkTop s16][boxW u8][boxH u8]: the glyphs sit at x-1 and x+0, two rows down.
            registration.write(DrawProtocol.word(cp) + DrawProtocol.word(0) + DrawProtocol.word(index - 1) + DrawProtocol.word(2) +
                byteArrayOf(w.toByte(), 4))
            registration.write(packed(w, 4) { x, y -> if (x == y) 0 else 9 + index * 4 })
        }
        FwGlyphAtlas.register(ArrayByteReader(registration.toByteArray()))
        val stockText = (codePointUtf8(stock[0]) + byteArrayOf(14) + codePointUtf8(stock[1]) + codePointUtf8(stock[0]))

        val recorder = recorder(clock)
        recorder.begin("g2", width, height, OutboundMessage.lastTraceId(), listOf(ScreenRecorder.DeviceState(
            ScreenRecorder.LENS_BOTH, width, height, screen, DrawProtocol.SCREEN, listOf(
                ScreenRecorder.DeviceState.Resource(3, small, null),
                ScreenRecorder.DeviceState.Resource(4, rle, null),
            ))))
        recorder.observeStockText(arrayOf(SurfaceCompositor.ScreenDraw.fwText(0, 0, 255,
            intArrayOf(stock[0], stock[1], stock[0], 32), intArrayOf(0, 5, 11, 15), booleanArrayOf(true, true, true, false))))
        fun send(payload: ByteArray, kind: String = "resources") {
            clock.nowMs += 7
            val message = cfw(payload, kind)
            recorder.messageWriting(clock.nowMs, message, listOf(ByteArray(minOf(240, payload.size + 16))))
            recorder.messageWritten(clock.nowMs + 1, message, true)
            for (lens in 1..2) recorder.lensAck(clock.nowMs + 20 + lens, message, lens, false)
            recorder.messageAcked(clock.nowMs + 22, message)
        }
        fun upload(id: Int, data: ByteArray, from: Int, to: Int) =
            DrawProtocol.word(id) + DrawProtocol.word(data.size) + DrawProtocol.word(0) + DrawProtocol.word(from) + DrawProtocol.word(to - from) + data.copyOfRange(from, to)
        // The font arrives in two chunks across two messages.
        send(byteArrayOf(CFW_MSG_UPLOAD_RESOURCE.toByte(), 1, 0) + upload(5, font, 0, 120))
        send(byteArrayOf(CFW_MSG_UPLOAD_RESOURCE.toByte(), 1, 0) + upload(5, font, 120, font.size))
        send(byteArrayOf(CFW_MSG_CREATE_SURFACE.toByte(), 1, 0) + DrawProtocol.word(6) + DrawProtocol.word(21) + DrawProtocol.word(10))
        val opaque = CFW_TEXTURE_OPT_BRIGHTNESS_MASK
        val transparent = CFW_TEXTURE_OPT_BRIGHTNESS_MASK or CFW_TEXTURE_OPT_TRANSPARENT
        val block = packed(width, height) { x, y -> (x + y * 2) % 16 }
        send(DrawProtocol.message(listOf(
            DrawProtocol.bbox(block, stride, 8, 4, 16, 6),                              // compact bounds
            DrawProtocol.bbox(block, stride, 31, 3, 7, 5),                              // u16 bounds, odd edges
            DrawProtocol.bbox(packed(21, 10) { x, y -> if (x in 2..18 && y in 1..8) 11 else 2 }, 11, 0, 0, 21, 10, target = 6),
            DrawProtocol.clear(3, clip = DrawClip(60, 2, 9, 7)),
            DrawProtocol.rectCopy(DrawProtocol.CURRENT, 8, 4, 16, 6, 12, 6),            // overlaps itself
            DrawProtocol.rectCopy(6, 1, 1, 19, 8, 40, 12),
            DrawProtocol.rectCopy(6, DrawValue.Integer(0), DrawValue.Integer(0), 21, 10, DrawValue.Integer(70), DrawValue.Integer(12),
                depth = 5, clip = DrawClip(72, 13, 12, 6)),
            DrawProtocol.image(3, 2, 20, opaque),
            DrawProtocol.image(3, 9, 20, 9 or CFW_TEXTURE_OPT_TRANSPARENT),
            DrawProtocol.image(4, 16, 20, opaque or CFW_TEXTURE_OPT_INVERSE, depth = -3),
            DrawProtocol.image(3, -2, 62, transparent),                                 // clipped by the target's edges
            DrawProtocol.text(5, 2, 28, transparent, byteArrayOf('A'.code.toByte(), 14, 'B'.code.toByte(), 'A'.code.toByte())),
            DrawProtocol.text(5, DrawValue.Integer(30), DrawValue.Integer(28), 10, "BA".encodeToByteArray(), depth = 4,
                clip = DrawClip(30, 29, 6, 3)),
            DrawProtocol.stockText(2, 36, transparent, stockText),
            DrawProtocol.remapColors(50, 24, 20, 10, IntArray(16) { 15 - it }, IntArray(16) { it / 2 }),
            DrawProtocol.roundedRect(2, 44, 30, 14, 5, 4, 15),
            DrawProtocol.roundedRect(DrawValue.Integer(36), DrawValue.Integer(44), 24, 14, 20, 0, depth = 2, outside = 1),
            DrawProtocol.roundedRect(64, 44, 9, 9, 0, 9),
        )))
        // A nested list, and a root that plays it under a dimmed overlay with a moving highlight.
        val inner = DrawProtocol.displayList(listOf(
            DrawProtocol.image(3, 80, 2, transparent),
            DrawProtocol.roundedRect(78, 8, 12, 6, 2, 0, 13),
        ))
        val root = DrawProtocol.displayList(DrawProtocol.screenCopy(width, height) + listOf(
            DrawProtocol.lut(width, height, 160),
            DrawProtocol.playList(7, depth = 6),
            DrawProtocol.image(6, 60, 50, opaque, depth = 2),
            DrawProtocol.roundedRect(DrawValue.animate(4, 44, 200), DrawValue.Integer(1), 10, 3, 1, 14),
        ))
        send(byteArrayOf(CFW_MSG_UPLOAD_RESOURCE.toByte(), 2, 0) + upload(7, inner, 0, inner.size) + upload(8, root, 0, root.size))
        send(DrawProtocol.root(8))
        send(byteArrayOf(CFW_MSG_PRESENT.toByte()), "image")
        send(byteArrayOf(CFW_MSG_EVICT_RESOURCE.toByte(), 1, 0) + DrawProtocol.word(4))
        send(byteArrayOf(CFW_MSG_PRESENT.toByte()), "image")
        recorder.end()

        val text = recorder.encodeToString()
        val replay = RecordingReplay(text).run()
        val (left, right) = replay.lenses
        assertNull(left.resources[4])
        assertContentEquals(font, left.resources[5])
        assertFalse(left.screen.contentEquals(right.screen), "depth shifts draws into the screen apart too")
        assertFalse(left.composition.contentEquals(right.composition), "depth shifts the lenses apart")
        val atStart = left.composition.copyOf()
        left.render(100)
        val midway = left.composition.copyOf()
        left.render(5_000)
        assertFalse(atStart.contentEquals(midway) || midway.contentEquals(left.composition), "the highlight moves, then settles")
        right.render(5_000)
        // The stock glyphs landed where the firmware's metrics put them (transparent ink over the screen).
        val target = DisplayListRenderer.Target(left.screen, width, height)
        assertEquals(9, target.get(2, 38))
        assertEquals(13, target.get(8 + 3, 36 + 2))

        fun b64(bytes: ByteArray) = Base64.encode(bytes)
        writeRecordingFixture("opcodes.fcrec.jsonl", text)
        writeRecordingFixture("opcodes.expected.json", Json.write(linkedMapOf<String, Any?>(
            "width" to width, "height" to height,
            "leftScreen" to b64(left.screen), "rightScreen" to b64(right.screen),
            "left" to b64(atStart), "leftAt100ms" to b64(midway), "leftSettled" to b64(left.composition),
            "rightSettled" to b64(right.composition),
        ), pretty = true) + "\n")
    }
}
