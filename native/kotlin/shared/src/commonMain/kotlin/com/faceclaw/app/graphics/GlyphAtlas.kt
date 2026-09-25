package com.faceclaw.app

import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic

/**
 * Process-wide registry of glyph rasters, fed from the TS side so glyph identity survives to the
 * BLE encoder (see notes/texture-cache-display-list- design.md). A frame's glyph list references
 * entries here by (fontId, encoding); the resource-cache planner uses the raster three ways:
 *
 * - as the ink mask for the "would this draw land correctly" check against the composited frame,
 * - to punch the ink pixels out of the baked delta rect it replaces,
 * - pre-encoded as the CFW cached-image bytes ([flags=RLE][w][h][4bpp RLE]) uploaded as resources and drawn via
 *   the resource-text draw call with a top-color LUT. 1bpp (BDF) glyphs store ink at 15 so the LUT maps them to exactly
 *   the requested level; AA (TTF) glyphs store true coverage nibbles the LUT scales.
 *
 * Fonts are identified by a stable string key (the embedded font name), NOT a per-JS-context
 * counter: worker threads register independently and must agree on ids. Glyph rasters are immutable
 * once registered; re-registration of the same (fontId, encoding) is ignored.
 *
 * Cell model: a cached glyph image is bbxWidth x cellHeight (the font's line height), with the ink
 * rows at inkTop — so every glyph of a line is drawn at the same y (the line top), which is what
 * lets one mode-14 string carry a whole run. The horizontal bearing (bbxX) is applied phone-side
 * when computing the draw x. Vertical padding is nearly free: it RLE-encodes to a couple of tokens.
 */
class GlyphAtlas {
    companion object {
        private val lock = protocolPlatform().createLock()

        private val fontIds: MutableMap<String, Int> = HashMap()

        private val glyphs: MutableMap<Long, Glyph> = HashMap()

        private var nextFontId: Int = 1

        /** Stable id for a font key; assigns one on first use. */
        @JvmStatic
        fun fontId(key: String): Int {
            lock.withLock {
                var id: Int? = fontIds.get(key)
                if ((id == null)) {
                    id = nextFontId++
                    fontIds.put(key, id)
                }
                return id
            }
        }

        @JvmStatic
        fun get(fontId: Int, encoding: Int): Glyph? {
            lock.withLock {
                return glyphs.get(key(fontId, encoding))
            }
        }

        private fun key(fontId: Int, encoding: Int): Long {
            return (((fontId).toLong() shl 32) or (encoding.toLong() and 0xffffffffL))
        }

        /**
         * Register a batch of glyph rasters. Little-endian buffer, a sequence of font groups:
         * [keyLen u8][key utf8][cellHeight u8][count u16] each followed by count glyph records:
         * [encoding u32][bbxX s8][inkTop u8][width u8][inkHeight u8] [inkHeight x rows u32] (bit
         * (ceil(width/8)*8 - 1 - col) = ink) Records for an already-registered (font, encoding) are
         * skipped (glyph rasters are immutable for a given font key). Malformed buffers throw: they
         * indicate a phone-side marshalling bug, never device state.
         */
        @JvmStatic
        fun register(buffer: ByteReader?): Unit {
            if ((buffer == null)) {
                return
            }
            val cursor: ByteReader = buffer
            lock.withLock {
                while ((cursor.remaining() > 0)) {
                    var keyLen: Int = (cursor.get() and 0xff)
                    var keyBytes: ByteArray = ByteArray(keyLen)
                    cursor.get(keyBytes)
                    var fontKey: String = keyBytes.decodeToString()
                    var cellHeight: Int = (cursor.get() and 0xff)
                    var count: Int = (cursor.getShort().toInt() and 0xffff)
                    var idBoxed: Int? = fontIds.get(fontKey)
                    var id: Int = 0
                    if ((idBoxed == null)) {
                        id = nextFontId++
                        fontIds.put(fontKey, id)
                    } else {
                        id = idBoxed
                    }
                    run {
                        var g: Int = 0
                        while ((g < count)) {
                            var encoding: Int = cursor.getInt()
                            val bbxX: Int = cursor.get().toInt()
                            var inkTop: Int = (cursor.get() and 0xff)
                            var width: Int = (cursor.get() and 0xff)
                            var inkHeight: Int = (cursor.get() and 0xff)
                            val rows: IntArray = IntArray(inkHeight)
                            run {
                                var r: Int = 0
                                while ((r < inkHeight)) {
                                    rows[r] = cursor.getInt()
                                    r++
                                }
                            }
                            var k: Long = key(id, encoding)
                            if (
                                (((!glyphs.containsKey(k) && (width > 0)) && (cellHeight > 0)) &&
                                    ((inkTop + inkHeight) <= cellHeight))
                            ) {
                                glyphs.put(
                                    k,
                                    Glyph(width, cellHeight, inkTop, inkHeight, bbxX, rows, null),
                                )
                            }
                            g++
                        }
                    }
                }
            }
        }

        /**
         * Register a batch of antialiased (4bpp) glyph rasters, e.g. TTF renders. Same font-group
         * framing as register(), but each glyph record carries packed coverage instead of 1bpp
         * rows: [encoding u32][bbxX s8][inkTop u8][width u8][inkHeight u8]
         * [inkHeight x ceil(width/2) packed bytes, high nibble = left pixel] Nibble values are the
         * final 4bpp source levels (the draw-time LUT scales them by the top color).
         * Already-registered (font, encoding) records are skipped, as in register().
         */
        @JvmStatic
        fun registerAa(buffer: ByteReader?): Unit {
            if ((buffer == null)) {
                return
            }
            val cursor: ByteReader = buffer
            lock.withLock {
                while ((cursor.remaining() > 0)) {
                    var keyLen: Int = (cursor.get() and 0xff)
                    var keyBytes: ByteArray = ByteArray(keyLen)
                    cursor.get(keyBytes)
                    var fontKey: String = keyBytes.decodeToString()
                    var cellHeight: Int = (cursor.get() and 0xff)
                    var count: Int = (cursor.getShort().toInt() and 0xffff)
                    var idBoxed: Int? = fontIds.get(fontKey)
                    var id: Int = 0
                    if ((idBoxed == null)) {
                        id = nextFontId++
                        fontIds.put(fontKey, id)
                    } else {
                        id = idBoxed
                    }
                    run {
                        var g: Int = 0
                        while ((g < count)) {
                            var encoding: Int = cursor.getInt()
                            val bbxX: Int = cursor.get().toInt()
                            var inkTop: Int = (cursor.get() and 0xff)
                            var width: Int = (cursor.get() and 0xff)
                            var inkHeight: Int = (cursor.get() and 0xff)
                            var stride: Int = ((width + 1) shr 1)
                            var coverage: ByteArray = ByteArray((width * inkHeight))
                            run {
                                var r: Int = 0
                                while ((r < inkHeight)) {
                                    run {
                                        var b: Int = 0
                                        while ((b < stride)) {
                                            var packed: Int = (cursor.get() and 0xff)
                                            var col: Int = (b * 2)
                                            coverage[((r * width) + col)] =
                                                ((packed shr 4)).toByte()
                                            if (((col + 1) < width)) {
                                                coverage[(((r * width) + col) + 1)] =
                                                    ((packed and 0x0f)).toByte()
                                            }
                                            b++
                                        }
                                    }
                                    r++
                                }
                            }
                            var k: Long = key(id, encoding)
                            if (
                                (((!glyphs.containsKey(k) && (width > 0)) && (cellHeight > 0)) &&
                                    ((inkTop + inkHeight) <= cellHeight))
                            ) {
                                glyphs.put(
                                    k,
                                    Glyph(
                                        width,
                                        cellHeight,
                                        inkTop,
                                        inkHeight,
                                        bbxX,
                                        null,
                                        coverage,
                                    ),
                                )
                            }
                            g++
                        }
                    }
                }
            }
        }
    }

