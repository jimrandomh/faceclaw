package com.faceclaw.app

/**
 * A draw call's clip rect (revision 35, DRAW_FLAG_CLIP), in the call's own
 * coordinates: it moves with the call's depth, narrows any clip inherited
 * from an enclosing play-list call, and is dropped by a target override.
 */
class DrawClip(val x: Int, val y: Int, val width: Int, val height: Int) {
    init {
        require(x in -32768..32767 && y in -32768..32767 && width in 0..65535 && height in 0..65535)
    }

    fun translated(dx: Int, dy: Int) = DrawClip(x + dx, y + dy, width, height)
}

/** Revision 35 wire grammar, shared by scene planning and the local renderer. */
object DrawProtocol {
    /** Mirrors g2flash/patches/zlib_glue.c. */
    const val DRAW = CFW_MSG_DRAW_CALLS
    const val ROOT = CFW_MSG_SET_ROOT_DISPLAY_LIST
    const val PRESENT = CFW_MSG_PRESENT
    const val CREATE = CFW_MSG_CREATE_SURFACE

    /** Mirrors g2flash/patches/resource_cache.h. */
    const val IMAGE = CFW_RESOURCE_TYPE_IMAGE
    const val FONT = CFW_RESOURCE_TYPE_FONT
    const val LIST = CFW_RESOURCE_TYPE_DISPLAY_LIST
    const val LARGE = CFW_RESOURCE_FLAG_LARGE
    const val RLE = CFW_RESOURCE_FLAG_RLE

    /** Mirrors g2flash/patches/display_list.c. */
    const val SCREEN = 65535
    const val CURRENT = 65534

    /** Fixed-width resource/legacy fields, separate from the draw numeric codec. */
    fun u16(b: ByteArray, p: Int): Int = (b[p].toInt() and 255) or ((b[p + 1].toInt() and 255) shl 8)
    fun word(n: Int) = byteArrayOf(n.toByte(), (n ushr 8).toByte())

    private fun encode(write: DrawWriter.() -> Unit): ByteArray = DrawWriter().apply(write).toByteArray()

    fun call(op: Int, args: ByteArray, target: Int? = null, depth: Int? = null, clip: DrawClip? = null): ByteArray {
        require(depth == null || depth in -128..127)
        val flags = (if (target == null) 0 else DRAW_FLAG_RESOURCE_TARGET) or
            (if (depth == null) 0 else DRAW_FLAG_DEPTH) or
            (if (clip == null) 0 else DRAW_FLAG_CLIP)
        return encode {
            writeU8(op)
            writeU8(flags)
            if (target != null) writeU16(target)
            if (depth != null) writeS8(depth)
            if (clip != null) {
                writeS16(clip.x)
                writeS16(clip.y)
                writeU16(clip.width)
                writeU16(clip.height)
            }
            writeBytes(args)
        }
    }

    private fun call(op: Int, target: Int? = null, depth: Int? = null, clip: DrawClip? = null,
        write: DrawWriter.() -> Unit): ByteArray =
        call(op, encode(write), target, depth, clip)

    fun depthOffset(depth: Int, right: Boolean): Int =
        if (right) -floorHalf(depth + 1) else floorHalf(depth)

    private fun floorHalf(n: Int): Int = if (n < 0) (n - 1) / 2 else n / 2

    fun roundedRect(
        x: Int, y: Int, width: Int, height: Int, radius: Int, background: Int,
        border: Int = DRAW_ROUNDED_RECT_NO_BORDER, depth: Int? = null,
    ): ByteArray = roundedRect(DrawValue.Integer(x), DrawValue.Integer(y), width, height, radius, background, border, depth)

    fun roundedRect(
        x: DrawValue, y: DrawValue, width: Int, height: Int, radius: Int, background: Int,
        border: Int = DRAW_ROUNDED_RECT_NO_BORDER, depth: Int? = null, clip: DrawClip? = null,
    ): ByteArray {
        require(width in 1..640 && height in 1..480 && radius in 0..65535)
        require(background in 0..15 && border in 0..DRAW_ROUNDED_RECT_NO_BORDER)
        return call(DRAW_OP_ROUNDED_RECT, depth = depth, clip = clip) {
            writeExtended(x)
            writeExtended(y)
            writeU16(width)
            writeU16(height)
            writeU16(radius)
            writeU8(background)
            writeU8(border)
        }
    }

    fun sequence(calls: List<ByteArray>): ByteArray {
        require(calls.size <= 4096)
        return encode {
            writeU16(calls.size)
            for (call in calls) {
                require(call.size <= 65535)
                writeU16(call.size)
                writeBytes(call)
            }
        }
    }

    fun message(calls: List<ByteArray>) = byteArrayOf(DRAW.toByte()) + sequence(calls)
    fun displayList(calls: List<ByteArray>) = byteArrayOf(LIST.toByte()) + sequence(calls)
    fun root(id: Int) = byteArrayOf(ROOT.toByte()) + encode { writeU16(id) }

