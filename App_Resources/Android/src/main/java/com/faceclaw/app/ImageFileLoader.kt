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
 * passed as (gamma, dither).
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
                val out = ByteArray(4 + width * height)
                out[0] = (width and 0xff).toByte()
                out[1] = ((width shr 8) and 0xff).toByte()
                out[2] = (height and 0xff).toByte()
                out[3] = ((height shr 8) and 0xff).toByte()
                val tone = toneCurve(gamma)
                for (i in pixels.indices) {
                    val p = pixels[i]
                    val a = (p ushr 24) and 0xff
                    val r = (p shr 16) and 0xff
                    val g = (p shr 8) and 0xff
                    val b = p and 0xff
                    out[4 + i] = tone[((r * 299 + g * 587 + b * 114) / 1000) * a / 255].toByte()
                }
                if (dither) {
                    ditherToDisplayLevels(out, 4, width, height)
                }
                return out
            } catch (e: Exception) {
                Log.w(TAG, "bitmap conversion failed", e)
                return ByteArray(0)
            } catch (e: OutOfMemoryError) {
                Log.w(TAG, "bitmap conversion failed", e)
                return ByteArray(0)
            }
        }

        /** 256-entry map of source gray to displayed gray for out = in^gamma. */
        @JvmStatic
        private fun toneCurve(gamma: Float): IntArray {
            val curve = IntArray(256)
            for (v in 0 until 256) {
                curve[v] = if (gamma == 1f)
                        v
                        else Math.round(255f * Math.pow((v / 255f).toDouble(), gamma.toDouble()).toFloat())
            }
            return curve
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
        @JvmStatic
        private fun ditherToDisplayLevels(plane: ByteArray, offset: Int, width: Int, height: Int) {
            var curr = FloatArray(width)
            var next = FloatArray(width)
            for (x in 0 until width) {
                curr[x] = (plane[offset + x].toInt() and 0xff).toFloat()
            }
            for (y in 0 until height) {
                val rowStart = offset + y * width
                val nextStart = rowStart + width
                val hasNext = y + 1 < height
                for (x in 0 until width) {
                    next[x] = if (hasNext) (plane[nextStart + x].toInt() and 0xff).toFloat() else 0f
                }
                val leftToRight = (y and 1) == 0
                val start = if (leftToRight) 0 else width - 1
                val step = if (leftToRight) 1 else -1
                for (i in 0 until width) {
                    val x = start + i * step
                    val wanted = curr[x]
                    val level = Math.round(Math.min(255f, Math.max(0f, wanted)) / 17f)
                    val error = wanted - level * 17f
                    plane[rowStart + x] = (if (level == 0) 1 else level * 16).toByte()
                    val ahead = x + step
                    if (ahead >= 0 && ahead < width) {
                        curr[ahead] += error * (7f / 16f)
                    }
                    if (hasNext) {
                        if (ahead >= 0 && ahead < width) {
                            next[ahead] += error * (1f / 16f)
                        }
                        next[x] += error * (5f / 16f)
                        val behind = x - step
                        if (behind >= 0 && behind < width) {
                            next[behind] += error * (3f / 16f)
                        }
                    }
                }
                val swap = curr
                curr = next
                next = swap
            }
        }
    }
}
