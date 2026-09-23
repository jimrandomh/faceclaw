package com.faceclaw.app

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Build
import android.util.Log

import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.LinkedHashMap

/**
 * Rasterizes text using font files (TTF/OTF/TTC) via the Android text stack,
 * so shaping, kerning, and antialiasing are all delegated to
 * minikin/HarfBuzz. Output uses the same grayscale packet format as
 * ImageFileLoader ([widthLo, widthHi, heightLo, heightHi, pixels...], one
 * byte per pixel, row-major), which the TS side turns into a GrayImage and
 * the compositor later quantizes to the 4bpp the firmware wants.
 *
 * The gamma parameter maps antialiased coverage to output shade:
 * out = 255 * (coverage/255)^gamma. The G2 display response looks roughly
 * linear, so 1.0 is the expected default; the font previewer exposes it for
 * on-hardware comparison.
 */
class FontFileRenderer private constructor() {
    companion object {
        private const val TAG = "FontFileRenderer"
        private const val TYPEFACE_CACHE_SIZE = 4

        /** Small LRU of loaded typefaces keyed by file path. */
        private val typefaceCache: MutableMap<String, Typeface> =
                object : LinkedHashMap<String, Typeface>(TYPEFACE_CACHE_SIZE, 0.75f, true) {
                    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Typeface>): Boolean {
                        return size > TYPEFACE_CACHE_SIZE
                    }
                }

        /**
         * Render one line of text with the given font file at the given pixel
         * size. The returned image is the font's full vertical extent (top to
         * bottom, taller than ascent+descent), plus any horizontal glyph
         * overhang beyond the advance width.
         *
         * Returns an empty array if the font cannot be loaded or the text
         * renders to nothing.
         */
        @JvmStatic
        fun renderText(path: String?, text: String?, sizePx: Float, gamma: Double): ByteArray {
            if (path == null || text == null || sizePx <= 0) {
                return ByteArray(0)
            }
            val typeface = loadTypeface(path)
            if (typeface == null) {
                return ByteArray(0)
            }
            try {
                val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG)
                paint.typeface = typeface
                paint.textSize = sizePx
                paint.color = Color.WHITE

                // top/bottom (the font's maximal extent) rather than
                // ascent/descent, so diacritics and swashes don't clip.
                val fm = paint.fontMetricsInt
                val ascent = -fm.top
                val height = -fm.top + fm.bottom
                // measureText gives advance width; italic/swash glyphs can paint
                // outside it, so pad by half an em on each side and trim after.
                val pad = Math.ceil((sizePx / 2).toDouble()).toInt()
                val advance = Math.ceil(paint.measureText(text).toDouble()).toInt()
                val width = advance + 2 * pad
                if (width <= 0 || height <= 0 || width * height > 4_000_000) {
                    return ByteArray(0)
                }

                val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ALPHA_8)
                val canvas = Canvas(bitmap)
                canvas.drawText(text, pad.toFloat(), ascent.toFloat(), paint)
                val pixels = alpha8Pixels(bitmap, width, height)
                bitmap.recycle()

                // Trim the horizontal padding down to the painted extent, but
                // keep at least the advance width so spacing stays truthful.
                var left = pad
                var right = pad + advance
                val painted = paintedColumnRange(pixels, width, height)
                if (painted != null) {
                    left = Math.min(left, painted[0])
                    right = Math.max(right, painted[1] + 1)
                }
                val outWidth = Math.max(1, right - left)

