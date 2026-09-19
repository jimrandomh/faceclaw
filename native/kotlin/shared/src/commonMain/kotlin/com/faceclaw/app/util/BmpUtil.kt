package com.faceclaw.app

import kotlin.jvm.JvmStatic

class BmpUtil {
    companion object {
        @JvmStatic
        fun copyTileBmp(bmp: ByteArray?): ByteArray {
            if (((bmp == null) || (bmp.size == 0))) {
                return ByteArray(0)
            }
            return bmp.copyOf(bmp.size)
        }

        private val GRAY_TO_NIBBLE =
            ByteArray(256) { v -> if (v == 0) 0 else minOf(15, (v + 8) shr 4).toByte() }

        /**
         * The 4bpp level an 8-bit gray value packs to. Public so the texture-cache planner computes
         * a glyph draw's top color with the exact quantization the composited frame was packed
         * with.
         */
        @JvmStatic
        fun nibbleForGray(gray: Int): Int {
            return (GRAY_TO_NIBBLE[(gray and 0xff)] and 0xff)
        }

        /**
         * Pack a full-resolution 8bpp grayscale buffer (row-major, top-to-bottom, one byte per
         * pixel) into the headerless 4bpp wire format used by CFW load_image_z modes 3/6/8:
         * top-down rows, stride ceil(width/2), high nibble = left pixel. This is the canonical
         * in-memory frame format; BMP framing (needed only when an uncompressed full frame goes on
         * the wire) is added on demand by build4bppBmpFromPacked.
         */
        @JvmStatic
        fun pack4bppFromGray8(gray8: ByteArray?, width: Int, height: Int): ByteArray {
            if (((width <= 0) || (height <= 0))) {
                return ByteArray(0)
            }
            var stride: Int = ((width + 1) shr 1)
            var out: ByteArray = ByteArray((stride * height))
            if (((gray8 == null) || (gray8.size < (width * height)))) {
                return out
            }
            var pairs: Int = (width shr 1)
            var src: Int = 0
            var dst: Int = 0
            run {
                var y: Int = 0
                while ((y < height)) {
                    run {
                        var i: Int = 0
                        while ((i < pairs)) {
                            out[dst++] =
                                (((GRAY_TO_NIBBLE[(gray8[src] and 0xff)] shl 4) or
                                        (GRAY_TO_NIBBLE[(gray8[(src + 1)] and 0xff)] and 0xff)))
                                    .toByte()
                            src += 2
                            i++
                        }
                    }
                    if (((width and 1) != 0)) {
                        out[dst++] = ((GRAY_TO_NIBBLE[(gray8[src++] and 0xff)] shl 4)).toByte()
                    }
                    y++
                }
            }
            return out
        }

        /**
         * Wrap a packed 4bpp frame in BMP framing (BITMAPINFOHEADER + 16-entry gray palette,
         * bottom-up rows padded to a 4-byte stride). Only the full-frame fallback used when mode-6
         * compression does not shrink the frame still speaks BMP on the wire; everything else uses
         * the headerless packed format directly.
         */
        @JvmStatic
        fun build4bppBmpFromPacked(packed: ByteArray?, width: Int, height: Int): ByteArray {
            var packedStride: Int = ((width + 1) shr 1)
            if (
                ((((width <= 0) || (height <= 0)) || (packed == null)) ||
                    (packed.size < (packedStride * height)))
            ) {
                return ByteArray(0)
            }
            var rowStride: Int = ((packedStride + 3) and 3.inv())
            var pixelDataSize: Int = (rowStride * height)
            var fileHeaderSize: Int = 14
            var dibHeaderSize: Int = 40
            var paletteSize: Int = (16 * 4)
            var pixelOffset: Int = ((fileHeaderSize + dibHeaderSize) + paletteSize)
            var fileSize: Int = (pixelOffset + pixelDataSize)
            var buf: ByteArray = ByteArray(fileSize)
            buf[0] = 0x42
            buf[1] = 0x4
            putUint32Le(buf, 2, fileSize)
            putUint32Le(buf, 10, pixelOffset)
            putUint32Le(buf, 14, dibHeaderSize)
            putInt32Le(buf, 18, width)
            putInt32Le(buf, 22, height)
            putUint16Le(buf, 26, 1)
            putUint16Le(buf, 28, 4)
            putUint32Le(buf, 30, 0)
            putUint32Le(buf, 34, pixelDataSize)
            putUint32Le(buf, 46, 16)
            run {
                var i: Int = 0
                while ((i < 16)) {
                    var v: Int = (i * 17)
                    var base: Int = ((fileHeaderSize + dibHeaderSize) + (i * 4))
                    buf[base] = (v).toByte()
                    buf[(base + 1)] = (v).toByte()
                    buf[(base + 2)] = (v).toByte()
                    buf[(base + 3)] = 0
                    i++
                }
            }
            run {
                var bmpRow: Int = 0
                while ((bmpRow < height)) {
                    var srcY: Int = ((height - 1) - bmpRow)
                    packed.copyInto(
                        buf,
                        (pixelOffset + (bmpRow * rowStride)),
                        (srcY * packedStride),
                        (srcY * packedStride) + packedStride,
                    )
                    bmpRow++
                }
            }
            return buf
        }

        private fun putUint16Le(buf: ByteArray, offset: Int, value: Int): Unit {
            buf[offset] = ((value and 0xff)).toByte()
            buf[(offset + 1)] = (((value ushr 8) and 0xff)).toByte()
        }

        private fun putUint32Le(buf: ByteArray, offset: Int, value: Int): Unit {
            buf[offset] = ((value and 0xff)).toByte()
            buf[(offset + 1)] = (((value ushr 8) and 0xff)).toByte()
            buf[(offset + 2)] = (((value ushr 16) and 0xff)).toByte()
            buf[(offset + 3)] = (((value ushr 24) and 0xff)).toByte()
        }

        private fun putInt32Le(buf: ByteArray, offset: Int, value: Int): Unit {
            putUint32Le(buf, offset, value)
        }
    }
}
