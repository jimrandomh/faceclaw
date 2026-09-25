package com.faceclaw.app

/** A retained draw submitted with frame pixels, before cache IDs have been assigned. */
interface RetainedDrawing {
    val resources: List<CachedResource>
    val fingerprint: String
    fun translated(dx: Int, dy: Int): RetainedDrawing
    fun calls(ids: IntArray, nowMs: Long): List<ByteArray>
}

internal fun readRetainedDrawing(reader: ByteReader, kind: Int): RetainedDrawing =
    if (kind == DrawRecordKind.DISPLAY_LIST) FrameDisplayList.read(reader) else MenuSelection.read(reader, kind)

/**
 * Generic TS-authored calls. No menu or easing policy lives in this bridge.
 *
 * Besides literal firmware calls, a record may carry a DRAWS call (bridge
 * only): glyph and icon records in the frame draw-record format, whose atlas
 * identities TS registered while painting. They compile to IMAGE calls on
 * ImageAtlas resources, then TEXT runs on FontResourceAtlas fonts, all offset
 * by the call's (possibly animated) x/y. When any record cannot be resolved,
 * the whole list draws nothing: the frame's own pixels show instead, rather
 * than content with a glyph missing.
 */
class FrameDisplayList private constructor(
    private val x: Int, private val y: Int, private val depth: Int,
    override val resources: List<CachedResource>, private val commands: List<Command>,
    internal val startedAt: Long, private val identity: String,
) : RetainedDrawing {
    override val fingerprint: String get() = "$x,$y,$depth,$identity"
    override fun translated(dx: Int, dy: Int) = FrameDisplayList(x + dx, y + dy, depth, resources, commands, startedAt, identity)

    /** Image/text [values] are resource, x offset, y offset, options; the offsets add to [x]/[y]. */
    private class Command(val op: Int, val depth: Int, val values: IntArray,
        val x: DrawValue = DrawValue.Integer(0), val y: DrawValue = DrawValue.Integer(0),
        val dx: DrawValue = DrawValue.Integer(0), val dy: DrawValue = DrawValue.Integer(0),
        val clip: DrawClip? = null, val text: ByteArray? = null)

    override fun calls(ids: IntArray, nowMs: Long): List<ByteArray> {
        require(ids.size == resources.size)
        val elapsed = (nowMs - startedAt).coerceIn(0, Int.MAX_VALUE.toLong()).toInt()
        fun resource(index: Int) = if (index == DrawProtocol.SCREEN) index else ids[index]
        return commands.map { c ->
            val v = c.values
            val clip = c.clip?.translated(x, y)
            when (c.op) {
                DRAW_OP_ROUNDED_RECT -> DrawProtocol.roundedRect(bind(c.x, elapsed, x), bind(c.y, elapsed, y),
                    v[0], v[1], v[2], v[3], v[4], depth + c.depth, clip)
                DRAW_OP_IMAGE -> DrawProtocol.image(resource(v[0]), bind(c.x, elapsed, x + v[1]), bind(c.y, elapsed, y + v[2]),
                    v[3], depth = depth + c.depth, clip = clip)
                DRAW_OP_TEXT -> DrawProtocol.text(resource(v[0]), bind(c.x, elapsed, x + v[1]), bind(c.y, elapsed, y + v[2]),
                    v[3], c.text!!, depth + c.depth, clip)
                DRAW_OP_RECT_COPY -> DrawProtocol.rectCopy(resource(v[0]),
                    bind(c.x, elapsed, if (v[0] == DrawProtocol.SCREEN) x else 0),
                    bind(c.y, elapsed, if (v[0] == DrawProtocol.SCREEN) y else 0),
                    v[1], v[2], bind(c.dx, elapsed, x), bind(c.dy, elapsed, y), depth = depth + c.depth, clip = clip)
                DRAW_OP_CLEAR -> DrawProtocol.clear(v[0], clip = clip, depth = if (clip == null) null else depth + c.depth)
                else -> error("Unsupported frame display-list opcode")
            }
        }
    }

    companion object {
        // Bridge-only constant binding, removed before a program reaches either renderer.
        private const val ELAPSED = 128
        private const val MAX_RECORD_BYTES = 4 * 1024 * 1024
        /** Bridge-only: replay glyph/icon draw records (see the class comment). */
        private const val DRAWS = 32
        /** Bridge opcode bit: an x/y s16, w/h u16 clip rect follows the call's depth. */
        private const val CLIPPED = 128
        private const val IMAGE_OPTIONS = CFW_TEXTURE_OPT_BRIGHTNESS_MASK or CFW_TEXTURE_OPT_TRANSPARENT

        private fun bind(value: DrawValue, elapsed: Int, offset: Int): DrawValue {
            if (value is DrawValue.Integer) return DrawValue.Integer(value.value + offset)
            val reader = DrawReader((value as DrawValue.Expression).program)
            val out = ByteSink()
            while (reader.remaining > 0) {
                when (val op = reader.readU8()) {
                    ELAPSED -> { out.write(DrawExpression.PUSH_I32); out.write(ExtendedVarint.signed(elapsed)) }
                    DrawExpression.PUSH_I32 -> { out.write(op); out.write(ExtendedVarint.signed(ExtendedVarint.read(reader, true))) }
                    DrawExpression.PUSH_F32 -> { out.write(op); out.write(reader.readBytes(4)) }
                    else -> out.write(op)
                }
            }
            if (offset != 0) {
                out.write(DrawExpression.PUSH_I32); out.write(ExtendedVarint.signed(offset)); out.write(DrawExpression.IADD)
            }
            val program = out.toByteArray()
            require(program.size <= DrawExpression.MAX_BYTES)
            return DrawValue.Expression(program)
        }

        private class GlyphRecord(val fontId: Int, val encoding: Int, val penX: Int, val lineY: Int, val value: Int)
        private class ImageRecord(val imageId: Int, val x: Int, val y: Int)

        /**
         * Compile one DRAWS call into [out], adding atlas resources through
         * [resource]. False when a record has no atlas entry, or its font
         * snapshot cannot hold every glyph this call needs.
         */
        private fun compileDraws(glyphs: List<GlyphRecord>, images: List<ImageRecord>, x: DrawValue, y: DrawValue,
                depth: Int, clip: DrawClip?, resource: (CachedResource) -> Int, out: MutableList<Command>): Boolean {
            for (image in images) {
                val entry = ImageAtlas.get(image.imageId) ?: return false
                out.add(Command(DRAW_OP_IMAGE, depth, intArrayOf(resource(entry.resource), image.x, image.y, IMAGE_OPTIONS),
                    x, y, clip = clip))
            }
            for ((fontId, fontGlyphs) in glyphs.groupBy { it.fontId }) {
                val encodings = fontGlyphs.map { it.encoding }.toSet()
                val font = FontResourceAtlas.get(fontId, encodings)
                if (!font.encodings.containsAll(encodings)) return false
                val fontIndex = resource(font.resource)
                // One run per line and color, like TexturePlanner's: control
                // bytes move the pen to each glyph's exact left edge.
                val lines = fontGlyphs.groupBy { it.lineY to BmpUtil.nibbleForGray(it.value) }
                for ((line, members) in lines) {
                    val placed = members.map { glyph ->
                        val atlas = GlyphAtlas.get(fontId, glyph.encoding) ?: return false
                        Triple(glyph.penX + atlas.bbxX, atlas.width, glyph.encoding)
                    }.sortedBy { it.first }
                    var start = 0
                    while (start < placed.size) {
                        val text = ByteSink()
                        var cursor = placed[start].first
                        var end = start
                        while (end < placed.size) {
                            val (left, width, encoding) = placed[end]
                            if (text.size() + TexturePlanner.adjustByteCount(left - cursor) + 1 > 255) break
                            TexturePlanner.emitAdjust(text, left - cursor)
                            text.write(encoding)
                            cursor = left + width
                            end++
                        }
                        out.add(Command(DRAW_OP_TEXT, depth,
                            intArrayOf(fontIndex, placed[start].first, line.first, line.second or CFW_TEXTURE_OPT_TRANSPARENT),
                            x, y, clip = clip, text = text.toByteArray()))
                        start = end
                    }
                }
            }
            return true
        }

        fun read(input: ByteReader, nowMs: Long = drawAnimationTimeMs()): FrameDisplayList {
            val length = input.getInt()
            require(length in 21..MAX_RECORD_BYTES && length <= input.remaining())
            val bytes = ByteArray(length).also { input.get(it) }
            val r = DrawReader(bytes)
            val x = r.readS16(); val y = r.readS16()
            val width = r.readU16(); val height = r.readU16()
            require(width in 1..640 && height in 1..480)
            val depth = r.readS8()
            r.readBytes(4) // Stable timeline token is included in the identity below.
            val elapsed = r.readU16() or (r.readU16() shl 16)
            require(elapsed >= 0)
            val resourceCount = r.readU16(); require(resourceCount <= 256)
            val local = List(resourceCount) {
                val w = r.readU16(); val h = r.readU16()
                require(w in 1..640 && h in 1..480 && 5 + (w + 1) / 2 * h <= 65536)
                val gray = r.readBytes(w * h)
                CachedResource(DrawProtocol.rawImage(w, h, BmpUtil.pack4bppFromGray8(gray, w, h)))
            }
            val resources = ArrayList(local)
            val atlasIndices = HashMap<CachedResource, Int>()
            fun atlasResource(cached: CachedResource): Int = atlasIndices.getOrPut(cached) { resources.add(cached); resources.size - 1 }
            fun value(): DrawValue {
                val first = r.readU8()
                if (first != 255) return DrawValue.Integer(ExtendedVarint.read(r, true, first))
                val size = ExtendedVarint.read(r, false).toUInt()
                require(size <= 900u)
                return DrawValue.Expression(r.readBytes(size.toInt())).also {
                    // Validate framing and worst-case binding growth before retaining the frame.
                    bind(it, Int.MAX_VALUE, Int.MAX_VALUE)
                }
            }
            fun resource(): Int = r.readU16().also { require(it == DrawProtocol.SCREEN || it in local.indices) }
            val count = r.readU16(); require(count <= 4096)
            val commands = ArrayList<Command>()
            var replayable = true
            repeat(count) {
                val header = r.readU8(); val op = header and CLIPPED.inv()
                val d = r.readS16(); require(depth + d in -128..127)
                val clip = if (header and CLIPPED != 0) DrawClip(r.readS16(), r.readS16(), r.readU16(), r.readU16()) else null
                when (op) {
                    DRAW_OP_ROUNDED_RECT -> {
                        val xx = value(); val yy = value()
                        val w = r.readU16(); val h = r.readU16(); val radius = r.readU16()
                        val background = r.readU8(); val border = r.readU8()
                        require(w in 1..640 && h in 1..480 && background in 0..15 && border in 0..16)
                        commands.add(Command(op, d, intArrayOf(w, h, radius, background, border), xx, yy, clip = clip))
                    }
                    DRAW_OP_IMAGE -> {
                        val id = resource(); require(id != DrawProtocol.SCREEN)
                        val xx = r.readS16(); val yy = r.readS16(); val options = r.readU8()
                        require(options == 15 || options == 31)
                        commands.add(Command(op, d, intArrayOf(id, xx, yy, options), clip = clip))
                    }
                    DRAW_OP_RECT_COPY -> {
                        val id = resource(); val sx = value(); val sy = value()
                        val w = r.readU16(); val h = r.readU16(); val dx = value(); val dy = value()
                        require(w in 1..640 && h in 1..480)
                        // Relative SCREEN sources may be negative until placement is added.
                        require(id == DrawProtocol.SCREEN || listOf(sx, sy).all { it !is DrawValue.Integer || it.value >= 0 })
                        commands.add(Command(op, d, intArrayOf(id, w, h), sx, sy, dx, dy, clip = clip))
                    }
                    DRAW_OP_CLEAR -> {
                        val color = r.readU8(); require(color in 0..15)
                        commands.add(Command(op, d, intArrayOf(color), clip = clip))
                    }
                    DRAWS -> {
                        val xx = value(); val yy = value()
                        val glyphs = ArrayList<GlyphRecord>(); val images = ArrayList<ImageRecord>()
                        repeat(r.readU16()) {
                            when (r.readU8()) {
                                DrawRecordKind.GLYPH -> {
                                    val fontId = r.readU16(); val encoding = r.readU16() or (r.readU16() shl 16)
                                    glyphs.add(GlyphRecord(fontId, encoding, r.readS16(), r.readS16(), r.readU8()))
                                }
                                DrawRecordKind.TEXTURE_IMAGE -> {
                                    val imageId = r.readU16() or (r.readU16() shl 16)
                                    images.add(ImageRecord(imageId, r.readS16(), r.readS16()))
                                }
                                else -> error("Unsupported display-list draw record")
                            }
                        }
                        if (replayable) replayable = compileDraws(glyphs, images, xx, yy, d, clip, ::atlasResource, commands)
                    }
                    else -> error("Unsupported frame display-list opcode")
                }
            }
            r.requireDone()
            // Elapsed changes while the same timeline is resubmitted; it is not content identity.
            bytes.fill(0, 13, 17)
            val identity = CachedResource(bytes).hash.toString()
            if (!replayable || commands.size > 4096 || resources.size > 511) {
                return FrameDisplayList(x, y, depth, emptyList(), emptyList(), nowMs - elapsed, identity)
            }
            return FrameDisplayList(x, y, depth, resources, commands, nowMs - elapsed, identity)
        }
    }
}
