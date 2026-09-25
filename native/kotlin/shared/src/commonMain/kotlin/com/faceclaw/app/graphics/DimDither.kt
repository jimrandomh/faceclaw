package com.faceclaw.app

import kotlin.math.abs
import kotlin.math.pow

/**
 * Color-remap tables that dim the display by a light factor using a checkerboard dither.
 *
 * The panel's response looks roughly linear in light, so level 1 already emits 1/15 of full
 * brightness, and remapping each level to a single darker level has too little resolution
 * near black. A dimmed level 1 is either unchanged or gone. Instead each level maps to a
 * pair of adjacent levels, one for pixels with even x+y and one for odd x+y. That gives
 * half-step averages, e.g. level 1 becomes a 1/0 halftone.
 */
object DimDither {
    /** Relative light output of each level; replace with measurements if the panel isn't linear. */
    private val levelLight = DoubleArray(16) { it.toDouble() }

    /** Half-step k shows ceil(k/2) on even pixels and floor(k/2) on odd ones. */
    private val halfStepLight = DoubleArray(31) { k -> (levelLight[(k + 1) / 2] + levelLight[k / 2]) / 2 }

    /** Comparable perceived lightness (CIE L* is affine in the cube root at these levels). */
    private fun lightness(light: Double) = light.pow(1.0 / 3)

    /**
     * Even- and odd-parity tables scaling light to factor256/256. Each level takes the half-step
     * perceptually nearest its dimmed light, never brighter than the original, and a visible
     * level keeps at least the 1/0 halftone.
     */
    fun tables(factor256: Int): Pair<IntArray, IntArray> {
        require(factor256 in 0..256)
        val even = IntArray(16)
        val odd = IntArray(16)
        for (level in 1..15) {
            val target = lightness(levelLight[level] * factor256 / 256)
            val step = (1..2 * level).minBy { abs(lightness(halfStepLight[it]) - target) }
            even[level] = (step + 1) / 2
            odd[level] = step / 2
        }
        return even to odd
    }
}
