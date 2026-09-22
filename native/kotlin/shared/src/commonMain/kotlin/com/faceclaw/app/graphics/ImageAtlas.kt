package com.faceclaw.app

import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic

/**
 * Process-wide registry of icon/image rasters for the resource-cache pipeline, the image counterpart
 * of GlyphAtlas. Entries are content-addressed: the TS side keys each image by a hash of its
 * dimensions and pixels, so the same icon registered from any thread or rendered at any time
 * dedupes to one entry, and an icon whose content changes is simply a new entry.
 *
 * Unlike glyphs (1-bit ink recolored at draw time), images keep their exact 4bpp values: the cached
 * bytes quantize the registered 8bpp pixels with the same GRAY_TO_NIBBLE table the composite is
 * packed with, and the planner draws them via the image draw call with an identity LUT (top color 15) and the
 * transparent bit — the draw writes exactly the nonzero-nibble pixels, which is what the
 * eligibility check and hole punching are defined over.
 */
class ImageAtlas {
    companion object {
        private val lock = protocolPlatform().createLock()

        private val ids: MutableMap<String, Int> = HashMap()

        private val entries: MutableList<Entry> = ArrayList()

        /**
         * Register an image (8bpp grayscale pixels, width*height bytes, row-major) under a content
         * key, returning its id — or the existing id when the key is already registered (the pixels
         * are then ignored: same key means same content). Ids are positive and stable for the
         * process lifetime.
         */
        @JvmStatic
        fun ensure(key: String?, width: Int, height: Int, pixels8bpp: ByteReader?): Int {
            if (
                (((((((key == null) || (width <= 0)) || (width > 255)) || (height <= 0)) ||
                    (height > 255)) || (pixels8bpp == null)) ||
                    (pixels8bpp.remaining() < (width * height)))
            ) {
                throw IllegalArgumentException(
                    ((("bad image registration " + width) + "x") + height)
                )
            }
            lock.withLock {
                var existing: Int? = ids.get(key)
                if ((existing != null)) {
                    return existing
                }
                var nibbles: ByteArray = ByteArray((width * height))
                run {
                    var i: Int = 0
                    while ((i < nibbles.size)) {
                        nibbles[i] = (BmpUtil.nibbleForGray((pixels8bpp.get(i) and 0xff))).toByte()
                        i++
                    }
                }
                entries.add(Entry(width, height, nibbles))
                var id: Int = entries.size
                ids.put(key, id)
                return id
            }
        }

        @JvmStatic
        fun get(id: Int): Entry? {
            lock.withLock {
                return (if (((id >= 1) && (id <= entries.size))) entries.get((id - 1)) else null)
            }
        }
    }

    constructor() {}

    class Entry {
        @JvmField val width: Int

        @JvmField val height: Int

        /** One 4bpp value per pixel, row-major. */
        @JvmField val nibbles: ByteArray

        /** CFW cached-image bytes: [flags=RLE][w][h][RLE(w*h pixels)]. */
        @JvmField val cachedBytes: ByteArray

        val resource: CachedResource

        constructor(width: Int, height: Int, nibbles: ByteArray) {
            this.width = width
            this.height = height
            this.nibbles = nibbles
            this.cachedBytes = encodeCachedImage()
            this.resource = CachedResource(cachedBytes)
        }

        /** The 4bpp value the mode-13 draw would write at (col, row); 0 = skipped. */
        fun nibbleAt(col: Int, row: Int): Int {
            return (nibbles[((row * width) + col)] and 0xff)
        }

        private fun encodeCachedImage(): ByteArray {
            var total: Int = (width * height)
            var out: ByteArray = ByteArray((3 + total))
            out[0] = DrawProtocol.RLE.toByte()
            out[1] = (width).toByte()
            out[2] = (height).toByte()
            var o: Int = 3
            var i: Int = 0
            while ((i < total)) {
                var color: Int = (nibbles[i] and 0xff)
                var j: Int = (i + 1)
                while (((j < total) && ((nibbles[j] and 0xff) == color))) {
                    j++
                }
                var run: Int = (j - i)
                while ((run > 0)) {
                    var c: Int = minOf(run, 0xffff)
                    if ((c <= 15)) {
                        out[o++] = (((c shl 4) or color)).toByte()
                    } else {
                        if ((c <= 255)) {
                            out[o++] = (color).toByte()
                            out[o++] = (c).toByte()
                        } else {
                            out[o++] = (color).toByte()
                            out[o++] = 0
                            out[o++] = ((c and 0xff)).toByte()
                            out[o++] = ((c shr 8)).toByte()
                        }
                    }
                    run -= c
                }
                i = j
            }
            var trimmed: ByteArray = ByteArray(o)
            out.copyInto(trimmed, 0, 0, 0 + o)
            return trimmed
        }
    }
}
