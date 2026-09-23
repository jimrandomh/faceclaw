package com.faceclaw.app

/** A retained selection or image, replayed at stereo depth over the screen and shell surfaces. */
class MenuSelection(val x: Int, val y: Int, val width: Int, val height: Int, val radius: Int,
    val background: Int, val border: Int, val depth: Int, val packed: ByteArray, val occlusions: List<IntArray> = emptyList(), val kind: Int = 3, val mask: List<IntArray> = emptyList(), val animation: Animation? = null) {
    class Animation(val dx: Int, val dy: Int, val startedAt: Long, val token: Int)
    val resource = CachedResource(DrawProtocol.rawImage(width, height, packed))
    val fingerprint = "${animation?.token},${animation?.dx},${animation?.dy},$kind,${mask.joinToString { it.joinToString() }},$x,$y,$width,$height,$radius,$background,$border,$depth,${resource.hash},${occlusions.joinToString { it.joinToString() }}"
    fun translated(dx: Int, dy: Int) = MenuSelection(x + dx, y + dy, width, height, radius, background, border, depth, packed, occlusions.map { intArrayOf(it[0] + dx, it[1] + dy, it[2], it[3]) }, kind, mask, animation)
    fun calls(id: Int, nowMs: Long = drawAnimationTimeMs()): List<ByteArray> {
        val elapsed = animation?.let { (nowMs - it.startedAt).coerceIn(0, 500).toInt() } ?: 500
        val highlightX = animation?.let { DrawValue.animate(x + it.dx, x, 500, elapsed) } ?: DrawValue.Integer(x)
        val highlightY = animation?.let { DrawValue.animate(y + it.dy, y, 500, elapsed) } ?: DrawValue.Integer(y)
        val image = when (kind) {
            3 -> listOf(DrawProtocol.roundedRect(highlightX, highlightY, width, height, radius, background, border, depth),
                DrawProtocol.image(id, x, y, CFW_TEXTURE_OPT_BRIGHTNESS_MASK or CFW_TEXTURE_OPT_TRANSPARENT, depth = depth))
            4 -> listOf(DrawProtocol.image(id, x, y, CFW_TEXTURE_OPT_BRIGHTNESS_MASK or CFW_TEXTURE_OPT_TRANSPARENT, depth = depth))
            // Gray8 zero is transparent but gray8 one is opaque black. Rect copies preserve
            // that distinction after packing, including the transparent corners of app menus.
            5 -> mask.map { rect ->
                DrawProtocol.rectCopy(id, rect[0], rect[1], rect[2], rect[3],
                    x + rect[0], y + rect[1], depth = depth)
            }
            else -> error("Invalid presentation kind")
        }
        return image + occlusions.map { rect ->
            DrawProtocol.rectCopy(DrawProtocol.SCREEN, rect[0], rect[1], rect[2], rect[3], rect[0], rect[1])
        }
    }

    companion object {
        /** The caller has consumed the presentation tag (3–6). Colors cross the bridge in gray8, pixels in gray8 rows. */
        fun read(reader: ByteReader, kind: Int = 3): MenuSelection {
            require(kind in 3..6)
            require(reader.remaining() >= 15)
            val x = reader.getShort().toInt(); val y = reader.getShort().toInt()
            val w = reader.getShort().toInt() and 65535; val h = reader.getShort().toInt() and 65535
            val radius = reader.getShort().toInt() and 65535
            val background = BmpUtil.nibbleForGray(reader.get() and 255)
            val border = BmpUtil.nibbleForGray(reader.get() and 255)
            val depth = reader.get().toByte().toInt()
            val count = reader.getShort().toInt() and 65535
            require(count <= 2048)
            require(w in 1..640 && h in 1..480 && 5 + (w + 1) / 2 * h <= 65536 && reader.remaining() >= w * h)
            val animation = if (kind == 6) {
                require(reader.remaining() >= 10)
                val dx = reader.getShort().toInt()
                val dy = reader.getShort().toInt()
                val elapsed = reader.getShort().toInt() and 65535
                require(elapsed <= 500)
                Animation(dx, dy, drawAnimationTimeMs() - elapsed, reader.getInt())
            } else null
            val gray = ByteArray(w * h); reader.get(gray)
            require(reader.remaining() >= count * 8)
            val occlusions = List(count) { IntArray(4) { reader.getShort().toInt() and 65535 } }
            val mask = ArrayList<IntArray>()
            if (kind == 5) for (yy in 0 until h) {
                var start = -1
                for (xx in 0..w) {
                    val covered = xx < w && gray[yy * w + xx].toInt() != 0
                    if (covered && start < 0) start = xx
                    if (!covered && start >= 0) {
                        val previous = mask.lastOrNull { it[0] == start && it[2] == xx - start && it[1] + it[3] == yy }
                        if (previous != null) previous[3]++ else mask.add(intArrayOf(start, yy, xx - start, 1))
                        start = -1
                    }
                }
            }
            return MenuSelection(x, y, w, h, radius, background, border, depth, BmpUtil.pack4bppFromGray8(gray, w, h), occlusions, if (kind == 6) 3 else kind, mask, animation)
        }
    }
}
