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
import java.util.LinkedHashMap

/**
 * Rasterizes text using font files (TTF/OTF/TTC) via the Android text stack,
 * so shaping, kerning, and antialiasing are all delegated to
 * minikin/HarfBuzz. Output uses the same grayscale packet format as
 * ImageFileLoader ([widthLo, widthHi, heightLo, heightHi, pixels...], one
 * byte per pixel, row-major), which the TS side turns into a GrayImage and
 * the compositor later quantizes to the 4bpp the firmware wants. The packet
 * layouts, gamma mapping and ink cropping are shared with iOS in GlyphPacket;
 * only rasterization lives here.
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
                val painted = GlyphPacket.paintedColumnRange(pixels, width, height)
                if (painted != null) {
                    left = Math.min(left, painted[0])
                    right = Math.max(right, painted[1] + 1)
                }
                val outWidth = Math.max(1, right - left)
                return GlyphPacket.packImageRegion(pixels, width, left, 0, outWidth, height, gamma)
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

                return GlyphPacket.packImage(pixels, maxWidth, height, gamma)
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
                    return GlyphPacket.emptyGlyphCell(advanceFixed)
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

                // Trim to the tight ink box; bearing/inkTop become pen- and
                // line-relative inside the shared packer.
                val fm = paint.fontMetricsInt
                return GlyphPacket.packGlyphCell(
                        advanceFixed, pixels, bw, bh, penX, baselineY, -fm.ascent, gamma)
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
            if (path == null) {
                return ""
            }
            try {
                RandomAccessFile(path, "r").use { raf ->
                    return OpenTypeNames.parse(object : RandomAccessBytes {
                        override val length: Long
                            get() = raf.length()

                        override fun read(offset: Long, into: ByteArray, count: Int) {
                            raf.seek(offset)
                            raf.readFully(into, 0, count)
                        }
                    })
                }
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
    }
}
