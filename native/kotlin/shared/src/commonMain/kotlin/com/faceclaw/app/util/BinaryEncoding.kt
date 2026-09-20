package com.faceclaw.app

import kotlin.jvm.JvmStatic

/** Binary encodings shared by firmware downloads and audio recordings. */
object BinaryEncoding {
    @JvmStatic
    fun bytesToHex(bytes: ByteArray?): String {
        if (bytes == null) return ""
        val digits = "0123456789abcdef"
        return buildString(bytes.size * 2) {
            for (byte in bytes) {
                val value = byte.toInt() and 255
                append(digits[value ushr 4])
                append(digits[value and 15])
            }
        }
    }

    @JvmStatic
    fun wavHeader(pcmBytes: Int, sampleRate: Int, channels: Int): ByteArray {
        val out = ByteSink(44)
        fun u16(value: Int) {
            out.write(value)
            out.write(value ushr 8)
        }
        fun u32(value: Int) {
            u16(value)
            u16(value ushr 16)
        }
        out.write("RIFF".encodeToByteArray())
        u32(36 + pcmBytes)
        out.write("WAVEfmt ".encodeToByteArray())
        u32(16)
        u16(1)
        u16(channels)
        u32(sampleRate)
        u32(sampleRate * channels * 2)
        u16(channels * 2)
        u16(16)
        out.write("data".encodeToByteArray())
        u32(pcmBytes)
        return out.toByteArray()
    }
}
