package com.faceclaw.app

import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic

/**
 * The parts of the CFW mic_control wire format the capture session speaks itself: the 'SM'
 * multi-channel stream frame each temple sends, and the fixed STOP/RENEW control records. The
 * CONFIGURE record is built by the caller (app/apps/microphones/mic-protocol.ts encodes it; the
 * contract is the header of g2flash patches/mic_control.c).
 */
object MicArrayProtocol {
    const val VERSION = 1
    const val HEADER_BYTES = 21
    const val OP_CONFIGURE = 1
    const val OP_STOP = 3
    const val OP_RENEW = 4
    /** How long an armed temple streams without a CONFIGURE or RENEW. */
    const val LEASE_MS = 90_000L
    const val FLAG_TRUNCATED = 0x80
    const val CODEC_RAW = 1
    const val FORMAT_PCM16 = 0

    /** One decoded 'SM' frame header; the samples are [payloadLength] bytes at [payloadOffset] of its packet. */
    class Frame(
        /** Low 16 bits of the temple's frame counter. */
        @JvmField val sequence: Int,
        /** The temple's own 1 ms tick when it packed the frame (unsigned 32-bit). */
        @JvmField val deviceTickMs: Long,
        @JvmField val channels: Int,
        @JvmField val sampleRate: Int,
        @JvmField val format: Int,
        @JvmField val codec: Int,
        /** The temple's own bearing estimate, in signed degrees (0 unless it was asked for one). */
        @JvmField val angleDegrees: Int,
        @JvmField val ssr: Int,
        /** The firmware cut the payload short of the samples it captured. */
        @JvmField val truncated: Boolean,
        @JvmField val payloadOffset: Int,
        @JvmField val payloadLength: Int,
    )

    /** A control record with no payload: ['M','C', version, op]. */
    @JvmStatic
    fun control(op: Int): ByteArray = byteArrayOf('M'.code.toByte(), 'C'.code.toByte(), VERSION.toByte(), op.toByte())

    @JvmStatic
    fun isConfigure(record: ByteArray?): Boolean =
        record != null && record.size >= 13 && record[0] == 'M'.code.toByte() && record[1] == 'C'.code.toByte() &&
            record[2] == VERSION.toByte() && record[3] == OP_CONFIGURE.toByte()

    /** Decodes a stream frame's header, or returns null when [data] isn't one. */
    @JvmStatic
    fun decodeFrame(data: ByteArray): Frame? {
        if (data.size < HEADER_BYTES || data[0] != 'S'.code.toByte() || data[1] != 'M'.code.toByte() || data[2] != VERSION.toByte()) {
            return null
        }
        val length = minOf(u16(data, 19), data.size - HEADER_BYTES)
        return Frame(
            sequence = u16(data, 4),
            deviceTickMs = u16(data, 6).toLong() or (u16(data, 8).toLong() shl 16),
            channels = data[10].toInt() and 0xff,
            sampleRate = u16(data, 11) * 100,
            format = data[13].toInt() and 0xff,
            codec = data[14].toInt() and 0xff,
            angleDegrees = u16(data, 15).toShort().toInt(),
            ssr = u16(data, 17).toShort().toInt(),
            truncated = (data[3].toInt() and FLAG_TRUNCATED) != 0,
            payloadOffset = HEADER_BYTES,
            payloadLength = length,
        )
    }

    /**
     * The frame's samples as interleaved PCM16 (whole sample frames only), or null when the
     * payload isn't raw 16-bit PCM or holds none.
     */
    @JvmStatic
    fun pcm16(data: ByteArray, frame: Frame): ShortArray? {
        if (frame.codec != CODEC_RAW || frame.format != FORMAT_PCM16 || frame.channels < 1) return null
        val frames = frame.payloadLength / (2 * frame.channels)
        if (frames <= 0) return null
        val samples = ShortArray(frames * frame.channels)
        var at = frame.payloadOffset
        for (index in samples.indices) {
            samples[index] = AudioSegmentation.pcm16le(data[at], data[at + 1])
            at += 2
        }
        return samples
    }

    private fun u16(data: ByteArray, at: Int): Int = (data[at].toInt() and 0xff) or ((data[at + 1].toInt() and 0xff) shl 8)
}