    fun image(
        id: Int, x: Int, y: Int, options: Int = CFW_TEXTURE_OPT_BRIGHTNESS_MASK,
        target: Int? = null, depth: Int? = null, clip: DrawClip? = null,
    ): ByteArray = image(id, DrawValue.Integer(x), DrawValue.Integer(y), options, target, depth, clip)

    /** Revision 35: x and y are extended values and may be expressions. */
    fun image(
        id: Int, x: DrawValue, y: DrawValue, options: Int = CFW_TEXTURE_OPT_BRIGHTNESS_MASK,
        target: Int? = null, depth: Int? = null, clip: DrawClip? = null,
    ): ByteArray = call(DRAW_OP_IMAGE, target, depth, clip) {
        writeU16(id)
        writeExtended(x)
        writeExtended(y)
        writeU8(options)
    }

    fun rectCopy(
        source: Int, x: Int, y: Int, width: Int, height: Int, dx: Int, dy: Int,
        target: Int? = null, depth: Int? = null,
    ): ByteArray = rectCopy(source, DrawValue.Integer(x), DrawValue.Integer(y), width, height,
        DrawValue.Integer(dx), DrawValue.Integer(dy), target, depth)

    /** Revision 29: source and destination coordinates may be expressions; the source rect must stay in bounds. */
    fun rectCopy(
        source: Int, x: DrawValue, y: DrawValue, width: Int, height: Int, dx: DrawValue, dy: DrawValue,
        target: Int? = null, depth: Int? = null, clip: DrawClip? = null,
    ): ByteArray = call(DRAW_OP_RECT_COPY, target, depth, clip) {
        writeU16(source)
        writeExtended(x)
        writeExtended(y)
        writeU16(width)
        writeU16(height)
        writeExtended(dx)
        writeExtended(dy)
    }

    /**
     * Fill the whole target, ignoring depth; under a clip (revision 35), just
     * the clipped part. Depth still moves the clip rect, like any call's.
     */
    fun clear(color: Int = 0, target: Int? = null, clip: DrawClip? = null, depth: Int? = null): ByteArray {
        require(color in 0..15)
        return call(DRAW_OP_CLEAR, target, depth, clip) { writeU8(color) }
    }

    /**
     * The copy that starts every root list: firmware presents only what the root
     * draws. A shifted copy clears first so its uncovered edge is not stale.
     */
    fun screenCopy(width: Int, height: Int, depth: Int = 0): List<ByteArray> =
        if (depth == 0) listOf(rectCopy(SCREEN, 0, 0, width, height, 0, 0))
        else listOf(clear(), rectCopy(SCREEN, 0, 0, width, height, 0, 0, depth = depth))

    fun stockText(x: Int, y: Int, options: Int, text: ByteArray): ByteArray {
        require(text.size <= 255)
        return call(DRAW_OP_STOCK_FONT_STRING) {
            writeS16(x)
            writeS16(y)
            writeU8(options)
            writeU8(text.size)
            writeBytes(text)
        }
    }

    fun text(id: Int, x: Int, y: Int, options: Int, text: ByteArray): ByteArray =
        text(id, DrawValue.Integer(x), DrawValue.Integer(y), options, text)

    /** Revision 35: x and y are extended values and may be expressions. */
    fun text(id: Int, x: DrawValue, y: DrawValue, options: Int, text: ByteArray, depth: Int? = null,
        clip: DrawClip? = null): ByteArray {
        require(text.size <= 255)
        return call(DRAW_OP_TEXT, depth = depth, clip = clip) {
            writeU16(id)
            writeExtended(x)
            writeExtended(y)
            writeU8(options)
            writeU8(text.size)
            writeBytes(text)
        }
    }

    fun playList(id: Int, target: Int? = null, depth: Int? = null): ByteArray =
        call(DRAW_OP_DISPLAY_LIST, target, depth) { writeU16(id) }

    /** Revision 33: target pixels with even x+y map through [even], odd ones through [odd]. */
    fun remapColors(x: Int, y: Int, width: Int, height: Int, even: IntArray, odd: IntArray): ByteArray {
        require(even.size == 16 && odd.size == 16 && (even + odd).all { it in 0..15 })
        fun packed(table: IntArray) = ByteArray(8) { i -> ((table[i * 2] shl 4) or table[i * 2 + 1]).toByte() }
        return call(DRAW_OP_REMAP_COLORS) {
            writeU16(x)
            writeU16(y)
            writeU16(width)
            writeU16(height)
            writeBytes(packed(even))
            writeBytes(packed(odd))
        }
    }

    /** Dim the whole target's light to factor/256 with DimDither's checkerboard. */
    fun lut(width: Int, height: Int, factor: Int): ByteArray {
        val (even, odd) = DimDither.tables(factor)
        return remapColors(0, 0, width, height, even, odd)
    }

    fun rawImage(width: Int, height: Int, pixels: ByteArray = ByteArray(((width + 1) / 2) * height)): ByteArray {
        require(width in 1..640 && height in 1..480 && pixels.size == ((width + 1) / 2) * height)
        val result = byteArrayOf(LARGE.toByte()) + word(width) + word(height) + pixels
        require(result.size <= ResourceCacheState.MAX_RESOURCE_SIZE)
        return result
    }

