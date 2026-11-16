package com.faceclaw.app

import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.test.*

class ColorGlyphArtTest {
    private val size = 16

    private val clear = 0
    private val white = argb(255, 255, 255, 255)
    private val yellow = argb(255, 255, 204, 50)
    private val brown = argb(255, 90, 50, 20)
    private val darkGray = argb(255, 60, 60, 60)
    private val green = argb(255, 120, 170, 60)
    private val red = argb(255, 230, 60, 50)
    private val lightRed = argb(255, 250, 140, 130)

    private fun argb(a: Int, r: Int, g: Int, b: Int): Int = (a shl 24) or (r shl 16) or (g shl 8) or b

    private fun glyph(pixel: (x: Int, y: Int) -> Int): IntArray = IntArray(size * size) { pixel(it % size, it / size) }

    private fun inDisc(x: Int, y: Int): Boolean {
        val dx = x + 0.5 - size / 2.0
        val dy = y + 0.5 - size / 2.0
        return dx * dx + dy * dy <= 7.0 * 7.0
    }

    private fun at(shade: ByteArray, x: Int, y: Int): Int = shade[y * size + x].toInt() and 0xff

    private fun lit(level: Double): Int = (255 * level.pow(NotificationIconArt.GAMMA)).roundToInt()

    @Test fun whiteGlyphIsItsAlpha() {
        // An ordinary glyph drawn in white: antialiased edges, no color anywhere.
        val pixels = glyph { x, y -> if (x in 4..11) argb(if (x == 4 || x == 11) 90 else 255, 255, 255, 255) else clear }
        assertFalse(ColorGlyphArt.isColor(pixels))
        assertContentEquals(ByteArray(pixels.size) { ((pixels[it] ushr 24) and 0xff).toByte() }, ColorGlyphArt.coverage(pixels))
    }

    @Test fun faintColorFringeIsNotColor() {
        // Unpremultiplying a nearly transparent pixel can land anywhere; only real ink counts.
        val pixels = glyph { x, _ -> if (x == 3) argb(8, 0, 0, 0) else if (x in 4..11) white else clear }
        assertFalse(ColorGlyphArt.isColor(pixels))
    }

    @Test fun oneColorGlyphLightsFully() {
        // 🖤: dark by lightness, but its shape is what matters.
        val pixels = glyph { x, y -> if (inDisc(x, y)) darkGray else clear }
        assertTrue(ColorGlyphArt.isColor(pixels))
        val shade = ColorGlyphArt.coverage(pixels)
        assertEquals(255, at(shade, 8, 8))
        assertEquals(0, at(shade, 0, 0))
    }

    @Test fun darkDetailOnALightBodyStaysVisibleButDim() {
        // 😀: a yellow disc with dark eyes and mouth; the body stays full, the features dim.
        val pixels = glyph { x, y ->
            when {
                !inDisc(x, y) -> clear
                (y in 5..6 && (x == 5 || x == 10)) || (y == 11 && x in 5..10) -> brown
                else -> yellow
            }
        }
        val shade = ColorGlyphArt.coverage(pixels)
        assertEquals(255, at(shade, 8, 8))
        assertEquals(lit(0.3), at(shade, 5, 5))
        assertTrue(at(shade, 5, 5) > 0)
    }

    @Test fun lightDetailOnADarkerBodyDimsTheBody() {
        // ✅: a green tile with a large white check; the check lights fully above a dimmer tile.
        val pixels = glyph { x, y ->
            when {
                x !in 1..14 || y !in 1..14 -> clear
                (x in 4..7 && y in 9..11) || (x in 7..12 && y in 4..8) -> white
                else -> green
            }
        }
        val shade = ColorGlyphArt.coverage(pixels)
        assertEquals(255, at(shade, 9, 6))
        assertEquals(lit(0.6), at(shade, 2, 2))
    }

    @Test fun smallHighlightLeavesTheBodyFull() {
        // ❤️: a red body with a small glint; the glint is not detail worth dimming the body for.
        val pixels = glyph { x, y ->
            when {
                !inDisc(x, y) -> clear
                x in 4..5 && y in 4..5 -> lightRed
                else -> red
            }
        }
        val shade = ColorGlyphArt.coverage(pixels)
        assertEquals(255, at(shade, 8, 8))
        assertEquals(255, at(shade, 4, 4))
    }

    @Test fun edgeAlphaScalesTheShade() {
        val pixels = glyph { x, y -> if (x == 2) argb(128, 60, 60, 60) else if (x in 3..12 && y in 3..12) darkGray else clear }
        val shade = ColorGlyphArt.coverage(pixels)
        assertEquals(128, at(shade, 2, 8))
        assertEquals(0, at(shade, 1, 8))
    }

    @Test fun emptyGlyphIsEmpty() {
        assertTrue(ColorGlyphArt.shade(IntArray(size * size)).all { it.toInt() == 0 })
    }
}
