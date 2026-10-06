package com.faceclaw.app

import kotlin.jvm.JvmStatic

/**
 * Scales one decoded video frame's luma plane into an 8bpp gray rect for a compositor surface:
 * a box filter (averaging up to [MAX_TAPS] x [MAX_TAPS] evenly spaced samples per output pixel,
 * nearest-neighbor when upscaling), then the container's display rotation, then a tone lookup.
 *
 * Only luma is read: the glasses show gray, and Y is exactly the gray a decoder hands back
 * without any color conversion. Platform code owns decoding and copies the plane into a
 * ByteArray; this class owns the pixel math. One instance serves one (source size, rotation,
 * output size) combination and reuses its scratch buffers across frames; not thread-safe.
 */
class VideoFrameScaler(
    /** Visible luma size in coded (unrotated) orientation. */
    val sourceWidth: Int,
    val sourceHeight: Int,
    /** Clockwise display rotation in degrees: 0, 90, 180 or 270. */
    val rotation: Int,
    /** Output size in display orientation. */
    val outputWidth: Int,
    val outputHeight: Int,
) {
    companion object {
        /** Most samples averaged along each axis per output pixel; bounds work for big downscales. */
        const val MAX_TAPS = 4

        /** Snap any angle to the nearest of 0/90/180/270, the only rotations containers use. */
        @JvmStatic
        fun normalizeRotation(degrees: Int): Int = (((((degrees % 360) + 360) % 360 + 45) / 90) % 4) * 90

        /**
         * Luma to display gray. Limited ("TV") range video codes black at 16 and white at 235, so
         * it is stretched to 0..255 first. Monochrome thresholds at mid-gray to 0 or 255 (a
         * 1-bit image compresses and delta-encodes far better than 16 levels); otherwise the
         * gamma curve applies, as for photos (see GrayPacket.fromArgb).
         */
        @JvmStatic
        fun toneLut(limitedRange: Boolean, gamma: Float, monochrome: Boolean): ByteArray {
            val curve = GrayPacket.toneCurve(gamma)
            val lut = ByteArray(256)
            for (y in 0 until 256) {
                val full = if (limitedRange) ((y - 16) * 255 + 109) / 219 else y
                val v = full.coerceIn(0, 255)
                lut[y] = (if (monochrome) (if (v >= 128) 255 else 0) else curve[v]).toByte()
            }
            return lut
        }

        /**
         * Sample positions for each output index along one axis: [count] entries per output,
         * evenly spaced inside that output's box of source pixels.
         */
        private fun taps(source: Int, output: Int, count: Int): IntArray {
            val positions = IntArray(output * count)
            for (i in 0 until output) {
                for (j in 0 until count) {
                    // Center of sub-box j of output i, in source pixels: (i + (j + 0.5)/count) * source / output.
                    val numerator = (i.toLong() * count + j) * 2 + 1
                    val position = (numerator * source / (2L * count * output)).toInt()
                    positions[i * count + j] = position.coerceIn(0, source - 1)
                }
            }
            return positions
        }
    }

    private val swapsAxes = rotation == 90 || rotation == 270
    /** Scaled size before rotation (coded orientation). */
    private val scaledWidth = if (swapsAxes) outputHeight else outputWidth
    private val scaledHeight = if (swapsAxes) outputWidth else outputHeight
    private val tapsX = ((sourceWidth + scaledWidth - 1) / scaledWidth).coerceIn(1, MAX_TAPS)
    private val tapsY = ((sourceHeight + scaledHeight - 1) / scaledHeight).coerceIn(1, MAX_TAPS)
    private val xs = taps(sourceWidth, scaledWidth, tapsX)
    private val ys = taps(sourceHeight, scaledHeight, tapsY)
    private val sums = IntArray(scaledWidth)
    /** Unrotated scaled frame, needed only when a rotation follows. */
    private val scaled: ByteArray? = if (rotation == 0) null else ByteArray(scaledWidth * scaledHeight)

    init {
        require(sourceWidth > 0 && sourceHeight > 0) { "bad source size ${sourceWidth}x$sourceHeight" }
        require(outputWidth > 0 && outputHeight > 0) { "bad output size ${outputWidth}x$outputHeight" }
        require(rotation == 0 || rotation == 90 || rotation == 180 || rotation == 270) { "bad rotation $rotation" }
    }

    /**
     * Scale the luma plane into [out] (outputWidth * outputHeight bytes, row-major). The visible
     * pixel (x, y) is at luma[offset + y * rowStride + x * pixelStride]; [lut] is a 256-entry
     * table from [toneLut].
     */
    fun scale(luma: ByteArray, offset: Int, rowStride: Int, pixelStride: Int, lut: ByteArray, out: ByteArray) {
        require(out.size >= outputWidth * outputHeight) { "output buffer too small" }
        val target = scaled ?: out
        val count = tapsX * tapsY
        val half = count / 2
        for (oy in 0 until scaledHeight) {
            sums.fill(0)
            for (ty in 0 until tapsY) {
                val row = offset + ys[oy * tapsY + ty] * rowStride
                var tap = 0
                for (ox in 0 until scaledWidth) {
                    var sum = 0
                    for (tx in 0 until tapsX) {
                        sum += luma[row + xs[tap++] * pixelStride].toInt() and 0xff
                    }
                    sums[ox] += sum
                }
            }
            val base = oy * scaledWidth
            for (ox in 0 until scaledWidth) {
                target[base + ox] = lut[(sums[ox] + half) / count]
            }
        }
        if (scaled != null) rotate(scaled, out)
    }

    /** Rotate the coded-orientation frame clockwise by [rotation] into display orientation. */
    private fun rotate(source: ByteArray, out: ByteArray) {
        val w = scaledWidth
        val h = scaledHeight
        for (y in 0 until outputHeight) {
            val base = y * outputWidth
            for (x in 0 until outputWidth) {
                out[base + x] = when (rotation) {
                    90 -> source[(h - 1 - x) * w + y]
                    180 -> source[(h - 1 - y) * w + (w - 1 - x)]
                    else -> source[x * w + (w - 1 - y)]
                }
            }
        }
    }
}
