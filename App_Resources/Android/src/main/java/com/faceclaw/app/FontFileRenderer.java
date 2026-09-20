package com.faceclaw.app;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.os.Build;
import android.util.Log;

import java.io.File;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.LinkedHashMap;
import java.util.Map;

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
public final class FontFileRenderer {
    private static final String TAG = "FontFileRenderer";
    private static final int TYPEFACE_CACHE_SIZE = 4;

    /** Small LRU of loaded typefaces keyed by file path. */
    private static final Map<String, Typeface> typefaceCache =
            new LinkedHashMap<String, Typeface>(TYPEFACE_CACHE_SIZE, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, Typeface> eldest) {
                    return size() > TYPEFACE_CACHE_SIZE;
                }
            };

    private FontFileRenderer() {}

    /**
     * Render one line of text with the given font file at the given pixel
     * size. The returned image is the font's full vertical extent (top to
     * bottom, taller than ascent+descent), plus any horizontal glyph
     * overhang beyond the advance width.
     *
     * Returns an empty array if the font cannot be loaded or the text
     * renders to nothing.
     */
    public static byte[] renderText(String path, String text, float sizePx, double gamma) {
        if (path == null || text == null || sizePx <= 0) {
            return new byte[0];
        }
        Typeface typeface = loadTypeface(path);
        if (typeface == null) {
            return new byte[0];
        }
        try {
            Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.SUBPIXEL_TEXT_FLAG);
            paint.setTypeface(typeface);
            paint.setTextSize(sizePx);
            paint.setColor(Color.WHITE);

            // top/bottom (the font's maximal extent) rather than
            // ascent/descent, so diacritics and swashes don't clip.
            Paint.FontMetricsInt fm = paint.getFontMetricsInt();
            int ascent = -fm.top;
            int height = -fm.top + fm.bottom;
            // measureText gives advance width; italic/swash glyphs can paint
            // outside it, so pad by half an em on each side and trim after.
            int pad = (int) Math.ceil(sizePx / 2);
            int advance = (int) Math.ceil(paint.measureText(text));
            int width = advance + 2 * pad;
            if (width <= 0 || height <= 0 || width * height > 4_000_000) {
                return new byte[0];
            }

            Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ALPHA_8);
            Canvas canvas = new Canvas(bitmap);
            canvas.drawText(text, pad, ascent, paint);
            byte[] pixels = alpha8Pixels(bitmap, width, height);
            bitmap.recycle();

            // Trim the horizontal padding down to the painted extent, but
            // keep at least the advance width so spacing stays truthful.
            int left = pad;
            int right = pad + advance;
            int[] painted = paintedColumnRange(pixels, width, height);
            if (painted != null) {
                left = Math.min(left, painted[0]);
                right = Math.max(right, painted[1] + 1);
            }
            int outWidth = Math.max(1, right - left);

            byte[] lut = gammaLut(gamma);
            byte[] out = new byte[4 + outWidth * height];
            out[0] = (byte) (outWidth & 0xff);
            out[1] = (byte) ((outWidth >> 8) & 0xff);
            out[2] = (byte) (height & 0xff);
            out[3] = (byte) ((height >> 8) & 0xff);
            for (int y = 0; y < height; y++) {
                int srcRow = y * width;
                int dstRow = 4 + y * outWidth;
                for (int x = 0; x < outWidth; x++) {
                    out[dstRow + x] = lut[pixels[srcRow + left + x] & 0xff];
                }
            }
            return out;
        } catch (Exception | OutOfMemoryError e) {
            Log.w(TAG, "text render failed: " + path, e);
            return new byte[0];
        }
    }

    /**
     * Render a multi-line block of text wrapped to maxWidth, with line
     * breaking delegated to StaticLayout (so it matches Android text
     * behavior, including breaking inside long words). Truncated with an
     * ellipsis past maxLines. Same packet format as renderText.
     */
    public static byte[] renderWrapped(
            String path, String text, float sizePx, int maxWidth, double gamma, int maxLines) {
        if (path == null || text == null || sizePx <= 0 || maxWidth <= 0 || maxLines <= 0) {
            return new byte[0];
        }
        Typeface typeface = loadTypeface(path);
        if (typeface == null) {
            return new byte[0];
        }
        try {
            android.text.TextPaint paint =
                    new android.text.TextPaint(Paint.ANTI_ALIAS_FLAG | Paint.SUBPIXEL_TEXT_FLAG);
            paint.setTypeface(typeface);
            paint.setTextSize(sizePx);
            paint.setColor(Color.WHITE);
            paint.setHinting(Paint.HINTING_ON);

            android.text.StaticLayout layout = android.text.StaticLayout.Builder
                    .obtain(text, 0, text.length(), paint, maxWidth)
                    .setAlignment(android.text.Layout.Alignment.ALIGN_NORMAL)
                    .setIncludePad(false)
                    .setMaxLines(maxLines)
                    .setEllipsize(android.text.TextUtils.TruncateAt.END)
                    .build();
            int height = Math.max(1, layout.getHeight());
            if ((long) maxWidth * height > 4_000_000L) {
                return new byte[0];
            }

            Bitmap bitmap = Bitmap.createBitmap(maxWidth, height, Bitmap.Config.ALPHA_8);
            Canvas canvas = new Canvas(bitmap);
            layout.draw(canvas);
            byte[] pixels = alpha8Pixels(bitmap, maxWidth, height);
            bitmap.recycle();

            byte[] lut = gammaLut(gamma);
            byte[] out = new byte[4 + pixels.length];
            out[0] = (byte) (maxWidth & 0xff);
            out[1] = (byte) ((maxWidth >> 8) & 0xff);
            out[2] = (byte) (height & 0xff);
            out[3] = (byte) ((height >> 8) & 0xff);
            for (int i = 0; i < pixels.length; i++) {
                out[4 + i] = lut[pixels[i] & 0xff];
            }
            return out;
        } catch (Exception | OutOfMemoryError e) {
            Log.w(TAG, "wrapped render failed: " + path, e);
            return new byte[0];
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
    public static byte[] renderGlyphCell(String path, float sizePx, int codePoint, double gamma) {
        Typeface typeface = loadTypeface(path);
        if (typeface == null || sizePx <= 0 || codePoint < 0 || codePoint > 0x10ffff) {
            return new byte[0];
        }
        try {
            Paint paint = glyphPaint(typeface, sizePx);
            String text = new String(Character.toChars(codePoint));
            float advance = paint.measureText(text);
            int advanceFixed = Math.max(0, Math.min(0xffff, Math.round(advance * 64f)));

            android.graphics.Rect bounds = new android.graphics.Rect();
            paint.getTextBounds(text, 0, text.length(), bounds);
            if (bounds.isEmpty()) {
                return glyphCellPacket(advanceFixed, 0, 0, 0, 0, null);
            }
            // getTextBounds can be off by a hair on AA edges; render with
            // padding, then trim to the actually painted box.
            int pad = 2;
            int bw = bounds.width() + 2 * pad;
            int bh = bounds.height() + 2 * pad;
            if (bw <= 0 || bh <= 0 || bw * bh > 1_000_000) {
                return new byte[0];
            }
            int penX = pad - bounds.left;
            int baselineY = pad - bounds.top;
            Bitmap bitmap = Bitmap.createBitmap(bw, bh, Bitmap.Config.ALPHA_8);
            Canvas canvas = new Canvas(bitmap);
            canvas.drawText(text, penX, baselineY, paint);
            byte[] pixels = alpha8Pixels(bitmap, bw, bh);
            bitmap.recycle();

            int x0 = bw, x1 = -1, y0 = bh, y1 = -1;
            for (int y = 0; y < bh; y++) {
                int row = y * bw;
                for (int x = 0; x < bw; x++) {
                    if (pixels[row + x] != 0) {
                        if (x < x0) x0 = x;
                        if (x > x1) x1 = x;
                        if (y < y0) y0 = y;
                        if (y > y1) y1 = y;
                    }
                }
            }
            if (x1 < x0) {
                return glyphCellPacket(advanceFixed, 0, 0, 0, 0, null);
            }
            int width = x1 - x0 + 1;
            int height = y1 - y0 + 1;
            Paint.FontMetricsInt fm = paint.getFontMetricsInt();
            int bearingX = x0 - penX;
            int inkTop = (-fm.ascent) + (y0 - baselineY);

            byte[] lut = gammaLut(gamma);
            byte[] coverage = new byte[width * height];
            for (int y = 0; y < height; y++) {
                int src = (y0 + y) * bw + x0;
                int dst = y * width;
                for (int x = 0; x < width; x++) {
                    coverage[dst + x] = lut[pixels[src + x] & 0xff];
                }
            }
            return glyphCellPacket(advanceFixed, bearingX, inkTop, width, height, coverage);
        } catch (Exception | OutOfMemoryError e) {
            Log.w(TAG, "glyph render failed: " + path + " U+" + Integer.toHexString(codePoint), e);
            return new byte[0];
        }
    }

    /**
     * Exact (float) advance width of a text run, with the same paint setup as
     * renderGlyphCell (subpixel advances, ligatures off), so pair kerning can
     * be derived as measure(ab) - measure(a) - measure(b).
     */
    public static double measureTextExact(String path, String text, float sizePx) {
        Typeface typeface = loadTypeface(path);
        if (typeface == null || text == null || sizePx <= 0) {
            return 0;
        }
        return glyphPaint(typeface, sizePx).measureText(text);
    }

    /** Paint used by both the glyph-cell renderer and its measurements. */
    private static Paint glyphPaint(Typeface typeface, float sizePx) {
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.SUBPIXEL_TEXT_FLAG);
        paint.setTypeface(typeface);
        paint.setTextSize(sizePx);
        paint.setColor(Color.WHITE);
        // Ligatures merge codepoints into one glyph, which the per-codepoint
        // cache model cannot represent; kerning still applies.
        paint.setFontFeatureSettings("'liga' off, 'clig' off");
        return paint;
    }

    private static byte[] glyphCellPacket(
            int advanceFixed, int bearingX, int inkTop, int width, int height, byte[] coverage) {
        byte[] out = new byte[10 + (coverage == null ? 0 : coverage.length)];
        out[0] = (byte) (advanceFixed & 0xff);
        out[1] = (byte) ((advanceFixed >> 8) & 0xff);
        out[2] = (byte) (bearingX & 0xff);
        out[3] = (byte) ((bearingX >> 8) & 0xff);
        out[4] = (byte) (inkTop & 0xff);
        out[5] = (byte) ((inkTop >> 8) & 0xff);
        out[6] = (byte) (width & 0xff);
        out[7] = (byte) ((width >> 8) & 0xff);
        out[8] = (byte) (height & 0xff);
        out[9] = (byte) ((height >> 8) & 0xff);
        if (coverage != null) {
            System.arraycopy(coverage, 0, out, 10, coverage.length);
        }
        return out;
    }

    /**
     * Line metrics for a font at a pixel size, as "ascent descent lineGap"
     * (integers, pixels). Empty string if the font cannot be loaded.
     */
    public static String getFontMetrics(String path, float sizePx) {
        Typeface typeface = loadTypeface(path);
        if (typeface == null || sizePx <= 0) {
            return "";
        }
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setTypeface(typeface);
        paint.setTextSize(sizePx);
        Paint.FontMetricsInt fm = paint.getFontMetricsInt();
        int lineGap = fm.leading;
        return (-fm.ascent) + " " + fm.descent + " " + lineGap;
    }

    /** Advance width in pixels of a line of text (rounded up). */
    public static int measureText(String path, String text, float sizePx) {
        Typeface typeface = loadTypeface(path);
        if (typeface == null || text == null || sizePx <= 0) {
            return 0;
        }
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setTypeface(typeface);
        paint.setTextSize(sizePx);
        return (int) Math.ceil(paint.measureText(text));
    }

    /**
     * Whether the font file loads at all (strictly validated on API 29+;
     * best-effort below that).
     */
    public static boolean canLoadFont(String path) {
        return loadTypeface(path) != null;
    }

    /**
     * The font's family and style names from its 'name' table, as
     * "Family\nStyle" ("Style" may be empty). Falls back to "" when the
     * table cannot be parsed; callers should then use the filename.
     */
    public static String getFontName(String path) {
        try {
            return parseNameTable(path);
        } catch (Exception e) {
            Log.w(TAG, "name table parse failed: " + path, e);
            return "";
        }
    }

    private static synchronized Typeface loadTypeface(String path) {
        if (path == null) {
            return null;
        }
        Typeface cached = typefaceCache.get(path);
        if (cached != null) {
            return cached;
        }
        File file = new File(path);
        if (!file.isFile() || !file.canRead()) {
            return null;
        }
        Typeface typeface = null;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // Strict path: Font.Builder throws on files that are not
                // valid fonts, unlike createFromFile which silently falls
                // back to the default typeface.
                android.graphics.fonts.Font font =
                        new android.graphics.fonts.Font.Builder(file).build();
                typeface = new Typeface.CustomFallbackBuilder(
                        new android.graphics.fonts.FontFamily.Builder(font).build())
                        .build();
            } else {
                typeface = Typeface.createFromFile(file);
                if (typeface == null || typeface.equals(Typeface.DEFAULT)) {
                    typeface = null;
                }
            }
        } catch (Exception | LinkageError e) {
            Log.w(TAG, "font load failed: " + path + ": " + e);
            typeface = null;
        }
        if (typeface != null) {
            typefaceCache.put(path, typeface);
        }
        return typeface;
    }

    /**
     * The coverage bytes of an ALPHA_8 bitmap as a tightly-packed
     * width*height array (copyPixelsToBuffer copies rowBytes*height, and the
     * row stride is not guaranteed to equal the width).
     */
    private static byte[] alpha8Pixels(Bitmap bitmap, int width, int height) {
        int rowBytes = bitmap.getRowBytes();
        byte[] raw = new byte[rowBytes * height];
        bitmap.copyPixelsToBuffer(ByteBuffer.wrap(raw));
        if (rowBytes == width) {
            return raw;
        }
        byte[] pixels = new byte[width * height];
        for (int y = 0; y < height; y++) {
            System.arraycopy(raw, y * rowBytes, pixels, y * width, width);
        }
        return pixels;
    }

    /** [first, last] painted (nonzero) column indexes, or null if blank. */
    private static int[] paintedColumnRange(byte[] pixels, int width, int height) {
        int first = width;
        int last = -1;
        for (int y = 0; y < height; y++) {
            int row = y * width;
            for (int x = 0; x < first; x++) {
                if (pixels[row + x] != 0) {
                    first = x;
                    break;
                }
            }
            for (int x = width - 1; x > last; x--) {
                if (pixels[row + x] != 0) {
                    last = x;
                    break;
                }
            }
        }
        return last >= first ? new int[] { first, last } : null;
    }

    private static byte[] gammaLut(double gamma) {
        byte[] lut = new byte[256];
        if (gamma <= 0) {
            gamma = 1.0;
        }
        for (int i = 0; i < 256; i++) {
            lut[i] = (byte) Math.max(0, Math.min(255,
                    (int) Math.round(255.0 * Math.pow(i / 255.0, gamma))));
        }
        return lut;
    }

    // --- Minimal 'name' table reader (TTF/OTF/TTC) for preview titles ---

    private static String parseNameTable(String path) throws Exception {
        try (RandomAccessFile raf = new RandomAccessFile(path, "r")) {
            long fileSize = raf.length();
            if (fileSize < 12) {
                return "";
            }
            long offset = 0;
            int tag = readU32(raf, 0);
            if (tag == 0x74746366) { // 'ttcf': use the first face
                if (readU32(raf, 8) < 1) {
                    return "";
                }
                offset = readU32(raf, 12) & 0xffffffffL;
            }
            int numTables = readU16(raf, offset + 4);
            long nameOffset = -1;
            for (int i = 0; i < numTables; i++) {
                long rec = offset + 12 + i * 16L;
                if (rec + 16 > fileSize) {
                    return "";
                }
                if (readU32(raf, rec) == 0x6e616d65) { // 'name'
                    nameOffset = readU32(raf, rec + 8) & 0xffffffffL;
                    break;
                }
            }
            if (nameOffset < 0 || nameOffset + 6 > fileSize) {
                return "";
            }
            int count = readU16(raf, nameOffset + 2);
            long stringStorage = nameOffset + readU16(raf, nameOffset + 4);
            String family = null;
            String style = null;
            String preferredFamily = null;
            String preferredStyle = null;
            for (int i = 0; i < count; i++) {
                long rec = nameOffset + 6 + i * 12L;
                if (rec + 12 > fileSize) {
                    break;
                }
                int platform = readU16(raf, rec);
                int nameId = readU16(raf, rec + 6);
                if (nameId != 1 && nameId != 2 && nameId != 16 && nameId != 17) {
                    continue;
                }
                int length = readU16(raf, rec + 8);
                long strOffset = stringStorage + readU16(raf, rec + 10);
                if (strOffset + length > fileSize || length <= 0 || length > 512) {
                    continue;
                }
                byte[] data = new byte[length];
                raf.seek(strOffset);
                raf.readFully(data);
                // Platform 0 (Unicode) and 3 (Windows) store UTF-16BE;
                // platform 1 (Mac) is close enough to Latin-1 for names.
                String value = platform == 1
                        ? new String(data, java.nio.charset.StandardCharsets.ISO_8859_1)
                        : new String(data, java.nio.charset.StandardCharsets.UTF_16BE);
                value = value.trim();
                if (value.isEmpty()) {
                    continue;
                }
                if (nameId == 1 && family == null) family = value;
                if (nameId == 2 && style == null) style = value;
                if (nameId == 16 && preferredFamily == null) preferredFamily = value;
                if (nameId == 17 && preferredStyle == null) preferredStyle = value;
            }
            String outFamily = preferredFamily != null ? preferredFamily : family;
            String outStyle = preferredStyle != null ? preferredStyle : style;
            if (outFamily == null) {
                return "";
            }
            return outFamily + "\n" + (outStyle == null ? "" : outStyle);
        }
    }

    private static int readU16(RandomAccessFile raf, long offset) throws Exception {
        raf.seek(offset);
        byte[] b = new byte[2];
        raf.readFully(b);
        return ByteBuffer.wrap(b).order(ByteOrder.BIG_ENDIAN).getShort() & 0xffff;
    }

    private static int readU32(RandomAccessFile raf, long offset) throws Exception {
        raf.seek(offset);
        byte[] b = new byte[4];
        raf.readFully(b);
        return ByteBuffer.wrap(b).order(ByteOrder.BIG_ENDIAN).getInt();
    }
}
