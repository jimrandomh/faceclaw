package com.faceclaw.app

import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.test.*

class NotificationIconArtTest {
    private val outputSize = 12
    private val size = outputSize * NotificationIconArt.ANALYSIS_SCALE

    private val clear = 0
    private val white = argb(255, 255, 255, 255)
    private val black = argb(255, 0, 0, 0)
    private val blue = argb(255, 0, 0, 255)
    private val green = argb(255, 20, 160, 70)

    private fun argb(a: Int, r: Int, g: Int, b: Int): Int = (a shl 24) or (r shl 16) or (g shl 8) or b

    private fun icon(pixel: (x: Int, y: Int) -> Int): IntArray = IntArray(size * size) { pixel(it % size, it / size) }

    private fun inCircle(x: Int, y: Int, cx: Double, cy: Double, r: Double): Boolean {
        val dx = x + 0.5 - cx
        val dy = y + 0.5 - cy
        return dx * dx + dy * dy <= r * r
    }

    /** A rounded square inset from the image edge. */
    private fun inRoundedSquare(x: Int, y: Int, inset: Int, radius: Int): Boolean {
        val lo = inset
        val hi = size - 1 - inset
        if (x < lo || x > hi || y < lo || y > hi) return false
        val cx = x.coerceIn(lo + radius, hi - radius)
        val cy = y.coerceIn(lo + radius, hi - radius)
        return inCircle(x, y, cx + 0.5, cy + 0.5, radius + 0.5)
    }

    /** A horizontal bar across the middle, in analysis pixels aligned to output pixels. */
    private fun inBar(x: Int, y: Int): Boolean = y in 10..13 && x in 6..17

    private fun gray(art: NotificationIconArt.Art, ox: Int, oy: Int): Int = art.gray[oy * outputSize + ox].toInt() and 0xff

    @Test fun emptyIconIsEmpty() {
        val art = NotificationIconArt.convert(IntArray(size * size), outputSize)
        assertEquals(NotificationIconArt.Kind.EMPTY, art.kind)
        assertTrue(art.gray.all { it.toInt() == 0 })
    }

    @Test fun ringWithNoisyColorsIsATemplate() {
        // Discord-style: the alpha is a clean shape with a hole, the colors are garbage.
        var seed = 12345
        val pixels = icon { x, y ->
            seed = seed * 1103515245 + 12345
            val inRing = inCircle(x, y, 12.0, 12.0, 11.0) && !inCircle(x, y, 12.0, 12.0, 5.0)
            if (inRing) argb(255, (seed ushr 8) and 0xff, (seed ushr 16) and 0xff, (seed ushr 4) and 0xff) else clear
        }
        val art = NotificationIconArt.convert(pixels, outputSize)
        assertEquals(NotificationIconArt.Kind.TEMPLATE, art.kind)
        assertContentEquals(NotificationIconArt.template(pixels, outputSize).gray, art.gray)
        assertEquals(255, gray(art, 1, 6))
        assertEquals(0, gray(art, 6, 6))
    }

    @Test fun darkColoredTemplateStillLightsFully() {
        // A plus sign filled pure blue: by brightness it would all but vanish.
        val pixels = icon { x, y -> if ((x in 8..15 && y in 2..21) || (y in 8..15 && x in 2..21)) blue else clear }
        val art = NotificationIconArt.convert(pixels, outputSize)
        assertEquals(NotificationIconArt.Kind.TEMPLATE, art.kind)
        assertEquals(255, gray(art, 6, 2))
        assertEquals(0, gray(art, 1, 1))
    }

    @Test fun faintTemplateIsNormalizedToFullBrightness() {
        // A theme tint like #8A000000 leaves the whole shape at 54% alpha.
        val pixels = icon { x, y -> if (x in 4..19 && y in 4..19 && !(x in 8..15 && y in 8..15)) argb(138, 0, 0, 0) else clear }
        val art = NotificationIconArt.convert(pixels, outputSize)
        assertEquals(NotificationIconArt.Kind.TEMPLATE, art.kind)
        assertEquals(255, gray(art, 2, 2))
    }

