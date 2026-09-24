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

/** Generic TS-authored calls. No menu or easing policy lives in this bridge. */
class FrameDisplayList private constructor(
    private val x: Int, private val y: Int, private val depth: Int,
    override val resources: List<CachedResource>, private val commands: List<Command>,
    internal val startedAt: Long, private val identity: String,
) : RetainedDrawing {
    override val fingerprint: String get() = "$x,$y,$depth,$identity"
    override fun translated(dx: Int, dy: Int) = FrameDisplayList(x + dx, y + dy, depth, resources, commands, startedAt, identity)

    private class Command(val op: Int, val depth: Int, val values: IntArray,
        val x: DrawValue = DrawValue.Integer(0), val y: DrawValue = DrawValue.Integer(0),
        val dx: DrawValue = DrawValue.Integer(0), val dy: DrawValue = DrawValue.Integer(0))

    override fun calls(ids: IntArray, nowMs: Long): List<ByteArray> {
        require(ids.size == resources.size)
        val elapsed = (nowMs - startedAt).coerceIn(0, Int.MAX_VALUE.toLong()).toInt()
        fun resource(index: Int) = if (index == DrawProtocol.SCREEN) index else ids[index]
        return commands.map { c ->
            val v = c.values
            when (c.op) {
                DRAW_OP_ROUNDED_RECT -> DrawProtocol.roundedRect(bind(c.x, elapsed, x), bind(c.y, elapsed, y),
                    v[0], v[1], v[2], v[3], v[4], depth + c.depth)
                DRAW_OP_IMAGE -> DrawProtocol.image(resource(v[0]), x + v[1], y + v[2], v[3], depth = depth + c.depth)
                DRAW_OP_RECT_COPY -> DrawProtocol.rectCopy(resource(v[0]),
                    bind(c.x, elapsed, if (v[0] == DrawProtocol.SCREEN) x else 0),
                    bind(c.y, elapsed, if (v[0] == DrawProtocol.SCREEN) y else 0),
                    v[1], v[2], bind(c.dx, elapsed, x), bind(c.dy, elapsed, y), depth = depth + c.depth)
                else -> error("Unsupported frame display-list opcode")
            }
        }
    }

    companion object {
        // Bridge-only constant binding, removed before a program reaches either renderer.
        private const val ELAPSED = 128
        private const val MAX_RECORD_BYTES = 4 * 1024 * 1024

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
            val resources = List(resourceCount) {
                val w = r.readU16(); val h = r.readU16()
                require(w in 1..640 && h in 1..480 && 5 + (w + 1) / 2 * h <= 65536)
                val gray = r.readBytes(w * h)
                CachedResource(DrawProtocol.rawImage(w, h, BmpUtil.pack4bppFromGray8(gray, w, h)))
            }
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
            fun resource(): Int = r.readU16().also { require(it == DrawProtocol.SCREEN || it in resources.indices) }
            val count = r.readU16(); require(count <= 4096)
            val calls = List(count) {
                val op = r.readU8(); val d = r.readS16(); require(depth + d in -128..127)
                when (op) {
                    DRAW_OP_ROUNDED_RECT -> {
                        val xx = value(); val yy = value()
                        val w = r.readU16(); val h = r.readU16(); val radius = r.readU16()
                        val background = r.readU8(); val border = r.readU8()
                        require(w in 1..640 && h in 1..480 && background in 0..15 && border in 0..16)
                        Command(op, d, intArrayOf(w, h, radius, background, border), xx, yy)
                    }
                    DRAW_OP_IMAGE -> {
                        val id = resource(); require(id != DrawProtocol.SCREEN)
                        val xx = r.readS16(); val yy = r.readS16(); val options = r.readU8()
                        require(options == 15 || options == 31)
                        Command(op, d, intArrayOf(id, xx, yy, options))
                    }
                    DRAW_OP_RECT_COPY -> {
                        val id = resource(); val sx = value(); val sy = value()
                        val w = r.readU16(); val h = r.readU16(); val dx = value(); val dy = value()
                        require(w in 1..640 && h in 1..480)
                        // Relative SCREEN sources may be negative until placement is added.
                        require(id == DrawProtocol.SCREEN || listOf(sx, sy).all { it !is DrawValue.Integer || it.value >= 0 })
                        Command(op, d, intArrayOf(id, w, h), sx, sy, dx, dy)
                    }
                    else -> error("Unsupported frame display-list opcode")
                }
            }
            r.requireDone()
            // Elapsed changes while the same timeline is resubmitted; it is not content identity.
            bytes.fill(0, 13, 17)
            return FrameDisplayList(x, y, depth, resources, calls, nowMs - elapsed, CachedResource(bytes).hash.toString())
        }
    }
}