    constructor() {}

    class Glyph {
        /** Cached image width in pixels (the glyph's tight bbox width). */
        @JvmField val width: Int

        /** Cached image height in pixels (the font's line height). */
        @JvmField val cellHeight: Int

        /** First row of ink within the cell. */
        @JvmField val inkTop: Int

        /** Number of ink rows. */
        @JvmField val inkHeight: Int

        /** Horizontal bearing: draw x = pen x + bbxX. */
        @JvmField val bbxX: Int

        /** 1bpp ink rows (inkHeight entries), bit (rowBitWidth-1-col) = ink; null for AA glyphs. */
        @JvmField val rows: IntArray?

        @JvmField val rowBitWidth: Int

        /** AA coverage, width*inkHeight nibble values 0..15; null for 1bpp glyphs. */
        @JvmField val coverage: ByteArray?

        /** CFW cached-image bytes: [flags=RLE][w][cellHeight][RLE(w*cellHeight px)]. */
        @JvmField val cachedBytes: ByteArray

        constructor(
            width: Int,
            cellHeight: Int,
            inkTop: Int,
            inkHeight: Int,
            bbxX: Int,
            rows: IntArray?,
            coverage: ByteArray?,
        ) {
            this.width = width
            this.cellHeight = cellHeight
            this.inkTop = inkTop
            this.inkHeight = inkHeight
            this.bbxX = bbxX
            this.rows = rows
            this.coverage = coverage
            this.rowBitWidth = (((width + 7) shr 3) shl 3)
            this.cachedBytes = encodeCachedImage()
        }

        /**
         * The cell pixel's 4bpp source value at (col, row), row cell-relative. 1bpp glyphs are
         * stored at 15 so the draw-time LUT (source*top/15) maps them to exactly the requested top
         * color; AA glyphs carry their true coverage level.
         */
        fun nibbleAt(col: Int, row: Int): Int {
            if (((col < 0) || (col >= width))) {
                return 0
            }
            var inkRow: Int = (row - inkTop)
            if (((inkRow < 0) || (inkRow >= inkHeight))) {
                return 0
            }
            if ((coverage != null)) {
                return coverage[((inkRow * width) + col)].toInt()
            }
            return (if ((((rows!![inkRow] ushr ((rowBitWidth - 1) - col)) and 1) != 0)) 15 else 0)
        }

        /** Whether the cell pixel at (col, row) has any ink (row is cell-relative). */
        fun inkAt(col: Int, row: Int): Boolean {
            return (nibbleAt(col, row) != 0)
        }

        /**
         * The firmware cached-image encoding: [flags=RLE][width][height][RLE tokens] covering exactly
         * width*cellHeight pixels (no row padding), each pixel's stored color being its nibbleAt
         * value.
         */
        private fun encodeCachedImage(): ByteArray {
            var total: Int = (width * cellHeight)
            var out: ByteArray = ByteArray((3 + total))
            out[0] = DrawProtocol.RLE.toByte()
            out[1] = (width).toByte()
            out[2] = (cellHeight).toByte()
            var o: Int = 3
            var i: Int = 0
            while ((i < total)) {
                var color: Int = nibbleAt((i % width), (i / width))
                var j: Int = (i + 1)
                while (((j < total) && (nibbleAt((j % width), (j / width)) == color))) {
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