    @Test fun squareWithCutOutIsATemplate() {
        val pixels = icon { x, y -> if (inBar(x, y)) clear else white }
        assertEquals(NotificationIconArt.Kind.TEMPLATE, NotificationIconArt.convert(pixels, outputSize).kind)
    }

    @Test fun oneColorDiscIsSolid() {
        val pixels = icon { x, y -> if (inCircle(x, y, 12.0, 12.0, 11.0)) blue else clear }
        val art = NotificationIconArt.convert(pixels, outputSize)
        assertEquals(NotificationIconArt.Kind.SOLID, art.kind)
        assertEquals(255, gray(art, 6, 6))
        assertEquals(0, gray(art, 0, 0))
    }

    @Test fun lightGlyphOnColoredTileIsExtracted() {
        val pixels = icon { x, y ->
            when {
                !inRoundedSquare(x, y, 0, 5) -> clear
                inBar(x, y) -> white
                else -> green
            }
        }
        val art = NotificationIconArt.convert(pixels, outputSize)
        assertEquals(NotificationIconArt.Kind.GLYPH, art.kind)
        assertEquals(255, gray(art, 6, 5))
        assertEquals(0, gray(art, 6, 2))
        assertEquals(0, gray(art, 1, 6))
    }

    @Test fun darkGlyphOnWhiteCircleIsLitNotTheCircle() {
        val pixels = icon { x, y ->
            when {
                !inCircle(x, y, 12.0, 12.0, 11.5) -> clear
                inBar(x, y) -> black
                else -> white
            }
        }
        val art = NotificationIconArt.convert(pixels, outputSize)
        assertEquals(NotificationIconArt.Kind.GLYPH, art.kind)
        assertEquals(255, gray(art, 6, 5))
        assertEquals(0, gray(art, 6, 2))
    }

    @Test fun tileWithTransparentMarginIsStillATile() {
        val pixels = icon { x, y ->
            when {
                !inRoundedSquare(x, y, 2, 3) -> clear
                inBar(x, y) -> white
                else -> green
            }
        }
        assertEquals(NotificationIconArt.Kind.GLYPH, NotificationIconArt.convert(pixels, outputSize).kind)
    }

    @Test fun gradientTileIsReadAsAPicture() {
        val pixels = icon { x, _ -> val v = x * 10; argb(255, v, v, v) }
        val art = NotificationIconArt.convert(pixels, outputSize)
        assertEquals(NotificationIconArt.Kind.PICTURE, art.kind)
        assertTrue(gray(art, 1, 6) < gray(art, 6, 6))
        assertTrue(gray(art, 6, 6) < gray(art, 10, 6))
        assertEquals(255, gray(art, 11, 6))
    }

    @Test fun templateConversionIgnoresColors() {
        val pixels = icon { x, y -> if (inBar(x, y)) white else green }
        val art = NotificationIconArt.template(pixels, outputSize)
        assertEquals(NotificationIconArt.Kind.TEMPLATE, art.kind)
        assertTrue(art.gray.all { (it.toInt() and 0xff) == 255 })
    }

    @Test fun downscaleAveragesCoverageThenAppliesTheToneCurve() {
        // Alternate opaque and clear columns: every output pixel is half covered.
        val pixels = icon { x, _ -> if (x % 2 == 0) white else clear }
        val art = NotificationIconArt.convert(pixels, outputSize)
        assertEquals(NotificationIconArt.Kind.TEMPLATE, art.kind)
        val expected = (255 * 0.5.pow(NotificationIconArt.GAMMA)).roundToInt()
        assertTrue(art.gray.all { (it.toInt() and 0xff) == expected })
    }

    @Test fun rejectsTheWrongPixelCount() {
        assertFailsWith<IllegalArgumentException> { NotificationIconArt.convert(IntArray(10), outputSize) }
    }
}