                val lut = gammaLut(gamma)
                val out = ByteArray(4 + outWidth * height)
                out[0] = (outWidth and 0xff).toByte()
                out[1] = ((outWidth shr 8) and 0xff).toByte()
                out[2] = (height and 0xff).toByte()
                out[3] = ((height shr 8) and 0xff).toByte()
                for (y in 0 until height) {
                    val srcRow = y * width
                    val dstRow = 4 + y * outWidth
                    for (x in 0 until outWidth) {
                        out[dstRow + x] = lut[pixels[srcRow + left + x].toInt() and 0xff]
                    }
                }
                return out
            } catch (e: Exception) {
                Log.w(TAG, "text render failed: $path", e)
                return ByteArray(0)
            } catch (e: OutOfMemoryError) {
                Log.w(TAG, "text render failed: $path", e)
                return ByteArray(0)
            }
        }

        /**
         * Render a multi-line block of text wrapped to maxWidth, with line
         * breaking delegated to StaticLayout (so it matches Android text
         * behavior, including breaking inside long words). Truncated with an
         * ellipsis past maxLines. Same packet format as renderText.
         */
        @JvmStatic
        fun renderWrapped(
                path: String?, text: String?, sizePx: Float, maxWidth: Int, gamma: Double, maxLines: Int): ByteArray {
            if (path == null || text == null || sizePx <= 0 || maxWidth <= 0 || maxLines <= 0) {
                return ByteArray(0)
            }
            val typeface = loadTypeface(path)
            if (typeface == null) {
                return ByteArray(0)
            }
            try {
                val paint = android.text.TextPaint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG)
                paint.typeface = typeface
                paint.textSize = sizePx
                paint.color = Color.WHITE
                paint.hinting = Paint.HINTING_ON

                val layout = android.text.StaticLayout.Builder
                        .obtain(text, 0, text.length, paint, maxWidth)
                        .setAlignment(android.text.Layout.Alignment.ALIGN_NORMAL)
                        .setIncludePad(false)
                        .setMaxLines(maxLines)
                        .setEllipsize(android.text.TextUtils.TruncateAt.END)
                        .build()
                val height = Math.max(1, layout.height)
                if (maxWidth.toLong() * height > 4_000_000L) {
                    return ByteArray(0)
                }

                val bitmap = Bitmap.createBitmap(maxWidth, height, Bitmap.Config.ALPHA_8)
                val canvas = Canvas(bitmap)
                layout.draw(canvas)
                val pixels = alpha8Pixels(bitmap, maxWidth, height)
                bitmap.recycle()

                val lut = gammaLut(gamma)
                val out = ByteArray(4 + pixels.size)
                out[0] = (maxWidth and 0xff).toByte()
                out[1] = ((maxWidth shr 8) and 0xff).toByte()
                out[2] = (height and 0xff).toByte()
                out[3] = ((height shr 8) and 0xff).toByte()
                for (i in pixels.indices) {
                    out[4 + i] = lut[pixels[i].toInt() and 0xff]
                }
                return out
            } catch (e: Exception) {
                Log.w(TAG, "wrapped render failed: $path", e)
                return ByteArray(0)
            } catch (e: OutOfMemoryError) {
                Log.w(TAG, "wrapped render failed: $path", e)
                return ByteArray(0)
            }
        }

        /**
         * Render one codepoint as a tight-ink-box antialiased glyph cell for the
         * texture-cache text pipeline (see app/graphics/ttf-font.ts). Ligatures
         * are disabled so a per-codepoint raster plus pairwise kerning (measured
         * via measureTextExact) fully describes a line. Little-endian packet:
         *   [advance u16, 26.6 fixed point]
         *   [bearingX s16]   ink left relative to the pen position
         *   [inkTop s16]     ink top relative to the line top (ascent above baseline)
         *   [width u16][height u16]
         *   [width*height coverage bytes, gamma-mapped]
         * An ink-free glyph (space) has width = height = 0 but a valid advance.
         * Empty array when the font cannot be loaded or the render fails.
         */
        @JvmStatic
        fun renderGlyphCell(path: String?, sizePx: Float, codePoint: Int, gamma: Double): ByteArray {
            val typeface = loadTypeface(path)
            if (typeface == null || sizePx <= 0 || codePoint < 0 || codePoint > 0x10ffff) {
                return ByteArray(0)
            }
            try {
                val paint = glyphPaint(typeface, sizePx)
                val text = String(Character.toChars(codePoint))
                val advance = paint.measureText(text)
                val advanceFixed = Math.max(0, Math.min(0xffff, Math.round(advance * 64f)))

                val bounds = android.graphics.Rect()
                paint.getTextBounds(text, 0, text.length, bounds)
                if (bounds.isEmpty) {
                    return glyphCellPacket(advanceFixed, 0, 0, 0, 0, null)
                }
                // getTextBounds can be off by a hair on AA edges; render with
                // padding, then trim to the actually painted box.
                val pad = 2
                val bw = bounds.width() + 2 * pad
                val bh = bounds.height() + 2 * pad
                if (bw <= 0 || bh <= 0 || bw * bh > 1_000_000) {
                    return ByteArray(0)
                }
                val penX = pad - bounds.left
                val baselineY = pad - bounds.top
                val bitmap = Bitmap.createBitmap(bw, bh, Bitmap.Config.ALPHA_8)
                val canvas = Canvas(bitmap)
                canvas.drawText(text, penX.toFloat(), baselineY.toFloat(), paint)
                val pixels = alpha8Pixels(bitmap, bw, bh)
                bitmap.recycle()

                var x0 = bw
                var x1 = -1
                var y0 = bh
                var y1 = -1
                for (y in 0 until bh) {
                    val row = y * bw
                    for (x in 0 until bw) {
                        if (pixels[row + x].toInt() != 0) {
                            if (x < x0) x0 = x
                            if (x > x1) x1 = x
                            if (y < y0) y0 = y
                            if (y > y1) y1 = y
                        }
                    }
                }
                if (x1 < x0) {
                    return glyphCellPacket(advanceFixed, 0, 0, 0, 0, null)
                }
                val width = x1 - x0 + 1
                val height = y1 - y0 + 1
                val fm = paint.fontMetricsInt
                val bearingX = x0 - penX
                val inkTop = (-fm.ascent) + (y0 - baselineY)

                val lut = gammaLut(gamma)
                val coverage = ByteArray(width * height)
                for (y in 0 until height) {
                    val src = (y0 + y) * bw + x0
                    val dst = y * width
                    for (x in 0 until width) {
                        coverage[dst + x] = lut[pixels[src + x].toInt() and 0xff]
                    }
                }
                return glyphCellPacket(advanceFixed, bearingX, inkTop, width, height, coverage)
            } catch (e: Exception) {
                Log.w(TAG, "glyph render failed: " + path + " U+" + Integer.toHexString(codePoint), e)
                return ByteArray(0)
            } catch (e: OutOfMemoryError) {
                Log.w(TAG, "glyph render failed: " + path + " U+" + Integer.toHexString(codePoint), e)
                return ByteArray(0)
            }
        }

        /**
         * Exact (float) advance width of a text run, with the same paint setup as
         * renderGlyphCell (subpixel advances, ligatures off), so pair kerning can
         * be derived as measure(ab) - measure(a) - measure(b).
         */
        @JvmStatic
        fun measureTextExact(path: String?, text: String?, sizePx: Float): Double {
            val typeface = loadTypeface(path)
            if (typeface == null || text == null || sizePx <= 0) {
                return 0.0
            }
            return glyphPaint(typeface, sizePx).measureText(text).toDouble()
        }

        /** Paint used by both the glyph-cell renderer and its measurements. */
        @JvmStatic
        private fun glyphPaint(typeface: Typeface, sizePx: Float): Paint {
            val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG)
            paint.typeface = typeface
            paint.textSize = sizePx
            paint.color = Color.WHITE
            // Ligatures merge codepoints into one glyph, which the per-codepoint
            // cache model cannot represent; kerning still applies.
            paint.fontFeatureSettings = "'liga' off, 'clig' off"
            return paint
        }

        @JvmStatic
        private fun glyphCellPacket(
                advanceFixed: Int, bearingX: Int, inkTop: Int, width: Int, height: Int, coverage: ByteArray?): ByteArray {
            val out = ByteArray(10 + (coverage?.size ?: 0))
            out[0] = (advanceFixed and 0xff).toByte()
            out[1] = ((advanceFixed shr 8) and 0xff).toByte()
            out[2] = (bearingX and 0xff).toByte()
            out[3] = ((bearingX shr 8) and 0xff).toByte()
            out[4] = (inkTop and 0xff).toByte()
            out[5] = ((inkTop shr 8) and 0xff).toByte()
            out[6] = (width and 0xff).toByte()
            out[7] = ((width shr 8) and 0xff).toByte()
            out[8] = (height and 0xff).toByte()
            out[9] = ((height shr 8) and 0xff).toByte()
            if (coverage != null) {
                System.arraycopy(coverage, 0, out, 10, coverage.size)
            }
            return out
        }

        /**
         * Line metrics for a font at a pixel size, as "ascent descent lineGap"
         * (integers, pixels). Empty string if the font cannot be loaded.
         */
        @JvmStatic
        fun getFontMetrics(path: String?, sizePx: Float): String {
            val typeface = loadTypeface(path)
            if (typeface == null || sizePx <= 0) {
                return ""
            }
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            paint.typeface = typeface
            paint.textSize = sizePx
            val fm = paint.fontMetricsInt
            val lineGap = fm.leading
            return (-fm.ascent).toString() + " " + fm.descent + " " + lineGap
        }

        /** Advance width in pixels of a line of text (rounded up). */
        @JvmStatic
        fun measureText(path: String?, text: String?, sizePx: Float): Int {
            val typeface = loadTypeface(path)
            if (typeface == null || text == null || sizePx <= 0) {
                return 0
            }
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            paint.typeface = typeface
            paint.textSize = sizePx
            return Math.ceil(paint.measureText(text).toDouble()).toInt()
        }

        /**
         * Whether the font file loads at all (strictly validated on API 29+;
         * best-effort below that).
         */
        @JvmStatic
        fun canLoadFont(path: String?): Boolean {
            return loadTypeface(path) != null
        }

        /**
         * The font's family and style names from its 'name' table, as
         * "Family\nStyle" ("Style" may be empty). Falls back to "" when the
         * table cannot be parsed; callers should then use the filename.
         */
        @JvmStatic
        fun getFontName(path: String?): String {
            try {
                return parseNameTable(path)
            } catch (e: Exception) {
                Log.w(TAG, "name table parse failed: $path", e)
                return ""
            }
        }

        @JvmStatic
        @Synchronized
        private fun loadTypeface(path: String?): Typeface? {
            if (path == null) {
                return null
            }
            val cached = typefaceCache[path]
            if (cached != null) {
                return cached
            }
            val file = File(path)
            if (!file.isFile || !file.canRead()) {
                return null
            }
            var typeface: Typeface? = null
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    // Strict path: Font.Builder throws on files that are not
                    // valid fonts, unlike createFromFile which silently falls
                    // back to the default typeface.
                    val font = android.graphics.fonts.Font.Builder(file).build()
                    typeface = Typeface.CustomFallbackBuilder(
                            android.graphics.fonts.FontFamily.Builder(font).build())
                            .build()
                } else {
                    typeface = Typeface.createFromFile(file)
                    if (typeface == null || typeface == Typeface.DEFAULT) {
                        typeface = null
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "font load failed: $path: $e")
                typeface = null
            } catch (e: LinkageError) {
                Log.w(TAG, "font load failed: $path: $e")
                typeface = null
            }
            if (typeface != null) {
                typefaceCache[path] = typeface
            }
            return typeface
        }

        /**
         * The coverage bytes of an ALPHA_8 bitmap as a tightly-packed
         * width*height array (copyPixelsToBuffer copies rowBytes*height, and the
         * row stride is not guaranteed to equal the width).
         */
        @JvmStatic
        private fun alpha8Pixels(bitmap: Bitmap, width: Int, height: Int): ByteArray {
            val rowBytes = bitmap.rowBytes
            val raw = ByteArray(rowBytes * height)
            bitmap.copyPixelsToBuffer(ByteBuffer.wrap(raw))
            if (rowBytes == width) {
                return raw
            }
            val pixels = ByteArray(width * height)
            for (y in 0 until height) {
                System.arraycopy(raw, y * rowBytes, pixels, y * width, width)
            }
            return pixels
        }

        /** [first, last] painted (nonzero) column indexes, or null if blank. */
        @JvmStatic
        private fun paintedColumnRange(pixels: ByteArray, width: Int, height: Int): IntArray? {
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

        @JvmStatic
        private fun gammaLut(gammaIn: Double): ByteArray {
            val lut = ByteArray(256)
            var gamma = gammaIn
            if (gamma <= 0) {
                gamma = 1.0
            }
            for (i in 0 until 256) {
                lut[i] = Math.max(0, Math.min(255,
                        Math.round(255.0 * Math.pow(i / 255.0, gamma)).toInt())).toByte()
            }
            return lut
        }

        // --- Minimal 'name' table reader (TTF/OTF/TTC) for preview titles ---

        @JvmStatic
        @Throws(Exception::class)
        private fun parseNameTable(path: String?): String {
            RandomAccessFile(path, "r").use { raf ->
                val fileSize = raf.length()
                if (fileSize < 12) {
                    return ""
                }
                var offset = 0L
                val tag = readU32(raf, 0)
                if (tag == 0x74746366) { // 'ttcf': use the first face
                    if (readU32(raf, 8) < 1) {
                        return ""
                    }
                    offset = readU32(raf, 12).toLong() and 0xffffffffL
                }
                val numTables = readU16(raf, offset + 4)
                var nameOffset = -1L
                for (i in 0 until numTables) {
                    val rec = offset + 12 + i * 16L
                    if (rec + 16 > fileSize) {
                        return ""
                    }
                    if (readU32(raf, rec) == 0x6e616d65) { // 'name'
                        nameOffset = readU32(raf, rec + 8).toLong() and 0xffffffffL
                        break
                    }
                }
                if (nameOffset < 0 || nameOffset + 6 > fileSize) {
                    return ""
                }
                val count = readU16(raf, nameOffset + 2)
                val stringStorage = nameOffset + readU16(raf, nameOffset + 4)
                var family: String? = null
                var style: String? = null
                var preferredFamily: String? = null
                var preferredStyle: String? = null
                for (i in 0 until count) {
                    val rec = nameOffset + 6 + i * 12L
                    if (rec + 12 > fileSize) {
                        break
                    }
                    val platform = readU16(raf, rec)
                    val nameId = readU16(raf, rec + 6)
                    if (nameId != 1 && nameId != 2 && nameId != 16 && nameId != 17) {
                        continue
                    }
                    val length = readU16(raf, rec + 8)
                    val strOffset = stringStorage + readU16(raf, rec + 10)
                    if (strOffset + length > fileSize || length <= 0 || length > 512) {
                        continue
                    }
                    val data = ByteArray(length)
                    raf.seek(strOffset)
                    raf.readFully(data)
                    // Platform 0 (Unicode) and 3 (Windows) store UTF-16BE;
                    // platform 1 (Mac) is close enough to Latin-1 for names.
                    var value = if (platform == 1)
                            String(data, java.nio.charset.StandardCharsets.ISO_8859_1)
                            else String(data, java.nio.charset.StandardCharsets.UTF_16BE)
                    value = value.trim()
                    if (value.isEmpty()) {
                        continue
                    }
                    if (nameId == 1 && family == null) family = value
                    if (nameId == 2 && style == null) style = value
                    if (nameId == 16 && preferredFamily == null) preferredFamily = value
                    if (nameId == 17 && preferredStyle == null) preferredStyle = value
                }
                val outFamily = preferredFamily ?: family
                val outStyle = preferredStyle ?: style
                if (outFamily == null) {
                    return ""
                }
                return outFamily + "\n" + (outStyle ?: "")
            }
        }

        @JvmStatic
        @Throws(Exception::class)
        private fun readU16(raf: RandomAccessFile, offset: Long): Int {
            raf.seek(offset)
            val b = ByteArray(2)
            raf.readFully(b)
            return ByteBuffer.wrap(b).order(ByteOrder.BIG_ENDIAN).getShort().toInt() and 0xffff
        }

        @JvmStatic
        @Throws(Exception::class)
        private fun readU32(raf: RandomAccessFile, offset: Long): Int {
            raf.seek(offset)
            val b = ByteArray(4)
            raf.readFully(b)
            return ByteBuffer.wrap(b).order(ByteOrder.BIG_ENDIAN).getInt()
        }
    }
}