    private fun boundingBox(
        x: Int, y: Int, width: Int, height: Int, compact: Boolean, rle: ByteArray, target: Int? = null,
    ): ByteArray = call(DRAW_OP_BOUNDING_BOX, target) {
        writeU8(if (compact) 0 else DRAW_BBOX_FLAG_U16)
        if (compact) {
            writeU8(x / 4)
            writeU8(y / 2)
            writeU8(width / 4)
            writeU8(height / 2)
        } else {
            writeU16(x)
            writeU16(y)
            writeU16(width)
            writeU16(height)
        }
        writeBytes(rle)
    }

    /** Packed rows -> RLE of exactly width*height pixels, omitting odd-row padding. */
    fun bbox(packed: ByteArray, stride: Int, x: Int, y: Int, width: Int, height: Int, target: Int? = null): ByteArray {
        val compact = x % 4 == 0 && y % 2 == 0 && width % 4 == 0 && height % 2 == 0 &&
            x / 4 < 256 && y / 2 < 256 && width / 4 < 256 && height / 2 < 256
        // Pixel RLE is an opaque byte block, with its own fixed-width run lengths.
        val out = ByteSink()
        var color = -1
        var count = 0
        fun flush() {
            if (count == 0) return
            if (count <= 15) {
                out.write((count shl 4) or color)
            } else {
                out.write(color)
                if (count <= 255) {
                    out.write(count)
                } else {
                    out.write(0)
                    out.write(word(count))
                }
            }
        }
        for (yy in y until y + height) for (xx in x until x + width) {
            val shift = if (xx % 2 == 0) 4 else 0
            val value = (packed[yy * stride + xx / 2].toInt() ushr shift) and 15
            if (value != color || count == 65535) {
                flush()
                color = value
                count = 0
            }
            count++
        }
        flush()
        return boundingBox(x, y, width, height, compact, out.toByteArray(), target)
    }

    /**
     * Optimizer records retain their internal fixed-width format. Decode their
     * numeric fields here so every outgoing draw field goes through DrawWriter.
     */
    fun fromOptimized(payload: ByteArray, width: Int = 640, height: Int = 480): List<ByteArray> {
        val reader = ArrayByteReader(payload)
        fun u8() = reader.get().toInt() and 255
        fun u16() = reader.getShort().toInt() and 65535
        fun s16() = reader.getShort().toInt()
        fun bytes(count: Int): ByteArray = ByteArray(count).also { reader.get(it) }
        val result = when (val mode = u8() and CFW_MSG_TYPE_MASK) {
            CFW_MSG_MULTI_SEGMENT -> {
                val calls = ArrayList<ByteArray>()
                repeat(u8()) {
                    calls.addAll(fromOptimized(bytes(u16()), width, height))
                }
                calls
            }
            CFW_MSG_BOUNDING_BOX -> {
                val x = u8() * 4
                val y = u8() * 2
                val w = u8() * 4
                val h = u8() * 2
                u16() // Frame ID belongs only to the optimizer record.
                listOf(boundingBox(x, y, w, h, true, bytes(reader.remaining())))
            }
            CFW_MSG_FULL_FRAME -> listOf(boundingBox(0, 0, width, height, false, bytes(reader.remaining())))
            CFW_MSG_STOCK_FONT_STRING -> {
                val x = s16()
                val y = s16()
                val options = u8()
                listOf(stockText(x, y, options, bytes(u8())))
            }
            CFW_MSG_CACHED_IMAGE -> {
                val id = u16()
                val x = s16()
                val y = s16()
                val options = u8()
                listOf(image(id, x, y, options))
            }
            CFW_MSG_CACHED_TEXT -> {
                val id = u16()
                val x = s16()
                val y = s16()
                val options = u8()
                listOf(text(id, x, y, options, bytes(u8())))
            }
            CFW_MSG_RECT_COPY -> {
                val x = u16()
                val y = u16()
                val w = u16()
                val h = u16()
                val dx = s16()
                val dy = s16()
                listOf(rectCopy(CURRENT, x, y, w, h, dx, dy))
            }
            else -> error("Unsupported internal draw format $mode")
        }
        require(reader.remaining() == 0)
        return result
    }

    fun messages(calls: List<ByteArray>, maxBytes: Int = 65535): List<ByteArray> {
        fun headerSize(count: Int) = 1 + encode { writeU16(count) }.size
        val result = ArrayList<ByteArray>()
        var batch = ArrayList<ByteArray>()
        var bodySize = 0
        for (call in calls) {
            require(call.size <= 65535)
            val framedSize = encode { writeU16(call.size) }.size + call.size
            require(headerSize(1) + framedSize <= maxBytes)
            if (headerSize(batch.size + 1) + bodySize + framedSize > maxBytes || batch.size == 4096) {
                result.add(message(batch))
                batch = ArrayList()
                bodySize = 0
            }
            batch.add(call)
            bodySize += framedSize
        }
        if (batch.isNotEmpty()) result.add(message(batch))
        return result
    }
}
