@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package com.faceclaw.app

import platform.Foundation.NSData

/** ColorGlyphArt for FaceclawFontRenderer.m, which draws color glyphs with CoreGraphics. */
object IosColorGlyph {
    /**
     * The shade (one byte per pixel) of a color glyph drawn as premultiplied RGBA bytes, as a
     * kCGImageAlphaPremultipliedLast context lays them out. Empty data for a malformed buffer
     * rather than an exception, which would terminate the app on its way into Objective-C.
     */
    fun shade(rgba: NSData): NSData {
        val bytes = rgba.byteArray()
        if (bytes.isEmpty() || bytes.size % 4 != 0) return NSData()
        val argb = IntArray(bytes.size / 4) { i ->
            val a = bytes[i * 4 + 3].toInt() and 0xff
            fun channel(offset: Int): Int {
                if (a == 0) return 0
                val premultiplied = bytes[i * 4 + offset].toInt() and 0xff
                return ((premultiplied * 255 + a / 2) / a).coerceAtMost(255)
            }
            (a shl 24) or (channel(0) shl 16) or (channel(1) shl 8) or channel(2)
        }
        return ColorGlyphArt.shade(argb).data()
    }
}
