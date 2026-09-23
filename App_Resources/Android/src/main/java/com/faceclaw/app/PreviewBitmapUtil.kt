package com.faceclaw.app

import android.graphics.Bitmap

import java.nio.ByteBuffer

/**
 * Builds the phone-UI preview bitmap from an 8bpp grayscale frame. The
 * grayscale buffer arrives as a ByteBuffer (NativeScript marshals a JS
 * ArrayBuffer to one without copying element-by-element); doing the
 * gray-to-ARGB expansion here keeps the 165KB-per-frame loop out of the
 * JS/Java bridge, where it used to cost ~150ms per preview.
 */
class PreviewBitmapUtil private constructor() {
    companion object {
        private var cachedLut: IntArray? = null
        private var cachedGammaBits: Long = 0
        private var cachedGreen: Boolean = false

        /** Reuse the current preview palette; rebuild only when gamma or color changes. */
        @JvmStatic
        @Synchronized
        private fun lookupTable(brightenGamma: Double, green: Boolean): IntArray {
            val gammaBits = java.lang.Double.doubleToLongBits(brightenGamma)
            val cached = cachedLut
            if (cached != null && cachedGammaBits == gammaBits && cachedGreen == green) {
                return cached
            }
            val lut = IntArray(256)
            for (g in 0 until 256) {
                val v = Math.max(0L, Math.min(255L, Math.round(255 * Math.pow(g / 255.0, brightenGamma)))).toInt()
                lut[g] = if (green) (0xff000000.toInt() or (v shl 8)) else (0xff000000.toInt() or (v shl 16) or (v shl 8) or v)
            }
            cachedGammaBits = gammaBits
            cachedGreen = green
            cachedLut = lut
            return lut
        }

        @JvmStatic
        fun fromGray(gray: ByteBuffer?, width: Int, height: Int, brightenGamma: Double): Bitmap {
            return fromGray(gray, width, height, brightenGamma, false)
        }

        /** As above; `green` renders green-on-black (matching the physical glasses) instead of grayscale. */
        @JvmStatic
        fun fromGray(gray: ByteBuffer?, width: Int, height: Int, brightenGamma: Double, green: Boolean): Bitmap {
            if (gray == null || width <= 0 || height <= 0 || gray.remaining() < width * height) {
                throw IllegalArgumentException("invalid gray preview buffer")
            }
            val lut = lookupTable(brightenGamma, green)
            val bytes = ByteArray(width * height)
            gray.get(bytes)
            val colors = IntArray(width * height)
            for (i in colors.indices) {
                colors[i] = lut[bytes[i].toInt() and 0xff]
            }
            return Bitmap.createBitmap(colors, width, height, Bitmap.Config.ARGB_8888)
        }
    }
}
