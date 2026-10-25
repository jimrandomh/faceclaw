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

        /**
         * As above, showing only the cropWidth x cropHeight area at (cropX, cropY) (the
         * mirror's Scaled preview). The area may extend past the frame's edges; it is black
         * there.
         */
        @JvmStatic
        fun fromGray(gray: ByteBuffer?, width: Int, height: Int, brightenGamma: Double, green: Boolean,
                     cropX: Int, cropY: Int, cropWidth: Int, cropHeight: Int): Bitmap {
            if (gray == null || width <= 0 || height <= 0 || gray.remaining() < width * height) {
                throw IllegalArgumentException("invalid gray preview buffer")
            }
            if (cropWidth <= 0 || cropHeight <= 0) {
                throw IllegalArgumentException("invalid preview crop")
            }
            val bytes = ByteArray(width * height)
            gray.get(bytes)
            val cropped = ByteArray(cropWidth * cropHeight)
            val left = maxOf(cropX, 0)
            val right = minOf(cropX + cropWidth, width)
            if (right > left) {
                for (y in maxOf(cropY, 0) until minOf(cropY + cropHeight, height)) {
                    System.arraycopy(bytes, y * width + left, cropped, (y - cropY) * cropWidth + (left - cropX), right - left)
                }
            }
            val colors = PreviewPalette.expand(cropped, 0, cropped.size, brightenGamma, green)
            return Bitmap.createBitmap(colors, cropWidth, cropHeight, Bitmap.Config.ARGB_8888)
        }

        /**
         * A white-on-transparent bitmap of an 8bpp glasses icon (gray becomes
         * alpha; black, which the glasses show as unlit, is transparent), for
         * showing glasses artwork on the phone's dark action bar.
         */
        @JvmStatic
        fun whiteIconFromGray(gray: ByteBuffer?, width: Int, height: Int): Bitmap {
            if (gray == null || width <= 0 || height <= 0 || gray.remaining() < width * height) {
                throw IllegalArgumentException("invalid gray icon buffer")
            }
            val bytes = ByteArray(width * height)
            gray.get(bytes)
            val colors = IntArray(width * height) { i ->
                ((bytes[i].toInt() and 0xff) shl 24) or 0x00ffffff
            }
            return Bitmap.createBitmap(colors, width, height, Bitmap.Config.ARGB_8888)
        }
    }
}
