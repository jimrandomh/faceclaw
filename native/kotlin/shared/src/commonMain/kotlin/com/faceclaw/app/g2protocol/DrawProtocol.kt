package com.faceclaw.app

/** Revision 26 wire grammar, shared by scene planning and the local renderer. */
object DrawProtocol {
    const val DRAW = 26
    const val ROOT = 27
    const val PRESENT = 28
    const val CREATE = 29
    const val IMAGE = 0
    const val FONT = 1
    const val LIST = 2
    const val LARGE = 4
    const val RLE = 8
    const val SCREEN = 65535
    const val CURRENT = 65534
    fun u16(b: ByteArray, p: Int): Int = (b[p].toInt() and 255) or ((b[p + 1].toInt() and 255) shl 8)
    fun word(n: Int) = byteArrayOf(n.toByte(), (n ushr 8).toByte())
    fun call(op: Int, args: ByteArray, target: Int? = null, depth: Int? = null): ByteArray {
        require(depth == null || depth in -128..127)
        val flags = (if (target == null) 0 else 1) or (if (depth == null) 0 else 2)
        return byteArrayOf(op.toByte(), flags.toByte()) + (target?.let { word(it) } ?: byteArrayOf()) +
            (depth?.let { byteArrayOf(it.toByte()) } ?: byteArrayOf()) + args
    }
    fun depthOffset(depth: Int, right: Boolean): Int =
        if (right) -floorHalf(depth + 1) else floorHalf(depth)
    private fun floorHalf(n: Int): Int = if (n < 0) (n - 1) / 2 else n / 2
    fun roundedRect(x: Int, y: Int, width: Int, height: Int, radius: Int, background: Int, border: Int = 16, depth: Int? = null): ByteArray {
        require(width in 1..640 && height in 1..480 && radius in 0..65535 && background in 0..15 && border in 0..16)
        return call(8, word(x) + word(y) + word(width) + word(height) + word(radius) + byteArrayOf(background.toByte(), border.toByte()), depth = depth)
    }
    fun sequence(calls: List<ByteArray>): ByteArray {
        require(calls.size <= 4096)
        val out = ByteSink(); out.write(word(calls.size))
        for (call in calls) { require(call.size <= 65535); out.write(word(call.size)); out.write(call) }
        return out.toByteArray()
    }
    fun message(calls: List<ByteArray>) = byteArrayOf(DRAW.toByte()) + sequence(calls)
    fun displayList(calls: List<ByteArray>) = byteArrayOf(LIST.toByte()) + sequence(calls)
    fun root(id: Int) = byteArrayOf(ROOT.toByte()) + word(id)
    fun image(id: Int, x: Int, y: Int, options: Int = 15, target: Int? = null, depth: Int? = null) =
        call(4, word(id) + word(x) + word(y) + byteArrayOf(options.toByte()), target, depth)
    fun lut(width: Int, height: Int, factor: Int): ByteArray {
        val table = ByteArray(8) { i ->
            (((i * 2 * factor / 256).coerceIn(0, 15) shl 4) or ((i * 2 + 1) * factor / 256).coerceIn(0, 15)).toByte()
        }
        return call(6, word(0) + word(0) + word(width) + word(height) + table)
    }
    fun rawImage(width: Int, height: Int, pixels: ByteArray = ByteArray(((width + 1) / 2) * height)): ByteArray {
        require(width in 1..640 && height in 1..480 && pixels.size == ((width + 1) / 2) * height)
        val result = byteArrayOf(LARGE.toByte()) + word(width) + word(height) + pixels
        require(result.size <= ResourceCacheState.MAX_RESOURCE_SIZE)
        return result
    }
    /** Packed rows -> RLE of exactly width*height pixels, omitting odd-row padding. */
    fun bbox(packed: ByteArray, stride: Int, x: Int, y: Int, width: Int, height: Int, target: Int? = null): ByteArray {
        val compact = x % 4 == 0 && y % 2 == 0 && width % 4 == 0 && height % 2 == 0 && x / 4 < 256 && y / 2 < 256 && width / 4 < 256 && height / 2 < 256
        val header = if (compact) byteArrayOf(0, (x / 4).toByte(), (y / 2).toByte(), (width / 4).toByte(), (height / 2).toByte())
            else byteArrayOf(1) + word(x) + word(y) + word(width) + word(height)
        val out = ByteSink(); out.write(header)
        var color = -1; var count = 0
        fun flush() {
            if (count == 0) return
            if (count <= 15) out.write((count shl 4) or color)
            else { out.write(color); if (count <= 255) out.write(count) else { out.write(0); out.write(word(count)) } }
        }
        for (yy in y until y + height) for (xx in x until x + width) {
            val value = (packed[yy * stride + xx / 2].toInt() ushr (if (xx % 2 == 0) 4 else 0)) and 15
            if (value != color || count == 65535) { flush(); color = value; count = 0 }
            count++
        }
        flush()
        return call(1, out.toByteArray(), target)
    }
    /** Internal optimizer formats are translated here; they are never sent to revision 26. */
    fun fromOptimized(payload: ByteArray, width: Int = 640, height: Int = 480): List<ByteArray> {
        return when (val mode = payload[0].toInt() and 127) {
            8 -> {
                val result = ArrayList<ByteArray>(); var pos = 2
                repeat(payload[1].toInt() and 255) { val n = u16(payload, pos); pos += 2; result.addAll(fromOptimized(payload.copyOfRange(pos, pos + n), width, height)); pos += n }
                require(pos == payload.size); result
            }
            3 -> listOf(call(1, byteArrayOf(0) + payload.copyOfRange(1, 5) + payload.copyOfRange(7, payload.size)))
            6 -> listOf(call(1, byteArrayOf(1) + word(0) + word(0) + word(width) + word(height) + payload.copyOfRange(1, payload.size)))
            15 -> listOf(call(3, payload.copyOfRange(1, payload.size)))
            19 -> listOf(call(4, payload.copyOfRange(1, payload.size)))
            20 -> listOf(call(5, payload.copyOfRange(1, payload.size)))
            9 -> listOf(call(2, word(CURRENT) + payload.copyOfRange(1, 9) + payload.copyOfRange(9, 13)))
            else -> error("Unsupported internal draw format $mode")
        }
    }
    fun messages(calls: List<ByteArray>, maxBytes: Int = 65535): List<ByteArray> {
        val result = ArrayList<ByteArray>(); var batch = ArrayList<ByteArray>(); var size = 3
        for (call in calls) {
            require(call.size + 5 <= maxBytes)
            if (size + 2 + call.size > maxBytes) { result.add(message(batch)); batch = ArrayList(); size = 3 }
            batch.add(call); size += call.size + 2
        }
        if (batch.isNotEmpty()) result.add(message(batch))
        return result
    }
}
