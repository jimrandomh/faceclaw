package com.faceclaw.app

import android.graphics.Bitmap

import java.nio.ByteBuffer

/**
 * Builds the phone-UI preview bitmap from an 8bpp grayscale frame. The
 * grayscale buffer arrives as a ByteBuffer (NativeScript marshals a JS
 * ArrayBuffer to one without copying element-by-element); doing the
 * gray-to-ARGB expansion here keeps the 165KB-per-frame loop out of the
 * JS/Java bridge, where it used to cost ~150ms per preview. The palette
 * itself is the shared PreviewPalette.
 */
class PreviewBitmapUtil private constructor() {
    companion object {
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
            val bytes = ByteArray(width * height)
            gray.get(bytes)
            val colors = PreviewPalette.expand(bytes, 0, width * height, brightenGamma, green)
            return Bitmap.createBitmap(colors, width, height, Bitmap.Config.ARGB_8888)
        }
    }
}
