package com.faceclaw.app;

import android.graphics.Bitmap;

import java.nio.ByteBuffer;

/**
 * Builds the phone-UI preview bitmap from an 8bpp grayscale frame. The
 * grayscale buffer arrives as a ByteBuffer (NativeScript marshals a JS
 * ArrayBuffer to one without copying element-by-element); doing the
 * gray-to-ARGB expansion here keeps the 165KB-per-frame loop out of the
 * JS/Java bridge, where it used to cost ~150ms per preview.
 */
public final class PreviewBitmapUtil {
    private static int[] cachedLut;
    private static long cachedGammaBits;
    private static boolean cachedGreen;

    private PreviewBitmapUtil() {}

    /** Reuse the current preview palette; rebuild only when gamma or color changes. */
    private static synchronized int[] lookupTable(double brightenGamma, boolean green) {
        long gammaBits = Double.doubleToLongBits(brightenGamma);
        if (cachedLut != null && cachedGammaBits == gammaBits && cachedGreen == green) {
            return cachedLut;
        }
        int[] lut = new int[256];
        for (int g = 0; g < 256; g++) {
            int v = (int) Math.max(0, Math.min(255, Math.round(255 * Math.pow(g / 255.0, brightenGamma))));
            lut[g] = green ? (0xff000000 | (v << 8)) : (0xff000000 | (v << 16) | (v << 8) | v);
        }
        cachedGammaBits = gammaBits;
        cachedGreen = green;
        cachedLut = lut;
        return lut;
    }

    public static Bitmap fromGray(ByteBuffer gray, int width, int height, double brightenGamma) {
        return fromGray(gray, width, height, brightenGamma, false);
    }

    /** As above; `green` renders green-on-black (matching the physical glasses) instead of grayscale. */
    public static Bitmap fromGray(ByteBuffer gray, int width, int height, double brightenGamma, boolean green) {
        if (gray == null || width <= 0 || height <= 0 || gray.remaining() < width * height) {
            throw new IllegalArgumentException("invalid gray preview buffer");
        }
        int[] lut = lookupTable(brightenGamma, green);
        byte[] bytes = new byte[width * height];
        gray.get(bytes);
        int[] colors = new int[width * height];
        for (int i = 0; i < colors.length; i++) {
            colors[i] = lut[bytes[i] & 0xff];
        }
        return Bitmap.createBitmap(colors, width, height, Bitmap.Config.ARGB_8888);
    }
}
