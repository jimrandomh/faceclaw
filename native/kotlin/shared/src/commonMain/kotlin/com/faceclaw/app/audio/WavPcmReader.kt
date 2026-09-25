package com.faceclaw.app

import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic

/** RIFF/WAVE header walk shared by the AAC transcoder and the diarizer (16-bit PCM only). */
object WavPcmReader {
    /** Bytes of a WAV file the header walk needs at most; chunk payloads beyond it are skipped by offset. */
    const val HEADER_PREFIX_BYTES = 65536

    class WavInfo(
        @JvmField val sampleRate: Int,
        @JvmField val channels: Int,
        @JvmField val bitsPerSample: Int,
        /** Byte offset of the first PCM sample. */
        @JvmField val dataOffset: Long,
        /** PCM byte count; a zero-length data chunk (header never patched after a crash) is recovered from the file length. */
        @JvmField val dataBytes: Long,
    )

    /**
     * Parses the fmt/data chunks from [prefix], the first bytes of a WAV file of [fileLength]
     * bytes. Throws IllegalArgumentException for anything that is not 16-bit PCM WAV or whose
     * data chunk header lies beyond the prefix.
     */
    @JvmStatic
    fun parseHeader(prefix: ByteArray, fileLength: Long): WavInfo {
        require(prefix.size >= 12 && prefix[0] == 'R'.code.toByte() && prefix[1] == 'I'.code.toByte() &&
            prefix[2] == 'F'.code.toByte() && prefix[3] == 'F'.code.toByte() &&
            prefix[8] == 'W'.code.toByte() && prefix[9] == 'A'.code.toByte()) { "not a WAV file" }
        var sampleRate = 0
        var channels = 0
        var bits = 0
        var offset = 12L
        while (offset + 8 <= prefix.size) {
            val at = offset.toInt()
            val id = u32(prefix, at)
            val size = u32(prefix, at + 4).toLong() and 0xffffffffL
            offset += 8
            when (id) {
                0x20746d66 -> { // "fmt "
                    val available = minOf(size, 16L).toInt()
                    require(offset + available <= prefix.size) { "truncated fmt chunk" }
                    val f = offset.toInt()
                    val audioFormat = u16(prefix, f)
                    channels = u16(prefix, f + 2)
                    sampleRate = u32(prefix, f + 4)
                    bits = u16(prefix, f + 14)
                    require(audioFormat == 1 && bits == 16) { "only 16-bit PCM WAV is supported" }
                    offset += size
                }
                0x61746164 -> { // "data"
                    require(sampleRate != 0) { "missing fmt or data chunk" }
                    val dataBytes = if (size > 0) size else fileLength - offset
                    return WavInfo(sampleRate, channels, bits, offset, maxOf(0L, dataBytes))
                }
                else -> offset += size
            }
        }
        throw IllegalArgumentException("missing fmt or data chunk")
    }

    private fun u16(bytes: ByteArray, at: Int): Int = (bytes[at].toInt() and 0xff) or ((bytes[at + 1].toInt() and 0xff) shl 8)

    private fun u32(bytes: ByteArray, at: Int): Int = u16(bytes, at) or (u16(bytes, at + 2) shl 16)
}
