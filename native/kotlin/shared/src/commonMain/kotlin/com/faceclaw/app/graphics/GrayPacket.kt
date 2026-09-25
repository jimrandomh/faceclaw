package com.faceclaw.app

import kotlin.jvm.JvmStatic
import kotlin.math.pow
import kotlin.math.roundToInt

/**
 * Converts ARGB pixels to the grayscale packet format used across the TS bridge:
 * [widthLo, widthHi, heightLo, heightHi, pixels...] with one byte per pixel, row-major.
 * Transparent pixels darken toward black (the on-glasses background). Platform code owns
 * decoding and scaling (Bitmap / ImageIO); this object owns the pixel math so both platforms
 * produce identical tone and dither.
 */
object GrayPacket {
    const val HEADER_SIZE = 4

    /**
     * gamma > 1 darkens midtones (out = 255 * (in/255)^gamma). Source pixels are sRGB-encoded
     * but the G2 drives its 16 levels roughly linearly, so mid-gray otherwise displays far
     * brighter than intended; 2.2 undoes the sRGB encoding outright.
     *
     * dither error-diffuses against the 16 levels the frame is eventually packed to
     * (BmpUtil.GRAY_TO_NIBBLE) instead of leaving each pixel to round on its own, which turns
     * smooth gradients into visible bands. Dithered output is already quantized: every byte is
     * a level times 16, which BmpUtil re-quantizes back to exactly that level.
     */
    @JvmStatic
    fun fromArgb(pixels: IntArray, width: Int, height: Int, gamma: Float, dither: Boolean): ByteArray {
        require(width > 0 && height > 0 && pixels.size >= width * height) { "bad pixel plane" }
        val out = ByteArray(HEADER_SIZE + width * height)
        writeHeader(out, width, height)
        val tone = toneCurve(gamma)
        for (i in 0 until width * height) {
            val p = pixels[i]
            val a = (p ushr 24) and 0xff
            val r = (p shr 16) and 0xff
            val g = (p shr 8) and 0xff
            val b = p and 0xff
            out[HEADER_SIZE + i] = tone[((r * 299 + g * 587 + b * 114) / 1000) * a / 255].toByte()
        }
        if (dither) {
            ditherToDisplayLevels(out, HEADER_SIZE, width, height)
        }
        return out
    }

    @JvmStatic
    fun writeHeader(out: ByteArray, width: Int, height: Int) {
        out[0] = (width and 0xff).toByte()
        out[1] = ((width shr 8) and 0xff).toByte()
        out[2] = (height and 0xff).toByte()
        out[3] = ((height shr 8) and 0xff).toByte()
    }

    /** 256-entry map of source gray to displayed gray for out = in^gamma. */
    @JvmStatic
    fun toneCurve(gamma: Float): IntArray {
        val curve = IntArray(256)
        for (v in 0 until 256) {
            curve[v] = if (gamma == 1f) v else (255f * (v / 255f).pow(gamma)).roundToInt()
        }
        return curve
    }

    /**
     * Floyd-Steinberg error diffusion onto the display's 16 gray levels, in place over an 8bpp
     * plane. Serpentine scanning keeps the diffusion from building up a directional texture
     * across wide flat areas.
     *
     * Level n is written back as n * 16 rather than the n * 17 it stands for so that BmpUtil's
     * (v + 8) >> 4 reproduces n exactly; level 0 is written as 1, not 0, because 0 is the shell's
     * color-key for transparent.
     */
    @JvmStatic
    fun ditherToDisplayLevels(plane: ByteArray, offset: Int, width: Int, height: Int) {
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
                val level = (minOf(255f, maxOf(0f, wanted)) / 17f).roundToInt()
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
