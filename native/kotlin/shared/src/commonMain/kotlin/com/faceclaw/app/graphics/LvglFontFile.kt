package com.faceclaw.app

import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic

/**
 * Reader for the serialized LVGL font image in the G2's CJK flash partition. Faceclaw bundles that
 * font because it is Source Han Sans SC Light under the SIL OFL. Proprietary fonts embedded in the
 * main firmware never pass through this class and are instead extracted on the user's phone during
 * CFW install.
 */
class LvglFontFile {
    companion object {
        private val lock = protocolPlatform().createLock()

        private fun load(path: String?): FontData? = lock.withLock {
            if (path.isNullOrEmpty()) return null
            val cached = fontCache.remove(path)
            if (cached != null) {
                fontCache[path] = cached
                return cached
            }
            try {
                val font = FontData(readFileData(path))
                fontCache[path] = font
                while (fontCache.size > FONT_CACHE_SIZE) fontCache.remove(fontCache.keys.first())
                font
            } catch (_: Exception) {
                null
            }
        }

        private const val TAG: String = "LvglFontFile"

        private const val MAPPED_BASE: Int = -2146435072

        private const val FONT_CACHE_SIZE: Int = 2

        private val fontCache: MutableMap<String, FontData> = LinkedHashMap<String, FontData>()

        /**
         * Returns [lineHeight, baseline] or an empty array when the font is invalid. The baseline
         * is measured down from the top of the line.
         */
        @JvmStatic
        fun getMetrics(path: String): ByteArray {
            var font: FontData? = load(path)
            if ((font == null)) {
                return ByteArray(0)
            }
            return byteArrayOf((font.lineHeight).toByte(), (font.baseline).toByte())
        }

        /**
         * Returns one packed glyph: u16 boxW, u16 boxH, i16 ofsX, i16 ofsY, then aligned 4bpp
         * bitmap bytes. Returns an empty array when the code point is not mapped.
         */
        @JvmStatic
        fun getGlyph(path: String, codePoint: Int): ByteArray {
            var font: FontData? = load(path)
            if ((font == null)) {
                return ByteArray(0)
            }
            var glyphId: Int? = font.codePointToGlyph.get(codePoint)
            if (((glyphId == null) || (glyphId <= 0))) {
                return ByteArray(0)
            }
            try {
                var descriptor: Int = (font.glyphDescriptors + (glyphId * 16))
                var bitmapIndex: Int = font.u32(descriptor)
                var boxWidth: Int = font.u16((descriptor + 8))
                var boxHeight: Int = font.u16((descriptor + 10))
                var offsetX: Int = font.i16((descriptor + 12))
                var offsetY: Int = font.i16((descriptor + 14))
                var stride: Int = ((boxWidth / 2) + 1)
                var bitmapLength: Int =
                    (if (((boxWidth > 0) && (boxHeight > 0))) (stride * boxHeight) else 0)
                font.check((font.glyphBitmaps + bitmapIndex), bitmapLength)
                var result: ByteArray = ByteArray((8 + bitmapLength))
                putU16(result, 0, boxWidth)
                putU16(result, 2, boxHeight)
                putU16(result, 4, offsetX)
                putU16(result, 6, offsetY)
                font.bytes.copyInto(
                    result,
                    8,
                    (font.glyphBitmaps + bitmapIndex),
                    (font.glyphBitmaps + bitmapIndex) + bitmapLength,
                )
                return result
            } catch (e: RuntimeException) {

                return ByteArray(0)
            }
        }

        private fun putU16(destination: ByteArray, offset: Int, value: Int): Unit {
            destination[offset] = ((value and 0xff)).toByte()
            destination[(offset + 1)] = (((value ushr 8) and 0xff)).toByte()
        }
    }

    constructor() {}

    private class FontData {
        @JvmField val bytes: ByteArray

        @JvmField val lineHeight: Int

        @JvmField val baseline: Int

        @JvmField val glyphBitmaps: Int

        @JvmField val glyphDescriptors: Int

        @JvmField val codePointToGlyph: MutableMap<Int, Int>

