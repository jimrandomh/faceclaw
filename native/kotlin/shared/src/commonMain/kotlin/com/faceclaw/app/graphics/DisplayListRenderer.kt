package com.faceclaw.app

/** Reference interpreter. It uses the firmware's packed rows, clipping, LUT and call grammar. */
class DisplayListRenderer(
    private val resources: Map<Int, ByteArray>,
    private val builtin: ((Int, Int) -> BuiltinGlyph)? = null,
    private val rightLens: Boolean = false,
) {
    class BuiltinGlyph(val image: ByteArray, val advance: Int, val x: Int = 0, val y: Int = 0)

    /**
     * [clip] (revision 35) is the writable [left, top, right, bottom) in
     * shifted target pixels, or null for the whole target. Like the depth
     * shift, it is inherited by nested lists and dropped by a target override.
     */
    class Target(
        val bytes: ByteArray,
        val width: Int,
        val height: Int,
        val offset: Int = 0,
        val shiftX: Int = 0,
        val clip: IntArray? = null,
    ) {
        val stride = (width + 1) / 2

        init {
            require(width > 0 && height > 0 && offset >= 0 && bytes.size - offset >= stride * height)
        }

        fun get(x: Int, y: Int): Int {
            val shift = if (x % 2 == 0) 4 else 0
            return (bytes[offset + y * stride + x / 2].toInt() ushr shift) and 15
        }

        fun shifted(dx: Int) = Target(bytes, width, height, offset, shiftX + dx, clip)

        /** Narrow the clip to a rect in (unshifted) call coordinates. */
        fun clipped(x: Int, y: Int, w: Int, h: Int): Target {
            val left = x + shiftX
            val rect = intArrayOf(left, y, left + w, y + h)
            if (clip != null) {
                rect[0] = maxOf(rect[0], clip[0]); rect[1] = maxOf(rect[1], clip[1])
                rect[2] = minOf(rect[2], clip[2]); rect[3] = minOf(rect[3], clip[3])
            }
            return Target(bytes, width, height, offset, shiftX, rect)
        }

        fun writable(x: Int, y: Int): Boolean =
            x in 0 until width && y in 0 until height &&
                (clip == null || (x >= clip[0] && y >= clip[1] && x < clip[2] && y < clip[3]))

        fun put(localX: Int, y: Int, value: Int) {
            val x = localX + shiftX
            if (!writable(x, y)) return
            val index = offset + y * stride + x / 2
            val old = bytes[index].toInt()
            bytes[index] = if (x % 2 == 0) {
                ((old and 15) or (value shl 4)).toByte()
            } else {
                ((old and 240) or value).toByte()
            }
        }
    }

    /** Shared by nested calls, and reset between validation and drawing. */
    var animationPending: Boolean = false
        private set

    private class Walk(val screen: Target, val apply: Boolean, val references: MutableSet<Int>, val frame: DrawEvaluation) {
        val ancestors = mutableListOf<Int>()
        var remainingCalls = 4096
    }

    private class Image(val width: Int, val height: Int, val pixels: IntArray)

    private fun resource(id: Int) = requireNotNull(resources[id]) { "Missing resource $id" }

    // Resource headers, font offsets and RLE have their own fixed-width grammar;
    // they do not use the draw-call numeric codec.
    private fun readU8(reader: ByteReader): Int = reader.get().toInt() and 255
    private fun readU16(reader: ByteReader): Int = reader.getShort().toInt() and 65535

    private fun decodeRle(reader: ByteReader, count: Int, exact: Boolean): IntArray {
        val pixels = IntArray(count)
        var index = 0
        while (index < count) {
            val token = readU8(reader)
            var run = token ushr 4
            if (run == 0) {
                run = readU8(reader)
                if (run == 0) run = readU16(reader)
            }
            require(run > 0 && run <= count - index)
            pixels.fill(token and 15, index, index + run)
            index += run
        }
        require(!exact || reader.remaining() == 0)
        return pixels
    }

    private fun image(bytes: ByteArray, start: Int = 0): Image {
        require(start in bytes.indices)
        val reader = ArrayByteReader(bytes, start)
        val flags = readU8(reader)
        require(flags and CFW_RESOURCE_IMAGE_FLAGS_MASK == flags)
        val large = flags and CFW_RESOURCE_FLAG_LARGE != 0
        val width = if (large) readU16(reader) else readU8(reader)
        val height = if (large) readU16(reader) else readU8(reader)
        require(width in 1..640 && height in 1..480)
        val pixels = if (flags and CFW_RESOURCE_FLAG_RLE != 0) {
            decodeRle(reader, width * height, false)
        } else {
            val offset = bytes.size - reader.remaining()
            val target = Target(bytes, width, height, offset)
            IntArray(width * height) { target.get(it % width, it / width) }
        }
        return Image(width, height, pixels)
    }

    private fun target(id: Int): Target {
        val bytes = resource(id)
        val reader = ArrayByteReader(bytes)
        val flags = readU8(reader)
        require(flags and (CFW_RESOURCE_TYPE_MASK or CFW_RESOURCE_FLAG_RLE) == 0)
        image(bytes) // Validate the complete raw image before exposing a write target.
        val large = flags and CFW_RESOURCE_FLAG_LARGE != 0
        val width = if (large) readU16(reader) else readU8(reader)
        val height = if (large) readU16(reader) else readU8(reader)
        return Target(bytes, width, height, bytes.size - reader.remaining())
    }

    private fun draw(image: Image, target: Target, x: Int, y: Int, options: Int, apply: Boolean) {
        if (!apply) return
        for (i in image.pixels.indices) {
            val value = image.pixels[i]
            if (value == 0 && options and CFW_TEXTURE_OPT_TRANSPARENT != 0) continue
            val source = if (options and CFW_TEXTURE_OPT_INVERSE != 0) 15 - value else value
            val brightness = source * (options and CFW_TEXTURE_OPT_BRIGHTNESS_MASK) / 15
            target.put(x + i % image.width, y + i / image.width, brightness)
        }
    }

    private fun roundedContains(x: Int, y: Int, width: Int, height: Int, radius: Int): Boolean {
        if (x !in 0 until width || y !in 0 until height) return false
        val r = minOf(radius, width / 2, height / 2)
        val dx = maxOf(0, 2 * r - (2 * minOf(x, width - 1 - x) + 1))
        val dy = maxOf(0, 2 * r - (2 * minOf(y, height - 1 - y) + 1))
        return dx * dx + dy * dy <= 4 * r * r
    }

    private fun copyScreen(screen: Target, composition: Target) {
        val source = screen.bytes
        val destination = composition.bytes
        // Shared backing arrays can overlap and the pixel loop intentionally reads
        // earlier writes. Keep that behavior, as well as shifted target clipping.
        if (source === destination || composition.shiftX != 0) {
            for (y in 0 until screen.height) for (x in 0 until screen.width) composition.put(x, y, screen.get(x, y))
            return
        }
        val width = minOf(screen.width, composition.width)
        val height = minOf(screen.height, composition.height)
        val sourceStride = screen.stride
        val destinationStride = composition.stride
        var src = screen.offset
        var dst = composition.offset
        if (screen.width == composition.width && width and 1 == 0) {
            source.copyInto(destination, dst, src, src + sourceStride * height)
            return
        }
        val pairs = width / 2
        for (y in 0 until height) {
            source.copyInto(destination, dst, src, src + pairs)
            // The last pixel of an odd-width row shares a byte with padding or
            // an untouched destination pixel; preserve that low nibble.
            if (width and 1 != 0) destination[dst + pairs] =
                ((source[src + pairs].toInt() and 240) or (destination[dst + pairs].toInt() and 15)).toByte()
            src += sourceStride
            dst += destinationStride
        }
    }

    /** Validate the whole graph before changing any pixels. Resource writes remain call-scoped. */
    fun render(root: Int, screen: Target, composition: Target, elapsedMs: Long = 0): Set<Int> {
        animationPending = false
        val frame = DrawEvaluation(elapsedMs)
        val references = mutableSetOf<Int>()
        for (apply in listOf(false, true)) {
            // A root list composes the whole frame, including its screen copy.
            if (root != DrawProtocol.SCREEN) {
                executeList(root, composition, Walk(screen, apply, references, frame))
            } else if (apply) {
                copyScreen(screen, composition)
            }
        }
        animationPending = frame.animationPending
        return references
    }

    fun execute(sequence: ByteArray, target: Target, screen: Target = target, elapsedMs: Long = 0): Set<Int> {
        animationPending = false
        val frame = DrawEvaluation(elapsedMs)
        val references = mutableSetOf<Int>()
        for (apply in listOf(false, true)) {
            executeSequence(DrawReader(sequence), target, Walk(screen, apply, references, frame))
        }
        animationPending = frame.animationPending
        return references
    }

    private fun executeList(id: Int, target: Target, walk: Walk) {
        require(walk.ancestors.size < 8 && id !in walk.ancestors)
        val bytes = resource(id)
        require(bytes.size >= 3 && bytes[0].toInt() == CFW_RESOURCE_TYPE_DISPLAY_LIST)
        walk.references.add(id)
        walk.ancestors.add(id)
        executeSequence(DrawReader(bytes, start = 1), target, walk)
        walk.ancestors.removeAt(walk.ancestors.lastIndex)
    }

    private fun executeSequence(reader: DrawReader, inherited: Target, walk: Walk) {
        val count = reader.readU16()
        repeat(count) {
            val length = reader.readU16()
            require(walk.remainingCalls > 0)
            walk.remainingCalls--
            executeCall(reader.readSlice(length), inherited, walk)
        }
        reader.requireDone()
    }

    private fun executeCall(reader: DrawReader, inherited: Target, walk: Walk) {
        val opcode = reader.readU8()
        val flags = reader.readU8()
        require(flags and DRAW_FLAGS_MASK.inv() == 0)
        var target = inherited
        if (flags and DRAW_FLAG_RESOURCE_TARGET != 0) {
            val id = reader.readU16()
            walk.references.add(id)
            target = target(id).shifted(inherited.shiftX)
        }
        if (flags and DRAW_FLAG_DEPTH != 0) {
            target = target.shifted(DrawProtocol.depthOffset(reader.readS8(), rightLens))
        }
        if (flags and DRAW_FLAG_CLIP != 0) {
            target = target.clipped(reader.readS16(), reader.readS16(), reader.readU16(), reader.readU16())
        }
        when (opcode) {
            DRAW_OP_BOUNDING_BOX -> drawBoundingBox(reader, target, walk)
            DRAW_OP_RECT_COPY -> drawRectCopy(reader, target, walk)
            DRAW_OP_STOCK_FONT_STRING -> drawStockText(reader, target, walk)
            DRAW_OP_IMAGE -> drawImage(reader, target, walk)
            DRAW_OP_TEXT -> drawText(reader, target, walk)
            DRAW_OP_REMAP_COLORS -> remapColors(reader, target, walk)
            DRAW_OP_ROUNDED_RECT -> drawRoundedRect(reader, target, walk)
            DRAW_OP_CLEAR -> clear(reader, target, walk)
            DRAW_OP_DISPLAY_LIST -> {
                val id = reader.readU16()
                reader.requireDone()
                executeList(id, target, walk)
            }
            else -> error("Unknown draw opcode $opcode")
        }
    }

    private fun drawBoundingBox(reader: DrawReader, target: Target, walk: Walk) {
        val flags = reader.readU8()
        require(flags and DRAW_BBOX_FLAG_U16.inv() == 0)
        val wide = flags and DRAW_BBOX_FLAG_U16 != 0
        val x = if (wide) reader.readU16() else reader.readU8() * 4
        val y = if (wide) reader.readU16() else reader.readU8() * 2
        val width = if (wide) reader.readU16() else reader.readU8() * 4
        val height = if (wide) reader.readU16() else reader.readU8() * 2
        require(width > 0 && height > 0 && x + width <= target.width && y + height <= target.height)
        val rle = ArrayByteReader(reader.readBytes(reader.remaining))
        val pixels = decodeRle(rle, width * height, true)
        if (walk.apply) {
            for (i in pixels.indices) target.put(x + i % width, y + i / width, pixels[i])
        }
    }

    private fun drawRectCopy(reader: DrawReader, target: Target, walk: Walk) {
        val id = reader.readU16()
        val x = ExtendedVarint.evaluate(reader, walk.frame)
        val y = ExtendedVarint.evaluate(reader, walk.frame)
        val width = reader.readU16()
        val height = reader.readU16()
        val dx = ExtendedVarint.evaluate(reader, walk.frame)
        val dy = ExtendedVarint.evaluate(reader, walk.frame)
        reader.requireDone()
        require(x >= 0 && y >= 0)
        val source = when (id) {
            DrawProtocol.SCREEN -> walk.screen
            DrawProtocol.CURRENT -> target
            else -> {
                walk.references.add(id)
                target(id)
            }
        }
        require(width > 0 && height > 0 && x + width <= source.width && y + height <= source.height)
        // Mirrors the firmware's overflow guard before the depth shift.
        if (walk.apply && dx in -65536..65536) {
            // Snapshot the rectangle so overlapping copies have memmove semantics.
            val copy = IntArray(width * height) { source.get(x + it % width, y + it / width) }
            for (i in copy.indices) target.put(dx + i % width, dy + i / width, copy[i])
        }
    }

    private fun drawStockText(reader: DrawReader, target: Target, walk: Walk) {
        var x = reader.readS16()
        val y = reader.readS16()
        val options = reader.readU8()
        val bytes = reader.readBytes(reader.readU8())
        reader.requireDone()
        val text = bytes.decodeToString(throwOnInvalidSequence = true)
        val codePoints = ArrayList<Int>()
        var index = 0
        while (index < text.length) {
            val char = text[index++].code
            val codePoint = if (char in 0xd800..0xdbff) {
                require(index < text.length)
                0x10000 + ((char - 0xd800) shl 10) + text[index++].code - 0xdc00
            } else {
                char
            }
            codePoints.add(codePoint)
        }
        for (i in codePoints.indices) {
            val codePoint = codePoints[i]
            if (codePoint in 1..31) {
                x += codePoint - 11
                continue
            }
            val next = codePoints.drop(i + 1).firstOrNull { it !in 1..31 } ?: 0
            val glyph = requireNotNull(builtin) { "Builtin font provider required" }(codePoint, next)
            draw(image(glyph.image), target, x + glyph.x, y + glyph.y, options, walk.apply)
            x += glyph.advance
        }
    }

    /** Mirrors the firmware: far-off image/text coordinates draw nothing (before the depth shift can overflow). */
    private fun offTarget(x: Int, y: Int) = x !in -65536..65536 || y !in -65536..65536

    private fun drawImage(reader: DrawReader, target: Target, walk: Walk) {
        val id = reader.readU16()
        val x = ExtendedVarint.evaluate(reader, walk.frame)
        val y = ExtendedVarint.evaluate(reader, walk.frame)
        val options = reader.readU8()
        reader.requireDone()
        walk.references.add(id)
        val image = image(resource(id))
        if (!offTarget(x, y)) draw(image, target, x, y, options, walk.apply)
    }

    private fun drawText(reader: DrawReader, target: Target, walk: Walk) {
        val id = reader.readU16()
        var x = ExtendedVarint.evaluate(reader, walk.frame)
        val y = ExtendedVarint.evaluate(reader, walk.frame)
        val options = reader.readU8()
        val text = reader.readBytes(reader.readU8())
        reader.requireDone()
        walk.references.add(id)
        val data = resource(id)
        require(data.size >= 193 && data[0].toInt() == CFW_RESOURCE_TYPE_FONT)
        val apply = walk.apply && !offTarget(x, y)
        for (byte in text) {
            val char = byte.toInt() and 255
            if (char in 1..31) {
                x += char - 11
                continue
            }
            require(char in 32..127)
            val offset = DrawProtocol.u16(data, 1 + (char - 32) * 2)
            require(offset >= 193)
            val glyph = image(data, offset)
            draw(glyph, target, x, y, options, apply)
            x += glyph.width
        }
    }

    private fun remapColors(reader: DrawReader, target: Target, walk: Walk) {
        val x = reader.readU16()
        val y = reader.readU16()
        val width = reader.readU16()
        val height = reader.readU16()
        val tables = reader.readBytes(16)
        reader.requireDone()
        require(width > 0 && height > 0 && x + width <= target.width && y + height <= target.height)
        if (!walk.apply) return
        for (yy in y until y + height) for (xx in x until x + width) {
            val tx = xx + target.shiftX
            if (!target.writable(tx, yy)) continue
            val value = target.get(tx, yy)
            val shift = if (value % 2 == 0) 4 else 0
            // The even-parity table comes first; parity is of the shifted target pixel.
            target.put(xx, yy, (tables[((tx + yy) and 1) * 8 + value / 2].toInt() ushr shift) and 15)
        }
    }

    private fun clear(reader: DrawReader, target: Target, walk: Walk) {
        val color = reader.readU8()
        reader.requireDone()
        require(color <= 15)
        if (!walk.apply) return
        val clip = target.clip
        if (clip == null) {
            target.bytes.fill((color * 17).toByte(), target.offset, target.offset + target.stride * target.height)
        } else {
            // Revision 35: a clipped clear fills just the clip, which is in shifted pixels already.
            for (y in maxOf(0, clip[1]) until minOf(target.height, clip[3])) {
                for (x in maxOf(0, clip[0]) until minOf(target.width, clip[2])) target.put(x - target.shiftX, y, color)
            }
        }
    }

    private fun drawRoundedRect(reader: DrawReader, target: Target, walk: Walk) {
        val x = ExtendedVarint.evaluate(reader, walk.frame)
        val y = ExtendedVarint.evaluate(reader, walk.frame)
        val width = reader.readU16()
        val height = reader.readU16()
        val radius = reader.readU16()
        val fill = reader.readU8()
        val border = reader.readU8()
        reader.requireDone()
        require(width in 1..640 && height in 1..480 && fill <= 15 && border <= DRAW_ROUNDED_RECT_NO_BORDER)
        if (!walk.apply) return
        if (x < -width - target.shiftX || x >= target.width - target.shiftX ||
            y < -height || y >= target.height) return
        for (yy in 0 until height) for (xx in 0 until width) {
            if (!roundedContains(xx, yy, width, height, radius)) continue
            val tx = x + xx + target.shiftX
            val ty = y + yy
            if (tx !in 0 until target.width || ty !in 0 until target.height) continue
            val edge = !roundedContains(xx - 1, yy - 1, width - 2, height - 2, maxOf(0, radius - 1))
            val value = if (edge && border < DRAW_ROUNDED_RECT_NO_BORDER) border else maxOf(fill, target.get(tx, ty))
            target.put(x + xx, ty, value)
        }
    }
}
