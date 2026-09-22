package com.faceclaw.app

/** Reference interpreter. It uses the firmware's packed rows, clipping, LUT and call grammar. */
class DisplayListRenderer(private val resources: Map<Int, ByteArray>, private val builtin: ((Int, Int) -> BuiltinGlyph)? = null, private val rightLens: Boolean = false) {
    class BuiltinGlyph(val image: ByteArray, val advance: Int, val x: Int = 0, val y: Int = 0)
    class Target(val bytes: ByteArray, val width: Int, val height: Int, val offset: Int = 0, val shiftX: Int = 0) {
        val stride = (width + 1) / 2
        init { require(width > 0 && height > 0 && offset >= 0 && bytes.size - offset >= stride * height) }
        fun get(x: Int, y: Int) = (bytes[offset + y * stride + x / 2].toInt() ushr (if (x % 2 == 0) 4 else 0)) and 15
        fun shifted(dx: Int) = Target(bytes, width, height, offset, shiftX + dx)
        fun put(localX: Int, y: Int, v: Int) {
            val x = localX + shiftX
            if (x !in 0 until width || y !in 0 until height) return
            val index = offset + y * stride + x / 2; val old = bytes[index].toInt()
            bytes[index] = (if (x % 2 == 0) (old and 15) or (v shl 4) else (old and 240) or v).toByte()
        }
    }
    private fun roundedContains(x: Int, y: Int, w: Int, h: Int, radius: Int): Boolean {
        if (x !in 0 until w || y !in 0 until h) return false
        val r = minOf(radius, w / 2, h / 2)
        val dx = maxOf(0, 2 * r - (2 * minOf(x, w - 1 - x) + 1))
        val dy = maxOf(0, 2 * r - (2 * minOf(y, h - 1 - y) + 1))
        return dx * dx + dy * dy <= 4 * r * r
    }
    private class Image(val width: Int, val height: Int, val pixels: IntArray)
    private fun word(b: ByteArray, p: Int): Int { require(p >= 0 && p + 2 <= b.size); return DrawProtocol.u16(b, p) }
    private fun signed(b: ByteArray, p: Int) = word(b, p).toShort().toInt()
    private fun resource(id: Int) = requireNotNull(resources[id]) { "Missing resource $id" }
    private fun decodeRle(b: ByteArray, start: Int, count: Int, exact: Boolean): IntArray {
        var p = start; var i = 0; val result = IntArray(count)
        while (i < count) {
            require(p < b.size); val token = b[p++].toInt() and 255; var n = token ushr 4
            if (n == 0) { require(p < b.size); n = b[p++].toInt() and 255
                if (n == 0) { n = word(b, p); p += 2 } }
            require(n > 0 && n <= count - i); result.fill(token and 15, i, i + n); i += n
        }
        require(!exact || p == b.size)
        return result
    }
    private fun image(b: ByteArray, start: Int = 0): Image {
        require(start in b.indices); val flags = b[start].toInt() and 255
        require(flags and 12 == flags)
        val header = if (flags and 4 != 0) 5 else 3
        require(b.size - start >= header)
        val w = if (header == 5) word(b, start + 1) else b[start + 1].toInt() and 255
        val h = if (header == 5) word(b, start + 3) else b[start + 2].toInt() and 255
        require(w in 1..640 && h in 1..480)
        val pixels = if (flags and 8 != 0) decodeRle(b, start + header, w * h, false)
            else { val t = Target(b, w, h, start + header); IntArray(w * h) { t.get(it % w, it / w) } }
        return Image(w, h, pixels)
    }
    private fun target(id: Int): Target {
        val b = resource(id); require(b.isNotEmpty() && b[0].toInt() and 11 == 0)
        image(b) // Validate the complete raw image before exposing a write target.
        return if (b[0].toInt() and 4 != 0) Target(b, word(b, 1), word(b, 3), 5)
            else Target(b, b[1].toInt() and 255, b[2].toInt() and 255, 3)
    }
    private fun draw(image: Image, target: Target, x: Int, y: Int, options: Int, apply: Boolean) {
        if (!apply) return
        for (i in image.pixels.indices) {
            val v = image.pixels[i]; if (v == 0 && options and 16 != 0) continue
            val source = if (options and 32 != 0) 15 - v else v
            target.put(x + i % image.width, y + i / image.width, source * (options and 15) / 15)
        }
    }
    /** Validate the whole graph before changing any pixels. Resource writes remain call-scoped. */
    fun render(root: Int, screen: Target, composition: Target): Set<Int> {
        val references = mutableSetOf<Int>()
        for (apply in listOf(false, true)) {
            if (apply) for (y in 0 until screen.height) for (x in 0 until screen.width) composition.put(x, y, screen.get(x, y))
            if (root != DrawProtocol.SCREEN) executeList(root, composition, screen, apply, mutableListOf(), intArrayOf(4096), references)
        }
        return references
    }
    fun execute(sequence: ByteArray, target: Target, screen: Target = target): Set<Int> {
        val references = mutableSetOf<Int>()
        for (apply in listOf(false, true)) executeSequence(sequence, target, screen, apply, mutableListOf(), intArrayOf(4096), references)
        return references
    }
    private fun executeList(id: Int, t: Target, screen: Target, apply: Boolean, stack: MutableList<Int>, budget: IntArray, refs: MutableSet<Int>) {
        require(stack.size < 8 && id !in stack); val b = resource(id); require(b.size >= 3 && b[0].toInt() == 2)
        refs.add(id); stack.add(id); executeSequence(b.copyOfRange(1, b.size), t, screen, apply, stack, budget, refs); stack.removeAt(stack.lastIndex)
    }
    private fun executeSequence(b: ByteArray, inherited: Target, screen: Target, apply: Boolean, stack: MutableList<Int>, budget: IntArray, refs: MutableSet<Int>) {
        val count = word(b, 0); var pos = 2
        repeat(count) {
            val n = word(b, pos); pos += 2; require(n >= 2 && n <= b.size - pos && budget[0]-- > 0)
            val call = b.copyOfRange(pos, pos + n); pos += n
            val flags = call[1].toInt() and 255; require(flags <= 3)
            var t = inherited; var header = 2
            if (flags and 1 != 0) { val id = word(call, 2); refs.add(id); t = target(id).shifted(inherited.shiftX); header += 2 }
            if (flags and 2 != 0) { require(header < call.size); t = t.shifted(DrawProtocol.depthOffset(call[header++].toInt(), rightLens)) }
            val p = call.copyOfRange(header, call.size)
            when (call[0].toInt()) {
                1 -> {
                    require(p.isNotEmpty() && p[0].toInt() in 0..1); val wide = p[0].toInt() == 1
                    require(p.size >= if (wide) 9 else 5)
                    val x = if (wide) word(p, 1) else (p[1].toInt() and 255) * 4
                    val y = if (wide) word(p, 3) else (p[2].toInt() and 255) * 2
                    val w = if (wide) word(p, 5) else (p[3].toInt() and 255) * 4
                    val h = if (wide) word(p, 7) else (p[4].toInt() and 255) * 2
                    require(w > 0 && h > 0 && x + w <= t.width && y + h <= t.height)
                    val pixels = decodeRle(p, if (wide) 9 else 5, w * h, true)
                    if (apply) for (i in pixels.indices) t.put(x + i % w, y + i / w, pixels[i])
                }
                2 -> {
                    require(p.size == 14); val id = word(p, 0)
                    val src = when(id) { DrawProtocol.SCREEN -> screen; DrawProtocol.CURRENT -> t; else -> { refs.add(id); target(id) } }
                    val x = word(p, 2); val y = word(p, 4); val w = word(p, 6); val h = word(p, 8)
                    require(w > 0 && h > 0 && x + w <= src.width && y + h <= src.height)
                    val dx = signed(p, 10); val dy = signed(p, 12)
                    if (apply) { val copy = IntArray(w * h) { src.get(x + it % w, y + it / w) }
                        for (i in copy.indices) t.put(dx + i % w, dy + i / w, copy[i]) }
                }
                3 -> {
                    require(p.size >= 6 && p.size == 6 + (p[5].toInt() and 255))
                    val text = p.copyOfRange(6, p.size).decodeToString(throwOnInvalidSequence = true)
                    val cps = ArrayList<Int>(); var i = 0
                    while (i < text.length) { val c = text[i++].code
                        cps.add(if (c in 0xd800..0xdbff) { require(i < text.length); 0x10000 + ((c - 0xd800) shl 10) + text[i++].code - 0xdc00 } else c) }
                    var x = signed(p, 0); val y = signed(p, 2)
                    for (j in cps.indices) { val cp = cps[j]
                        if (cp in 1..31) { x += cp - 11; continue }
                        val next = cps.drop(j + 1).firstOrNull { it !in 1..31 } ?: 0
                        val g = requireNotNull(builtin) { "Builtin font provider required" }(cp, next)
                        draw(image(g.image), t, x + g.x, y + g.y, p[4].toInt() and 255, apply); x += g.advance
                    }
                }
                4, 5 -> {
                    val font = call[0].toInt() == 5; require(if(font) p.size >= 8 && p.size == 8 + (p[7].toInt() and 255) else p.size == 7)
                    val id = word(p, 0); refs.add(id); val data = resource(id)
                    var x = signed(p, 2); val y = signed(p, 4); val options = p[6].toInt() and 255
                    if (!font) draw(image(data), t, x, y, options, apply)
                    else { require(data.size >= 193 && data[0].toInt() == 1)
                        for (j in 8 until p.size) { val ch = p[j].toInt() and 255
                            if(ch in 1..31) { x += ch - 11; continue }; require(ch in 32..127)
                            val offset = word(data, 1 + (ch - 32) * 2); require(offset >= 193)
                            val glyph = image(data, offset); draw(glyph, t, x, y, options, apply); x += glyph.width
                        }
                    }
                }
                6 -> {
                    require(p.size == 16); val x = word(p, 0); val y = word(p, 2); val w = word(p, 4); val h = word(p, 6)
                    require(w > 0 && h > 0 && x + w <= t.width && y + h <= t.height)
                    if (apply) for(yy in y until y + h) for(xx in x until x + w) {
                        if (xx + t.shiftX !in 0 until t.width) continue
                        val v = t.get(xx + t.shiftX, yy)
                        t.put(xx, yy, (p[8 + v / 2].toInt() ushr (if(v % 2 == 0) 4 else 0)) and 15) }
                }
                8 -> {
                    require(p.size == 12)
                    val x = signed(p, 0); val y = signed(p, 2); val w = word(p, 4); val h = word(p, 6)
                    val radius = word(p, 8); val fill = p[10].toInt() and 255; val border = p[11].toInt() and 255
                    require(w in 1..640 && h in 1..480 && fill <= 15 && border <= 16)
                    if (apply) for (yy in 0 until h) for (xx in 0 until w) {
                        if (!roundedContains(xx, yy, w, h, radius)) continue
                        val tx = x + xx + t.shiftX; val ty = y + yy
                        if (tx !in 0 until t.width || ty !in 0 until t.height) continue
                        val edge = !roundedContains(xx - 1, yy - 1, w - 2, h - 2, maxOf(0, radius - 1))
                        t.put(x + xx, ty, if (edge && border < 16) border else maxOf(fill, t.get(tx, ty)))
                    }
                }
                7 -> { require(p.size == 2); executeList(word(p, 0), t, screen, apply, stack, budget, refs) }
                else -> error("Unknown draw opcode")
            }
        }
        require(pos == b.size)
    }
}