        constructor(bytes: ByteArray) {
            this.bytes = bytes
            if (
                (((((bytes.size < 0x40) || (bytes[0].toInt() != 90)) || (bytes[1].toInt() != 90)) ||
                    (bytes[2].toInt() != 90)) || (bytes[3].toInt() != 90))
            ) {
                throw IllegalArgumentException("missing ZZZZ font header")
            }
            lineHeight = u16(0x38)
            var baseLine: Int = u16(0x3a)
            baseline = (lineHeight - baseLine)
            var descriptor: Int = pointerOffset(u32(0x34))
            glyphBitmaps = pointerOffset(u32(descriptor))
            glyphDescriptors = pointerOffset(u32((descriptor + 4)))
            var cmaps: Int = pointerOffset(u32((descriptor + 8)))
            var packed: Int = u16((descriptor + 18))
            var cmapCount: Int = (packed and 0x1ff)
            var bitsPerPixel: Int = ((packed ushr 9) and 0xf)
            var bitmapFormat: Int = ((packed ushr 14) and 0x3)
            if (
                (((((lineHeight <= 0) || (baseline < 0)) || (cmapCount <= 0)) ||
                    (bitsPerPixel != 4)) || (bitmapFormat != 3))
            ) {
                throw IllegalArgumentException("unsupported LVGL font metadata")
            }
            codePointToGlyph = HashMap()
            run {
                var index: Int = 0
                while ((index < cmapCount)) {
                    readCmap((cmaps + (index * 20)))
                    index++
                }
            }
        }

        fun readCmap(address: Int): Unit {
            var rangeStart: Int = u32(address)
            var rangeLength: Int = u16((address + 4))
            var glyphIdStart: Int = u16((address + 6))
            var unicodeListPointer: Int = u32((address + 8))
            var glyphIdOffsetsPointer: Int = u32((address + 12))
            var listLength: Int = u16((address + 16))
            var type: Int = u8((address + 18))
            if ((type == 2)) {
                run {
                    var relative: Int = 0
                    while ((relative < rangeLength)) {
                        codePointToGlyph.put((rangeStart + relative), (glyphIdStart + relative))
                        relative++
                    }
                }
                return
            }
            if ((type == 0)) {
                var offsets: Int = pointerOffset(glyphIdOffsetsPointer)
                run {
                    var relative: Int = 0
                    while ((relative < rangeLength)) {
                        var offset: Int = u8((offsets + relative))
                        if (((relative != 0) && (offset == 0))) {
                            relative++
                            continue
                        }
                        codePointToGlyph.put((rangeStart + relative), (glyphIdStart + offset))
                        relative++
                    }
                }
                return
            }
            if (((type == 3) || (type == 1))) {
                var unicodeList: Int = pointerOffset(unicodeListPointer)
                var offsets: Int =
                    (if ((glyphIdOffsetsPointer == 0)) -1 else pointerOffset(glyphIdOffsetsPointer))
                run {
                    var index: Int = 0
                    while ((index < listLength)) {
                        var relative: Int = u16((unicodeList + (index * 2)))
                        var offset: Int = index
                        if ((offsets >= 0)) {
                            offset =
                                (if ((type == 1)) u16((offsets + (index * 2)))
                                else u8((offsets + index)))
                            if (((index != 0) && (offset == 0))) {
                                index++
                                continue
                            }
                        }
                        codePointToGlyph.put((rangeStart + relative), (glyphIdStart + offset))
                        index++
                    }
                }
                return
            }
            throw IllegalArgumentException(("unknown cmap type " + type))
        }

        fun u8(offset: Int): Int {
            check(offset, 1)
            return (bytes[offset] and 0xff)
        }

        fun u16(offset: Int): Int {
            check(offset, 2)
            return ((bytes[offset].toInt() and 255) or ((bytes[offset + 1].toInt() and 255) shl 8))
        }

        fun i16(offset: Int): Int {
            check(offset, 2)
            return u16(offset).toShort().toInt()
        }

        fun u32(offset: Int): Int {
            check(offset, 4)
            return u16(offset) or (u16(offset + 2) shl 16)
        }

        fun pointerOffset(pointer: Int): Int {
            var unsignedPointer: Long = (pointer.toLong() and 0xffffffffL)
            var offset: Long = (unsignedPointer - (MAPPED_BASE.toLong() and 0xffffffffL))
            if (((offset < 0) || (offset > Int.MAX_VALUE))) {
                throw IllegalArgumentException("font pointer is outside the mapped partition")
            }
            check((offset).toInt(), 1)
            return (offset).toInt()
        }

        fun check(offset: Int, length: Int): Unit {
            if ((((offset < 0) || (length < 0)) || (((offset).toLong() + length) > bytes.size))) {
                throw IllegalArgumentException("font range is out of bounds")
            }
        }
    }
}
