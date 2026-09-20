package com.faceclaw.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Log;

/**
 * Decodes image files (and bitmaps generally) to the grayscale packet format
 * used across the TS bridge: [widthLo, widthHi, heightLo, heightHi,
 * pixels...] with one byte per pixel, row-major, or an empty array on
 * failure. FaceclawMediaController's album art shares bitmapToGrayPacket;
 * the TS side (app/native/image-files.ts) owns the shared photo-tone preset
 * passed as (gamma, dither).
 */
public final class ImageFileLoader {
    private static final String TAG = "ImageFileLoader";

    private ImageFileLoader() {}

    /**
     * Decode an image file and downscale it to fit within maxWidth x
     * maxHeight, preserving aspect ratio and never upscaling. Flat
     * conversion (no tone curve, per-pixel rounding): right for UI raster
     * such as icons.
     */
    public static byte[] loadGray(String path, int maxWidth, int maxHeight) {
        return loadGray(path, maxWidth, maxHeight, 1f, false);
    }

    /**
     * As above, with the photographic tone handling described on
     * bitmapToGrayPacket(Bitmap, int, int, float, boolean): use for
     * continuous-tone images (photos) viewed on the glasses.
     */
    public static byte[] loadGray(
            String path, int maxWidth, int maxHeight, float gamma, boolean dither) {
        if (path == null || maxWidth <= 0 || maxHeight <= 0) {
            return new byte[0];
        }
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(path, bounds);
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
                return new byte[0];
            }
            // Power-of-two subsampling during decode keeps large photos from
            // allocating full-size ARGB buffers; exact fitting happens in
            // bitmapToGrayPacket.
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = 1;
            while (bounds.outWidth / (opts.inSampleSize * 2) >= maxWidth
                    && bounds.outHeight / (opts.inSampleSize * 2) >= maxHeight) {
                opts.inSampleSize *= 2;
            }
            Bitmap bitmap = BitmapFactory.decodeFile(path, opts);
            if (bitmap == null) {
                return new byte[0];
            }
            return bitmapToGrayPacket(bitmap, maxWidth, maxHeight, gamma, dither);
        } catch (Exception | OutOfMemoryError e) {
            Log.w(TAG, "image decode failed: " + path, e);
            return new byte[0];
        }
    }

    /**
     * Decode an in-memory image file (PNG/JPEG/WebP bytes, e.g. a fetched
     * map tile) and downscale to fit within maxWidth x maxHeight. Takes a
     * ByteBuffer because NativeScript marshals a JS ArrayBuffer to one.
     */
    public static byte[] loadGrayFromBytes(java.nio.ByteBuffer buffer, int maxWidth, int maxHeight) {
        return loadGrayFromBytes(buffer, maxWidth, maxHeight, 1f, false);
    }

    /** As above, with photographic tone handling (see bitmapToGrayPacket). */
    public static byte[] loadGrayFromBytes(
            java.nio.ByteBuffer buffer, int maxWidth, int maxHeight, float gamma, boolean dither) {
        if (buffer == null || maxWidth <= 0 || maxHeight <= 0) {
            return new byte[0];
        }
        try {
            java.nio.ByteBuffer source = buffer.duplicate();
            source.rewind();
            byte[] data = new byte[source.remaining()];
            source.get(data);
            if (data.length == 0) {
                return new byte[0];
            }
            Bitmap bitmap = BitmapFactory.decodeByteArray(data, 0, data.length);
            if (bitmap == null) {
                return new byte[0];
            }
            return bitmapToGrayPacket(bitmap, maxWidth, maxHeight, gamma, dither);
        } catch (Exception | OutOfMemoryError e) {
            Log.w(TAG, "byte-array image decode failed", e);
            return new byte[0];
        }
    }

    /**
     * Scale a bitmap to fit within maxWidth x maxHeight (preserving aspect,
     * never upscaling) and convert it to the grayscale packet format.
     * Transparent pixels darken toward black (the on-glasses background).
     */
    public static byte[] bitmapToGrayPacket(Bitmap source, int maxWidth, int maxHeight) {
        return bitmapToGrayPacket(source, maxWidth, maxHeight, 1f, false);
    }

    /**
     * As above, with photographic tone handling for continuous-tone images
     * (album art, photos) rather than UI raster:
     *
     * gamma > 1 darkens midtones (out = 255 * (in/255)^gamma). Source pixels
     * are sRGB-encoded but the G2 drives its 16 levels roughly linearly, so
     * mid-gray otherwise displays far brighter than intended; 2.2 undoes the
     * sRGB encoding outright.
     *
     * dither error-diffuses against the 16 levels the frame is eventually
     * packed to (BmpUtil.GRAY_TO_NIBBLE) instead of leaving each pixel to
     * round on its own, which turns smooth gradients into visible bands.
     * Dithered output is already quantized: every byte is a level times 16,
     * which BmpUtil re-quantizes back to exactly that level.
     */
    public static byte[] bitmapToGrayPacket(
            Bitmap source, int maxWidth, int maxHeight, float gamma, boolean dither) {
        if (source == null || source.getWidth() <= 0 || source.getHeight() <= 0
                || maxWidth <= 0 || maxHeight <= 0) {
            return new byte[0];
        }
        try {
            float scale = Math.min(1f, Math.min(
                    (float) maxWidth / source.getWidth(),
                    (float) maxHeight / source.getHeight()));
            int width = Math.max(1, Math.round(source.getWidth() * scale));
            int height = Math.max(1, Math.round(source.getHeight() * scale));
            Bitmap scaled = Bitmap.createScaledBitmap(source, width, height, true);
            if (scaled.getConfig() == Bitmap.Config.HARDWARE) {
                scaled = scaled.copy(Bitmap.Config.ARGB_8888, false);
            }
            int[] pixels = new int[width * height];
            scaled.getPixels(pixels, 0, width, 0, 0, width, height);
            byte[] out = new byte[4 + width * height];
            out[0] = (byte) (width & 0xff);
            out[1] = (byte) ((width >> 8) & 0xff);
            out[2] = (byte) (height & 0xff);
            out[3] = (byte) ((height >> 8) & 0xff);
            int[] tone = toneCurve(gamma);
            for (int i = 0; i < pixels.length; i++) {
                int p = pixels[i];
                int a = (p >>> 24) & 0xff;
                int r = (p >> 16) & 0xff;
                int g = (p >> 8) & 0xff;
                int b = p & 0xff;
                out[4 + i] = (byte) tone[((r * 299 + g * 587 + b * 114) / 1000) * a / 255];
            }
            if (dither) {
                ditherToDisplayLevels(out, 4, width, height);
            }
            return out;
        } catch (Exception | OutOfMemoryError e) {
            Log.w(TAG, "bitmap conversion failed", e);
            return new byte[0];
        }
    }

    /** 256-entry map of source gray to displayed gray for out = in^gamma. */
    private static int[] toneCurve(float gamma) {
        int[] curve = new int[256];
        for (int v = 0; v < 256; v++) {
            curve[v] = gamma == 1f
                    ? v
                    : Math.round(255f * (float) Math.pow(v / 255f, gamma));
        }
        return curve;
    }

    /**
     * Floyd-Steinberg error diffusion onto the display's 16 gray levels, in
     * place over an 8bpp plane. Serpentine scanning keeps the diffusion from
     * building up a directional texture across wide flat areas.
     *
     * Level n is written back as n * 16 rather than the n * 17 it stands for
     * so that BmpUtil's (v + 8) >> 4 reproduces n exactly; level 0 is written
     * as 1, not 0, because 0 is the shell's color-key for transparent.
     */
    private static void ditherToDisplayLevels(byte[] plane, int offset, int width, int height) {
        float[] curr = new float[width];
        float[] next = new float[width];
        for (int x = 0; x < width; x++) {
            curr[x] = plane[offset + x] & 0xff;
        }
        for (int y = 0; y < height; y++) {
            int rowStart = offset + y * width;
            int nextStart = rowStart + width;
            boolean hasNext = y + 1 < height;
            for (int x = 0; x < width; x++) {
                next[x] = hasNext ? (plane[nextStart + x] & 0xff) : 0f;
            }
            boolean leftToRight = (y & 1) == 0;
            int start = leftToRight ? 0 : width - 1;
            int step = leftToRight ? 1 : -1;
            for (int i = 0; i < width; i++) {
                int x = start + i * step;
                float wanted = curr[x];
                int level = Math.round(Math.min(255f, Math.max(0f, wanted)) / 17f);
                float error = wanted - level * 17f;
                plane[rowStart + x] = (byte) (level == 0 ? 1 : level * 16);
                int ahead = x + step;
                if (ahead >= 0 && ahead < width) {
                    curr[ahead] += error * (7f / 16f);
                }
                if (hasNext) {
                    if (ahead >= 0 && ahead < width) {
                        next[ahead] += error * (1f / 16f);
                    }
                    next[x] += error * (5f / 16f);
                    int behind = x - step;
                    if (behind >= 0 && behind < width) {
                        next[behind] += error * (3f / 16f);
                    }
                }
            }
            float[] swap = curr;
            curr = next;
            next = swap;
        }
    }
}
