package com.faceclaw.app

import kotlin.math.cbrt
import kotlin.math.pow

/**
 * OKLab, a perceptual color space: L is lightness (0 = black, 1 = white) and equal distances
 * look about equally different. The color analysis of icons and color glyphs works in it.
 */
internal object Oklab {
    /** sRGB byte value to linear light. */
    private val SRGB_TO_LINEAR = DoubleArray(256) { value ->
        val c = value / 255.0
        if (c <= 0.04045) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
    }

    /** Writes the (L, a, b) of an ARGB pixel's color (its alpha ignored) at out[offset]. */
    fun toOklab(pixel: Int, out: DoubleArray, offset: Int) {
        val r = SRGB_TO_LINEAR[(pixel shr 16) and 0xff]
        val g = SRGB_TO_LINEAR[(pixel shr 8) and 0xff]
        val b = SRGB_TO_LINEAR[pixel and 0xff]
        val l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
        val m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
        val s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
        out[offset] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
        out[offset + 1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
        out[offset + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    }

    /** The OKLab lightness of an ARGB pixel's color (its alpha ignored). */
    fun lightness(pixel: Int): Double {
        val r = SRGB_TO_LINEAR[(pixel shr 16) and 0xff]
        val g = SRGB_TO_LINEAR[(pixel shr 8) and 0xff]
        val b = SRGB_TO_LINEAR[pixel and 0xff]
        val l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
        val m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
        val s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
        return 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
    }
}
