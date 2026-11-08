package com.faceclaw.app

import kotlin.jvm.JvmStatic
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.roundToInt

/**
 * Turns a color glyph (an emoji from a color font the text stack fell back to) into the
 * lit-on-black coverage the glyph pipeline carries, so it keeps its internal detail instead of
 * showing as its alpha silhouette (a face as a plain disc, ✅ as a plain square). Platform
 * rasterizers draw the glyph in white and pass unpremultiplied ARGB; this object owns the
 * pixel math so Android and iOS agree.
 *
 * Shading is by OKLab lightness relative to the glyph's body, its median lightness:
 *  - the body lights fully, so a one-color emoji (❤️, ⭐, 🖤) reads as its shape at full
 *    brightness whatever its color, the way the alpha did, rather than dim for being dark;
 *  - darker detail (eyes, mouths, the digits on 📅) falls toward [DARKEST_LIT], never off, so
 *    the silhouette stays whole;
 *  - when a fair share of the glyph is clearly lighter than the body (the check on ✅, the
 *    circle on 🎱, the eyes on 💩) the body dims toward [DIMMEST_BODY] to leave that detail
 *    room above it. Small highlights (❤️'s glint) don't count.
 * Lit values go through the notification icons' tone curve ([NotificationIconArt.GAMMA]),
 * then scale by the pixel's alpha, which stays the glyph's coverage.
 */
object ColorGlyphArt {
    /** A pixel this opaque that is not white means the glyph was not drawn in the paint's white. */
    private const val MIN_COLOR_ALPHA = 32

    /** How far below 255 a channel may sit and still count as white (unpremultiply rounding). */
    private const val WHITE_TOLERANCE = 24

    /** Lit level of the glyph's darkest detail, before the tone curve. */
    private const val DARKEST_LIT = 0.3

    /** Lit level the body dims to when the glyph has plenty of detail lighter than it. */
    private const val DIMMEST_BODY = 0.6

    /** Lightness quantile that must be clearly above the body for the body to dim: about the lightest 10%. */
    private const val LIGHT_DETAIL_QUANTILE = 0.9

    /** OKLab lightness above the body where light detail starts to dim the body, and the span to fully dimmed. */
    private const val LIGHT_DETAIL_START = 0.05
    private const val LIGHT_DETAIL_SPAN = 0.2

    /**
     * The smallest lightness spans the ramps above and below the body stretch over, so faint
     * shading on a nearly one-color glyph stays faint instead of stretching to the full range.
     */
    private const val MIN_LIGHT_SPAN = 0.15
    private const val MIN_DARK_SPAN = 0.3

    /**
     * Whether a glyph drawn in white came out in other colors, i.e. came from a color font.
     * Ordinary glyphs are white wherever they have coverage.
     */
    @JvmStatic
    fun isColor(argb: IntArray): Boolean {
        val threshold = 255 - WHITE_TOLERANCE
        for (p in argb) {
            if (alpha(p) < MIN_COLOR_ALPHA) continue
            if (((p shr 16) and 0xff) < threshold || ((p shr 8) and 0xff) < threshold || (p and 0xff) < threshold) {
                return true
            }
        }
        return false
    }

    /**
     * Coverage (one byte per pixel) of a glyph drawn in white as unpremultiplied ARGB: its alpha,
     * or for a color glyph its [shade].
     */
    @JvmStatic
    fun coverage(argb: IntArray): ByteArray =
        if (isColor(argb)) shade(argb) else ByteArray(argb.size) { alpha(argb[it]).toByte() }

    /** Lit-on-black shade (one byte per pixel) of a color glyph as unpremultiplied ARGB. */
    @JvmStatic
    fun shade(argb: IntArray): ByteArray {
        var peak = 0
        for (p in argb) peak = max(peak, alpha(p))
        val out = ByteArray(argb.size)
        if (peak == 0) return out

        // Statistics over the solid part, so antialiased edges don't skew the body.
        val cutoff = max(1, (peak + 1) / 2)
        var solid = 0
        for (p in argb) if (alpha(p) >= cutoff) solid += 1
        val sorted = DoubleArray(solid)
        var next = 0
        for (p in argb) if (alpha(p) >= cutoff) sorted[next++] = Oklab.lightness(p)
        sorted.sort()
        val body = quantile(sorted, 0.5)
        val darkest = quantile(sorted, 0.05)
        val lightest = quantile(sorted, 0.95)
        val lightDetail = quantile(sorted, LIGHT_DETAIL_QUANTILE) - body
        val dimming = ((lightDetail - LIGHT_DETAIL_START) / LIGHT_DETAIL_SPAN).coerceIn(0.0, 1.0)
        val bodyLit = 1.0 - (1.0 - DIMMEST_BODY) * dimming
        val lightSpan = max(lightest - body, MIN_LIGHT_SPAN)
        val darkSpan = max(body - darkest, MIN_DARK_SPAN)

        for (i in argb.indices) {
            val p = argb[i]
            val a = alpha(p)
            if (a == 0) continue
            val l = Oklab.lightness(p)
            val lit = if (l >= body) {
                bodyLit + (1.0 - bodyLit) * ((l - body) / lightSpan).coerceAtMost(1.0)
            } else {
                bodyLit - (bodyLit - DARKEST_LIT) * ((body - l) / darkSpan).coerceAtMost(1.0)
            }
            out[i] = (a * lit.pow(NotificationIconArt.GAMMA)).roundToInt().coerceIn(0, 255).toByte()
        }
        return out
    }

    private fun quantile(sorted: DoubleArray, q: Double): Double = sorted[((sorted.size - 1) * q).roundToInt()]

    private fun alpha(p: Int): Int = (p ushr 24) and 0xff
}
