package com.faceclaw.app

import kotlin.jvm.JvmStatic
import kotlin.math.abs
import kotlin.math.cbrt
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Turns a rendered notification icon into the lit-on-black gray silhouette the glasses' status
 * bar shows: outputSize x outputSize bytes, 0 = off. Platform code picks the source drawables
 * (small icon, launcher icon layers, large icon) and renders them to ARGB at [ANALYSIS_SCALE]
 * times the output size; this object owns the pixel analysis, so the classification can be
 * tested off-device.
 *
 * Small icons are supposed to be alpha templates: the platform tints them and ignores their
 * color channels, which apps fill with anything (a brand color, Discord's noise, a theme tint).
 * Some apps instead ship a filled color tile whose alpha is just a square or circle, with the
 * shape carried by the colors; tinted, those become a blank block. The alpha's own shape tells
 * the two apart, never the colors: alpha with holes or concavities is a template and is read by
 * alpha alone, while a plain convex tile has its glyph pulled out of the tile's background color.
 */
object NotificationIconArt {
    /** Sources are rendered at this multiple of the output size, analyzed, then box-filtered down. */
    const val ANALYSIS_SCALE = 2

    /** Output gray = lit^GAMMA, for lit (coverage or glyph strength) in 0..1. */
    const val GAMMA = 1.6

    /** Below this peak alpha an icon counts as invisible. */
    private const val MIN_VISIBLE_ALPHA = 16

    /**
     * A plain tile fills at least this share of the pixel centers inside its own convex hull; a
     * digitized convex shape fills all of them. Templates have notches, gaps and separate parts.
     */
    private const val MIN_TILE_SOLIDITY = 0.92

    /** A plain tile has alpha cut-outs (holes) covering at most this share of its area. */
    private const val MAX_TILE_HOLE_SHARE = 0.005

    /** OKLab distance from the tile's background color that still counts as background. */
    private const val BACKGROUND_TOLERANCE = 0.1

    /** Share of the tile's rim that must be background-colored for the tile to have one background. */
    private const val MIN_BACKGROUND_RIM_SHARE = 0.8

    /** Weakest OKLab contrast between glyph and background worth extracting; below it the tile is solid. */
    private const val MIN_GLYPH_CONTRAST = 0.12

    /** The quantile of a tile's distances from its background taken as the glyph's color contrast. */
    private const val GLYPH_CONTRAST_QUANTILE = 0.98

    /** A picture whose middle 90% of brightness spans less than this is left unstretched. */
    private const val MIN_PICTURE_RANGE = 0.1

    enum class Kind {
        /** Nothing visible. */
        EMPTY,
        /** Alpha carries the shape: lit by alpha alone, colors ignored. */
        TEMPLATE,
        /** A plain tile with no glyph on it (a filled shape): lit by alpha like a template. */
        SOLID,
        /** A plain tile with a glyph on a one-color background: lit by color distance from the background. */
        GLYPH,
        /** A plain tile with no one background color (a photo, a gradient): lit by brightness. */
        PICTURE,
    }

    class Art(val kind: Kind, val gray: ByteArray)

    /** sRGB byte value to linear light. */
    private val SRGB_TO_LINEAR = DoubleArray(256) { value ->
        val c = value / 255.0
        if (c <= 0.04045) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
    }

    /**
     * Classify and convert an icon rendered at (outputSize * ANALYSIS_SCALE) square, row-major
     * ARGB (not premultiplied).
     */
    @JvmStatic
    fun convert(argb: IntArray, outputSize: Int): Art {
        val size = analysisSize(argb, outputSize)
        val maxAlpha = peakAlpha(argb)
        if (maxAlpha < MIN_VISIBLE_ALPHA) {
            return Art(Kind.EMPTY, ByteArray(outputSize * outputSize))
        }
        val mask = BooleanArray(argb.size) { alpha(argb[it]) * 2 >= maxAlpha }
        if (!isPlainTile(mask, size)) {
            return Art(Kind.TEMPLATE, toGray(alphaLit(argb, maxAlpha), size, outputSize))
        }
        return readTile(argb, mask, size, maxAlpha, outputSize)
    }

    /**
     * Convert an icon known to be an alpha template (a themed icon's monochrome layer, a drawn
     * initial) without classifying it: lit by alpha alone.
     */
    @JvmStatic
    fun template(argb: IntArray, outputSize: Int): Art {
        val size = analysisSize(argb, outputSize)
        val maxAlpha = peakAlpha(argb)
        if (maxAlpha < MIN_VISIBLE_ALPHA) {
            return Art(Kind.EMPTY, ByteArray(outputSize * outputSize))
        }
        return Art(Kind.TEMPLATE, toGray(alphaLit(argb, maxAlpha), size, outputSize))
    }

    private fun analysisSize(argb: IntArray, outputSize: Int): Int {
        val size = outputSize * ANALYSIS_SCALE
        require(outputSize > 0 && argb.size == size * size) { "expected ${size}x$size pixels, got ${argb.size}" }
        return size
    }

    /**
     * Whether the alpha is a plain tile (a square, circle or squircle, at any size) rather than
     * a shape: no holes worth the name, and nearly convex.
     */
    private fun isPlainTile(mask: BooleanArray, size: Int): Boolean {
        val opaque = mask.count { it }
        if (holeCount(mask, size) > opaque * MAX_TILE_HOLE_SHARE) {
            return false
        }
        return solidity(mask, size, opaque) >= MIN_TILE_SOLIDITY
    }

    /** Transparent pixels the outside can't reach through other transparent pixels (4-connected). */
    private fun holeCount(mask: BooleanArray, size: Int): Int {
        val outside = BooleanArray(mask.size)
        val stack = IntArray(mask.size)
        var top = 0
        fun visit(i: Int) {
            if (!mask[i] && !outside[i]) {
                outside[i] = true
                stack[top++] = i
            }
        }
        for (k in 0 until size) {
            visit(k)
            visit((size - 1) * size + k)
            visit(k * size)
            visit(k * size + size - 1)
        }
        while (top > 0) {
            val i = stack[--top]
            val x = i % size
            val y = i / size
            if (x > 0) visit(i - 1)
            if (x < size - 1) visit(i + 1)
            if (y > 0) visit(i - size)
            if (y < size - 1) visit(i + size)
        }
        var holes = 0
        for (i in mask.indices) {
            if (!mask[i] && !outside[i]) holes += 1
        }
        return holes
    }

    /**
     * The mask's pixel count over the number of pixel centers inside its convex hull, which
     * Pick's theorem gives from the hull's area and the lattice points on its edges.
     */
    private fun solidity(mask: BooleanArray, size: Int, opaque: Int): Double {
        // Each row's leftmost and rightmost pixels are the only hull candidates. Generated row by
        // row, they are already sorted by (y, x), the order the monotone chain below works in.
        val xs = IntArray(size * 2)
        val ys = IntArray(size * 2)
        var count = 0
        for (y in 0 until size) {
            var left = -1
            var right = -1
            for (x in 0 until size) {
                if (mask[y * size + x]) {
                    if (left < 0) left = x
                    right = x
                }
            }
            if (left < 0) continue
            xs[count] = left
            ys[count] = y
            count += 1
            if (right != left) {
                xs[count] = right
                ys[count] = y
                count += 1
            }
        }
        // Cross product in (y, x) coordinates, matching the sort order.
        fun cross(o: Int, a: Int, b: Int): Long =
            (ys[a] - ys[o]).toLong() * (xs[b] - xs[o]) - (xs[a] - xs[o]).toLong() * (ys[b] - ys[o])
        val hull = IntArray(count * 2 + 1)
        var k = 0
        for (i in 0 until count) {
            while (k >= 2 && cross(hull[k - 2], hull[k - 1], i) <= 0) k -= 1
            hull[k++] = i
        }
        val lowerSize = k + 1
        for (i in count - 2 downTo 0) {
            while (k >= lowerSize && cross(hull[k - 2], hull[k - 1], i) <= 0) k -= 1
            hull[k++] = i
        }
        // The chain ends back at its first point; with one point there is no closing repeat.
        val vertices = if (count == 1) 1 else k - 1
        var twiceArea = 0L
        var boundary = 0L
        for (v in 0 until vertices) {
            val a = hull[v]
            val b = hull[(v + 1) % vertices]
            twiceArea += xs[a].toLong() * ys[b] - xs[b].toLong() * ys[a]
            boundary += gcd(abs(xs[b] - xs[a]), abs(ys[b] - ys[a]))
        }
        val latticePoints = abs(twiceArea) / 2.0 + boundary / 2.0 + 1.0
        return opaque / latticePoints
    }

    private fun gcd(a: Int, b: Int): Int {
        var x = a
        var y = b
        while (y != 0) {
            val t = x % y
            x = y
            y = t
        }
        return x
    }

    private fun readTile(argb: IntArray, mask: BooleanArray, size: Int, maxAlpha: Int, outputSize: Int): Art {
        val lab = DoubleArray(argb.size * 3)
        for (i in argb.indices) {
            if (mask[i]) toOklab(argb[i], lab, i * 3)
        }

        // The background is the color of the tile's rim, about one output pixel deep.
        val rim = rimIndices(mask, size)
        val background = DoubleArray(3) { channel ->
            val values = DoubleArray(rim.size) { lab[rim[it] * 3 + channel] }
            values.sort()
            values[values.size / 2]
        }
        val rimDistances = DoubleArray(rim.size) { distance(lab, rim[it], background) }
        rimDistances.sort()
        val uniformRim = rimDistances.count { it <= BACKGROUND_TOLERANCE }
        if (uniformRim < rim.size * MIN_BACKGROUND_RIM_SHARE) {
            return Art(Kind.PICTURE, toGray(pictureLit(argb, mask, maxAlpha), size, outputSize))
        }

        // How far the background itself wanders, and how far the glyph stands from it.
        val noise = quantile(rimDistances, MIN_BACKGROUND_RIM_SHARE)
        val distances = DoubleArray(argb.size)
        var tileCount = 0
        for (i in argb.indices) {
            if (mask[i]) {
                distances[i] = distance(lab, i, background)
                tileCount += 1
            }
        }
        val tileDistances = DoubleArray(tileCount)
        var next = 0
        for (i in argb.indices) {
            if (mask[i]) tileDistances[next++] = distances[i]
        }
        tileDistances.sort()
        val contrast = quantile(tileDistances, GLYPH_CONTRAST_QUANTILE)
        if (contrast < max(MIN_GLYPH_CONTRAST, 2 * noise)) {
            return Art(Kind.SOLID, toGray(alphaLit(argb, maxAlpha), size, outputSize))
        }

        // Ramp from background to glyph; the glyph is lit whether it is lighter or darker than the tile.
        val low = max(noise, 0.25 * contrast)
        val high = 0.75 * contrast
        val lit = DoubleArray(argb.size) { i ->
            if (!mask[i]) {
                0.0
            } else {
                val strength = ((distances[i] - low) / (high - low)).coerceIn(0.0, 1.0)
                strength * min(1.0, alpha(argb[i]).toDouble() / maxAlpha)
            }
        }
        return Art(Kind.GLYPH, toGray(lit, size, outputSize))
    }

    /** Tile pixels within one output pixel of its edge (or the image's edge). */
    private fun rimIndices(mask: BooleanArray, size: Int): IntArray {
        var inner = mask
        repeat(ANALYSIS_SCALE) { inner = erode(inner, size) }
        val rim = ArrayList<Int>()
        for (i in mask.indices) {
            if (mask[i] && !inner[i]) rim.add(i)
        }
        return rim.toIntArray()
    }

    private fun erode(mask: BooleanArray, size: Int): BooleanArray = BooleanArray(mask.size) { i ->
        val x = i % size
        val y = i / size
        mask[i] && x > 0 && mask[i - 1] && x < size - 1 && mask[i + 1] &&
            y > 0 && mask[i - size] && y < size - 1 && mask[i + size]
    }

    /** Lit by brightness, stretched so the picture's middle 90% spans the full range. */
    private fun pictureLit(argb: IntArray, mask: BooleanArray, maxAlpha: Int): DoubleArray {
        val brightness = DoubleArray(argb.size) { i ->
            val p = argb[i]
            (0.2126 * ((p shr 16) and 0xff) + 0.7152 * ((p shr 8) and 0xff) + 0.0722 * (p and 0xff)) / 255.0
        }
        val tile = ArrayList<Double>()
        for (i in argb.indices) {
            if (mask[i]) tile.add(brightness[i])
        }
        val sorted = tile.toDoubleArray()
        sorted.sort()
        var low = quantile(sorted, 0.05)
        var high = quantile(sorted, 0.95)
        if (high - low < MIN_PICTURE_RANGE) {
            low = 0.0
            high = 1.0
        }
        return DoubleArray(argb.size) { i ->
            ((brightness[i] - low) / (high - low)).coerceIn(0.0, 1.0) * min(1.0, alpha(argb[i]).toDouble() / maxAlpha)
        }
    }

    /** Lit by alpha alone, normalized so a faint template (a theme's 54% tint) still lights fully. */
    private fun alphaLit(argb: IntArray, maxAlpha: Int): DoubleArray =
        DoubleArray(argb.size) { min(1.0, alpha(argb[it]).toDouble() / maxAlpha) }

    /** Box-filter lit values down to the output size, then apply the tone curve. */
    private fun toGray(lit: DoubleArray, size: Int, outputSize: Int): ByteArray {
        val scale = size / outputSize
        val gray = ByteArray(outputSize * outputSize)
        for (oy in 0 until outputSize) {
            for (ox in 0 until outputSize) {
                var sum = 0.0
                for (dy in 0 until scale) {
                    val row = (oy * scale + dy) * size + ox * scale
                    for (dx in 0 until scale) sum += lit[row + dx]
                }
                val mean = sum / (scale * scale)
                gray[oy * outputSize + ox] = (255.0 * mean.coerceIn(0.0, 1.0).pow(GAMMA)).roundToInt().toByte()
            }
        }
        return gray
    }

    private fun toOklab(pixel: Int, out: DoubleArray, offset: Int) {
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

    private fun distance(lab: DoubleArray, index: Int, background: DoubleArray): Double {
        val dl = lab[index * 3] - background[0]
        val da = lab[index * 3 + 1] - background[1]
        val db = lab[index * 3 + 2] - background[2]
        return sqrt(dl * dl + da * da + db * db)
    }

    private fun quantile(sorted: DoubleArray, q: Double): Double = sorted[((sorted.size - 1) * q).roundToInt()]

    private fun peakAlpha(argb: IntArray): Int {
        var peak = 0
        for (p in argb) peak = max(peak, alpha(p))
        return peak
    }

    private fun alpha(p: Int): Int = (p ushr 24) and 0xff
}
