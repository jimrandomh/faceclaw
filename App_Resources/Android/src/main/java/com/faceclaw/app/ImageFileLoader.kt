package com.faceclaw.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log

/**
 * Decodes image files (and bitmaps generally) to the grayscale packet format
 * used across the TS bridge: [widthLo, widthHi, heightLo, heightHi,
 * pixels...] with one byte per pixel, row-major, or an empty array on
 * failure. FaceclawMediaController's album art shares bitmapToGrayPacket;
 * the TS side (app/native/image-files.ts) owns the shared photo-tone preset
 * passed as (gamma, dither). The pixel math (tone curve, alpha darkening,
 * dither) lives in the shared GrayPacket so iOS produces identical bytes.
 */
class ImageFileLoader private constructor() {
    companion object {
        private const val TAG = "ImageFileLoader"

        /**
         * Decode an image file and downscale it to fit within maxWidth x
         * maxHeight, preserving aspect ratio and never upscaling. Flat
         * conversion (no tone curve, per-pixel rounding): right for UI raster
         * such as icons.
         */
        @JvmStatic
        fun loadGray(path: String?, maxWidth: Int, maxHeight: Int): ByteArray {
            return loadGray(path, maxWidth, maxHeight, 1f, false)
        }

        /**
         * As above, with the photographic tone handling described on
         * bitmapToGrayPacket(Bitmap, int, int, float, boolean): use for
         * continuous-tone images (photos) viewed on the glasses.
         */
        @JvmStatic
        fun loadGray(
                path: String?, maxWidth: Int, maxHeight: Int, gamma: Float, dither: Boolean): ByteArray {
            if (path == null || maxWidth <= 0 || maxHeight <= 0) {
                return ByteArray(0)
            }
            try {
                val bounds = BitmapFactory.Options()
                bounds.inJustDecodeBounds = true
                BitmapFactory.decodeFile(path, bounds)
                if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
                    return ByteArray(0)
                }
                // Power-of-two subsampling during decode keeps large photos from
                // allocating full-size ARGB buffers; exact fitting happens in
                // bitmapToGrayPacket.
                val opts = BitmapFactory.Options()
                opts.inSampleSize = 1
                while (bounds.outWidth / (opts.inSampleSize * 2) >= maxWidth
                        && bounds.outHeight / (opts.inSampleSize * 2) >= maxHeight) {
                    opts.inSampleSize *= 2
                }
                val bitmap = BitmapFactory.decodeFile(path, opts)
                if (bitmap == null) {
                    return ByteArray(0)
                }
                return bitmapToGrayPacket(bitmap, maxWidth, maxHeight, gamma, dither)
            } catch (e: Exception) {
                Log.w(TAG, "image decode failed: $path", e)
                return ByteArray(0)
            } catch (e: OutOfMemoryError) {
                Log.w(TAG, "image decode failed: $path", e)
                return ByteArray(0)
            }
        }

        /**
         * Decode an in-memory image file (PNG/JPEG/WebP bytes, e.g. a fetched
         * map tile) and downscale to fit within maxWidth x maxHeight. Takes a
         * ByteBuffer because NativeScript marshals a JS ArrayBuffer to one.
         */
        @JvmStatic
        fun loadGrayFromBytes(buffer: java.nio.ByteBuffer?, maxWidth: Int, maxHeight: Int): ByteArray {
            return loadGrayFromBytes(buffer, maxWidth, maxHeight, 1f, false)
        }

        /** As above, with photographic tone handling (see bitmapToGrayPacket). */
        @JvmStatic
        fun loadGrayFromBytes(
                buffer: java.nio.ByteBuffer?, maxWidth: Int, maxHeight: Int, gamma: Float, dither: Boolean): ByteArray {
            if (buffer == null || maxWidth <= 0 || maxHeight <= 0) {
                return ByteArray(0)
            }
            try {
                val source = buffer.duplicate()
                source.rewind()
                val data = ByteArray(source.remaining())
                source.get(data)
                if (data.isEmpty()) {
                    return ByteArray(0)
                }
                val bitmap = BitmapFactory.decodeByteArray(data, 0, data.size)
                if (bitmap == null) {
                    return ByteArray(0)
                }
                return bitmapToGrayPacket(bitmap, maxWidth, maxHeight, gamma, dither)
            } catch (e: Exception) {
                Log.w(TAG, "byte-array image decode failed", e)
                return ByteArray(0)
            } catch (e: OutOfMemoryError) {
                Log.w(TAG, "byte-array image decode failed", e)
                return ByteArray(0)
            }
        }

        /**
         * Scale a bitmap to fit within maxWidth x maxHeight (preserving aspect,
         * never upscaling) and convert it to the grayscale packet format.
         * Transparent pixels darken toward black (the on-glasses background).
         */
        @JvmStatic
        fun bitmapToGrayPacket(source: Bitmap?, maxWidth: Int, maxHeight: Int): ByteArray {
            return bitmapToGrayPacket(source, maxWidth, maxHeight, 1f, false)
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
        @JvmStatic
        fun bitmapToGrayPacket(
                source: Bitmap?, maxWidth: Int, maxHeight: Int, gamma: Float, dither: Boolean): ByteArray {
            if (source == null || source.width <= 0 || source.height <= 0
                    || maxWidth <= 0 || maxHeight <= 0) {
                return ByteArray(0)
            }
            try {
                val scale = Math.min(1f, Math.min(
                        maxWidth.toFloat() / source.width,
                        maxHeight.toFloat() / source.height))
                val width = Math.max(1, Math.round(source.width * scale))
                val height = Math.max(1, Math.round(source.height * scale))
                var scaled = Bitmap.createScaledBitmap(source, width, height, true)
                if (scaled.config == Bitmap.Config.HARDWARE) {
                    scaled = scaled.copy(Bitmap.Config.ARGB_8888, false)
                }
                val pixels = IntArray(width * height)
                scaled.getPixels(pixels, 0, width, 0, 0, width, height)
                return GrayPacket.fromArgb(pixels, width, height, gamma, dither)
            } catch (e: Exception) {
                Log.w(TAG, "bitmap conversion failed", e)
                return ByteArray(0)
            } catch (e: OutOfMemoryError) {
                Log.w(TAG, "bitmap conversion failed", e)
                return ByteArray(0)
            }
        }
    }
}
