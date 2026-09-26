package com.faceclaw.app

import kotlin.jvm.JvmStatic
import kotlin.math.pow
import kotlin.math.roundToLong

/**
 * Palette for the phone-UI preview of an 8bpp grayscale frame: gray -> ARGB with a brightening
 * gamma, either grayscale or green-on-black (matching the physical glasses). Both platforms
 * should build their preview images from this table so they brighten identically.
 */
object PreviewPalette {
    private var cachedLut: IntArray? = null
    private var cachedGammaBits: Long = 0
    private var cachedGreen: Boolean = false
    private val lock = protocolPlatform().createLock()

    /** ARGB value for [gray] under [brightenGamma]: 255 * (gray/255)^gamma per channel. */
    @JvmStatic
    fun argb(gray: Int, brightenGamma: Double, green: Boolean): Int {
        val v = (255 * (gray / 255.0).pow(brightenGamma)).roundToLong().coerceIn(0L, 255L).toInt()
        return if (green) (0xff000000.toInt() or (v shl 8)) else (0xff000000.toInt() or (v shl 16) or (v shl 8) or v)
    }

    /** Reuse the current preview palette; rebuild only when gamma or color changes. */
    @JvmStatic
    fun lookupTable(brightenGamma: Double, green: Boolean): IntArray {
        val gammaBits = brightenGamma.toBits()
        lock.withLock {
            val cached = cachedLut
            if (cached != null && cachedGammaBits == gammaBits && cachedGreen == green) {
                return cached
            }
            val lut = IntArray(256) { argb(it, brightenGamma, green) }
            cachedGammaBits = gammaBits
            cachedGreen = green
            cachedLut = lut
            return lut
        }
    }

    /** Expands [count] gray bytes starting at [offset] to ARGB pixels through the palette. */
    @JvmStatic
    fun expand(gray: ByteArray, offset: Int, count: Int, brightenGamma: Double, green: Boolean): IntArray {
        val lut = lookupTable(brightenGamma, green)
        val colors = IntArray(count)
        for (i in 0 until count) {
            colors[i] = lut[gray[offset + i].toInt() and 0xff]
        }
        return colors
    }
}
