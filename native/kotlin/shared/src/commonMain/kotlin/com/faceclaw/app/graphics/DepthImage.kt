package com.faceclaw.app

/**
 * A retained image, replayed at stereo depth over the screen and shell surfaces. A
 * [DrawRecordKind.TRANSPARENT_IMAGE] skips level-0 pixels; a [DrawRecordKind.MASKED_IMAGE]
 * keeps opaque black, copying only [mask]'s rects. [occlusions] are screen rects that later
 * opaque planes cover, copied back from the screen after the image.
 */
class DepthImage(val x: Int, val y: Int, val width: Int, val height: Int, val depth: Int, val packed: ByteArray,
    val occlusions: List<IntArray> = emptyList(), val kind: Int = DrawRecordKind.TRANSPARENT_IMAGE,
    val mask: List<IntArray> = emptyList(),
    /** [packed] as a raw-image resource; translated copies share it (and its hash) instead of rebuilding it. */
    val resource: CachedResource = CachedResource(DrawProtocol.rawImage(width, height, packed))) : RetainedDrawing {
    init { require(kind == DrawRecordKind.TRANSPARENT_IMAGE || kind == DrawRecordKind.MASKED_IMAGE) }
    override val resources = listOf(resource)
    override val fingerprint: String by lazy {
        "$kind,${mask.joinToString { it.joinToString() }},$x,$y,$width,$height,$depth,${resource.hash},${occlusions.joinToString { it.joinToString() }}"
    }
    override fun translated(dx: Int, dy: Int) = if (dx == 0 && dy == 0) this else DepthImage(x + dx, y + dy, width, height, depth, packed, occlusions.map { intArrayOf(it[0] + dx, it[1] + dy, it[2], it[3]) }, kind, mask, resource)
    override fun calls(ids: IntArray, nowMs: Long) = calls(ids.single())
    fun calls(id: Int): List<ByteArray> {
        val image = if (kind == DrawRecordKind.TRANSPARENT_IMAGE)
            listOf(DrawProtocol.image(id, x, y, CFW_TEXTURE_OPT_BRIGHTNESS_MASK or CFW_TEXTURE_OPT_TRANSPARENT, depth = depth))
        // Gray8 zero is transparent but gray8 one is opaque black. Rect copies preserve
        // that distinction after packing, including the transparent corners of app menus.
        else mask.map { rect ->
            DrawProtocol.rectCopy(id, rect[0], rect[1], rect[2], rect[3], x + rect[0], y + rect[1], depth = depth)
        }
        return image + occlusions.map { rect ->
            DrawProtocol.rectCopy(DrawProtocol.SCREEN, rect[0], rect[1], rect[2], rect[3], rect[0], rect[1])
        }
    }

    companion object {
        /** Mirrors presentation-wire.ts: x, y, width, height, depth and the occlusion count. */
        private const val HEADER_BYTES = 11
        private const val MAX_OCCLUSIONS = 2048

        /**
         * The caller has consumed the [DrawRecordKind] tag. Pixels cross in gray8:
         * `[x i16][y i16][w u16][h u16][depth i8][occlusions u16][w*h gray8]{x,y,w,h u16}`.
         */
        fun read(reader: ByteReader, kind: Int): DepthImage {
            require(kind == DrawRecordKind.TRANSPARENT_IMAGE || kind == DrawRecordKind.MASKED_IMAGE)
            require(reader.remaining() >= HEADER_BYTES)
            val x = reader.getShort().toInt(); val y = reader.getShort().toInt()
            val w = reader.getShort().toInt() and 65535; val h = reader.getShort().toInt() and 65535
            val depth = reader.get().toInt()
            val count = reader.getShort().toInt() and 65535
            require(count <= MAX_OCCLUSIONS)
            require(w in 1..640 && h in 1..480 && 5 + (w + 1) / 2 * h <= ResourceCacheState.MAX_RESOURCE_SIZE && reader.remaining() >= w * h)
            val gray = ByteArray(w * h); reader.get(gray)
            require(reader.remaining() >= count * 8)
            val occlusions = List(count) { IntArray(4) { reader.getShort().toInt() and 65535 } }
            val mask = ArrayList<IntArray>()
            if (kind == DrawRecordKind.MASKED_IMAGE) for (yy in 0 until h) {
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
            return DepthImage(x, y, w, h, depth, BmpUtil.pack4bppFromGray8(gray, w, h), occlusions, kind, mask)
        }
    }
}
