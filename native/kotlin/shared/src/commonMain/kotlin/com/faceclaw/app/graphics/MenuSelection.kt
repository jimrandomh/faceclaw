package com.faceclaw.app

/** A retained selection or image, replayed at stereo depth over the screen and shell surfaces. */
class MenuSelection(val x: Int, val y: Int, val width: Int, val height: Int, val radius: Int,
    val background: Int, val border: Int, val depth: Int, val packed: ByteArray, val occlusions: List<IntArray> = emptyList(), val kind: Int = 3, val mask: List<IntArray> = emptyList()) {
    val resource = CachedResource(DrawProtocol.rawImage(width, height, packed))
    val fingerprint = "$kind,${mask.joinToString { it.joinToString() }},$x,$y,$width,$height,$radius,$background,$border,$depth,${resource.hash},${occlusions.joinToString { it.joinToString() }}"
    fun translated(dx: Int, dy: Int) = MenuSelection(x + dx, y + dy, width, height, radius, background, border, depth, packed, occlusions.map { intArrayOf(it[0] + dx, it[1] + dy, it[2], it[3]) }, kind, mask)
    fun calls(id: Int): List<ByteArray> {
        val image = when (kind) {
            3 -> listOf(DrawProtocol.roundedRect(x, y, width, height, radius, background, border, depth),
                DrawProtocol.image(id, x, y, CFW_TEXTURE_OPT_BRIGHTNESS_MASK or CFW_TEXTURE_OPT_TRANSPARENT, depth = depth))
            4 -> listOf(DrawProtocol.image(id, x, y, CFW_TEXTURE_OPT_BRIGHTNESS_MASK or CFW_TEXTURE_OPT_TRANSPARENT, depth = depth))
            // Gray8 zero is transparent but gray8 one is opaque black. Rect copies preserve
            // that distinction after packing, including the transparent corners of app menus.
            5 -> mask.map { r -> DrawProtocol.call(DRAW_OP_RECT_COPY, DrawProtocol.word(id) +
                r.flatMap { DrawProtocol.word(it).toList() }.toByteArray() +
                DrawProtocol.word(x + r[0]) + DrawProtocol.word(y + r[1]), depth = depth) }
            else -> error("Invalid presentation kind")
        }
        return image + occlusions.map { r -> DrawProtocol.call(DRAW_OP_RECT_COPY, DrawProtocol.word(DrawProtocol.SCREEN) + r.flatMap { DrawProtocol.word(it).toList() }.toByteArray() + DrawProtocol.word(r[0]) + DrawProtocol.word(r[1])) }
    }
    companion object {
        /** The caller has consumed the presentation tag (3, 4 or 5). Colors cross the bridge in gray8, pixels in gray8 rows. */
        fun read(reader: ByteReader, kind: Int = 3): MenuSelection {
            require(kind in 3..5)
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
            return MenuSelection(x, y, w, h, radius, background, border, depth, BmpUtil.pack4bppFromGray8(gray, w, h), occlusions, kind, mask)
        }
    }
}
