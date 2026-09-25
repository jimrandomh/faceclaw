package com.faceclaw.app

import kotlin.jvm.JvmStatic
import kotlin.math.pow
import kotlin.math.roundToInt

/**
 * Wire packets produced by the platform text rasterizers (Android FontFileRenderer over
 * minikin/HarfBuzz, iOS over CoreText) and consumed by the TypeScript side
 * (app/native/font-files.ts, app/graphics/ttf-font.ts). Rasterization stays per platform;
 * the packet layouts, gamma mapping and ink-box cropping live here so both platforms agree.
 *
 * Image packet (renderText / renderWrapped): [widthLo, widthHi, heightLo, heightHi, pixels...],
 * one gamma-mapped coverage byte per pixel, row-major.
 *
 * Glyph-cell packet (renderGlyphCell), little-endian:
 *   [advance u16, 26.6 fixed point]
 *   [bearingX s16]   ink left relative to the pen position
 *   [inkTop s16]     ink top relative to the line top (ascent above baseline)
 *   [width u16][height u16]
 *   [width*height coverage bytes, gamma-mapped]
 * An ink-free glyph (space) has width = height = 0 but a valid advance.
 */
object GlyphPacket {
    const val IMAGE_HEADER_BYTES = 4
    const val GLYPH_CELL_HEADER_BYTES = 10

    /** out = 255 * (coverage/255)^gamma; non-positive gamma means linear. */
    @JvmStatic
    fun gammaLut(gammaIn: Double): ByteArray {
        val gamma = if (gammaIn > 0 && gammaIn.isFinite()) gammaIn else 1.0
        val lut = ByteArray(256)
        for (i in 0 until 256) {
            lut[i] = (255.0 * (i / 255.0).pow(gamma)).roundToInt().coerceIn(0, 255).toByte()
        }
        return lut
    }

    /** [first, last] painted (nonzero) column indexes, or null if blank. */
    @JvmStatic
    fun paintedColumnRange(pixels: ByteArray, width: Int, height: Int): IntArray? {
        var first = width
        var last = -1
        for (y in 0 until height) {
            val row = y * width
            var x = 0
            while (x < first) {
                if (pixels[row + x].toInt() != 0) {
                    first = x
                    break
                }
                x++
            }
            x = width - 1
            while (x > last) {
                if (pixels[row + x].toInt() != 0) {
                    last = x
                    break
                }
                x--
            }
        }
        return if (last >= first) intArrayOf(first, last) else null
    }

    /** Tight [x0, y0, x1, y1] (inclusive) box of nonzero pixels, or null if blank. */
    @JvmStatic
    fun inkBounds(pixels: ByteArray, width: Int, height: Int): IntArray? {
        var x0 = width
        var x1 = -1
        var y0 = height
        var y1 = -1
        for (y in 0 until height) {
            val row = y * width
            for (x in 0 until width) {
                if (pixels[row + x].toInt() != 0) {
                    if (x < x0) x0 = x
                    if (x > x1) x1 = x
                    if (y < y0) y0 = y
                    if (y > y1) y1 = y
                }
            }
        }
        return if (x1 >= x0) intArrayOf(x0, y0, x1, y1) else null
    }

    /** Image packet of the whole width*height alpha raster. */
    @JvmStatic
    fun packImage(alpha8: ByteArray, width: Int, height: Int, gamma: Double): ByteArray =
        packImageRegion(alpha8, width, 0, 0, width, height, gamma)

    /** Image packet of the [x, y, width, height] region of a raster with row [stride]. */
    @JvmStatic
    fun packImageRegion(alpha8: ByteArray, stride: Int, x: Int, y: Int, width: Int, height: Int, gamma: Double): ByteArray {
        require(width >= 0 && height >= 0 && x >= 0 && y >= 0 && x + width <= stride)
        val lut = gammaLut(gamma)
        val out = ByteArray(IMAGE_HEADER_BYTES + width * height)
        putU16(out, 0, width)
        putU16(out, 2, height)
        for (row in 0 until height) {
            val src = (y + row) * stride + x
            val dst = IMAGE_HEADER_BYTES + row * width
            for (col in 0 until width) {
                out[dst + col] = lut[alpha8[src + col].toInt() and 0xff]
            }
        }
        return out
    }

    /** 26.6 fixed-point advance clamped to u16. */
    @JvmStatic
    fun advanceFixed(advancePx: Double): Int = (advancePx * 64.0).roundToInt().coerceIn(0, 0xffff)

    /** Glyph cell with no ink (space): valid advance, zero-size box. */
    @JvmStatic
    fun emptyGlyphCell(advanceFixed: Int): ByteArray = glyphCellPacket(advanceFixed, 0, 0, 0, 0, null)

    /** Glyph cell from already gamma-mapped coverage. */
    @JvmStatic
    fun glyphCellPacket(advanceFixed: Int, bearingX: Int, inkTop: Int, width: Int, height: Int, coverage: ByteArray?): ByteArray {
        val out = ByteArray(GLYPH_CELL_HEADER_BYTES + (coverage?.size ?: 0))
        putU16(out, 0, advanceFixed)
        putU16(out, 2, bearingX)
        putU16(out, 4, inkTop)
        putU16(out, 6, width)
        putU16(out, 8, height)
        coverage?.copyInto(out, GLYPH_CELL_HEADER_BYTES)
        return out
    }

    /**
     * Glyph cell cropped to the tight ink box of a padded raster. [penX]/[baselineY] are the
     * pen position inside the raster and [ascent] the font ascent above the baseline; the
     * returned bearing/inkTop are relative to those, as the wire format requires.
     */
    @JvmStatic
    fun packGlyphCell(
        advanceFixed: Int,
        alpha8: ByteArray,
        rasterWidth: Int,
        rasterHeight: Int,
        penX: Int,
        baselineY: Int,
        ascent: Int,
        gamma: Double,
    ): ByteArray {
        val box = inkBounds(alpha8, rasterWidth, rasterHeight) ?: return emptyGlyphCell(advanceFixed)
        val x0 = box[0]
        val y0 = box[1]
        val width = box[2] - x0 + 1
        val height = box[3] - y0 + 1
        val lut = gammaLut(gamma)
        val coverage = ByteArray(width * height)
        for (y in 0 until height) {
            val src = (y0 + y) * rasterWidth + x0
            val dst = y * width
            for (x in 0 until width) {
                coverage[dst + x] = lut[alpha8[src + x].toInt() and 0xff]
            }
        }
        return glyphCellPacket(advanceFixed, x0 - penX, ascent + (y0 - baselineY), width, height, coverage)
    }

    private fun putU16(out: ByteArray, offset: Int, value: Int) {
        out[offset] = (value and 0xff).toByte()
        out[offset + 1] = ((value shr 8) and 0xff).toByte()
    }
}
