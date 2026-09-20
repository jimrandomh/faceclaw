package com.faceclaw.app

import kotlin.jvm.JvmStatic

/** Screen export codecs; filesystem destinations belong to platform adapters. */
class SharedScreenshots private constructor() {
    companion object {
        @JvmStatic
        fun encode4BitGrayPng(gray: ByteArray, width: Int, height: Int): ByteArray {
            require(width > 0 && height > 0 && gray.size >= width * height)
            val rowBytes = (width + 1) / 2
            val raw = ByteArray(height * (1 + rowBytes))
            var offset = 0
            for (y in 0 until height) {
                raw[offset++] = 0 // PNG filter: None
                for (x in 0 until width step 2) {
                    val hi = (gray[y * width + x].toInt() and 255) ushr 4
                    val lo =
                        if (x + 1 < width) (gray[y * width + x + 1].toInt() and 255) ushr 4 else 0
                    raw[offset++] = ((hi shl 4) or lo).toByte()
                }
            }
            val out = ByteSink()
            out.write(byteArrayOf(0x89.toByte(), 80, 78, 71, 13, 10, 26, 10))
            val header = ByteSink()
            writeInt(header, width)
            writeInt(header, height)
            header.write(byteArrayOf(4, 0, 0, 0, 0))
            writeChunk(out, "IHDR", header.toByteArray())
            writeChunk(out, "IDAT", deflateData(raw))
            writeChunk(out, "IEND", ByteArray(0))
            return out.toByteArray()
        }

        private fun writeChunk(out: ByteSink, type: String, data: ByteArray) {
            writeInt(out, data.size)
            val name = type.encodeToByteArray()
            out.write(name)
            out.write(data)
            var crc = -1
            for (bytes in arrayOf(name, data)) for (byte in bytes) {
                crc = crc xor (byte.toInt() and 255)
                repeat(8) { crc = (crc ushr 1) xor (if (crc and 1 != 0) 0xedb88320.toInt() else 0) }
            }
            writeInt(out, crc.inv())
        }

        private fun writeInt(out: ByteSink, value: Int) {
            out.write(value ushr 24)
            out.write(value ushr 16)
            out.write(value ushr 8)
            out.write(value)
        }
    }
}
