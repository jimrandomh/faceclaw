package com.faceclaw.app

import kotlin.jvm.JvmStatic

/** Decodes the LC3 frames of one G2 packet into [pcmOut]; returns samples written, <= 0 on error. */
interface Lc3Codec {
    fun decodeFrames(packet: ByteArray, offset: Int, length: Int, pcmOut: ShortArray): Int
}

/**
 * G2 microphone packet framing shared by the Android JNI decoder and the iOS port: length
 * check, counter-based duplicate/late/missing accounting, trailer parsing and statistics.
 * The codec itself (liblc3) is injected.
 *
 * Both arms may relay the same packet, so a counter gap of 0 or >= 128 (a late copy, including
 * across the 255 -> 0 wrap) is dropped before it can disturb the decoder's history. The
 * former Android decoder only dropped gap == 0; this adopts the wrap-safe rule the iOS
 * decoder already used.
 */
class Lc3PacketFramer(private val codec: Lc3Codec) {
    companion object {
        const val SAMPLE_RATE = 16000
        const val FRAME_US = 10000
        const val FRAME_BYTES = 40
        const val FRAMES_PER_PACKET = 5
        const val PACKET_BYTES = 205
        const val COUNTER_OFFSET = 204
        const val SAMPLES_PER_FRAME = 160
        const val SAMPLES_PER_PACKET = FRAMES_PER_PACKET * SAMPLES_PER_FRAME
        const val LC3_BYTES = FRAME_BYTES * FRAMES_PER_PACKET
        // Trailer layout (firmware service_audio.c): after the 200 LC3 bytes the
        // glasses DSP appends two signed 16-bit LE values computed on the raw
        // stereo capture before the mono downmix — a signal-strength ratio and the
        // asin-derived direction-of-arrival in degrees — then the packet counter.
        const val SSR_OFFSET = 200
        const val ANGLE_OFFSET = 202
        /** Counter gaps at or beyond this are late copies, not losses. */
        const val LATE_GAP = 128

        @JvmStatic
        fun readTrailerS16(packet: ByteArray, offset: Int): Int =
            ((packet[offset].toInt() and 0xff) or (packet[offset + 1].toInt() shl 8)).toShort().toInt()
    }

    private var lastCounter = -1
    var realPackets: Long = 0
        private set
    var duplicatePackets: Long = 0
        private set
    var missingPackets: Long = 0
        private set
    var decodeErrors: Long = 0
        private set
    /** Firmware signal-strength ratio from the most recent decoded packet. */
    var lastSsr: Int = 0
        private set
    /** Firmware direction-of-arrival (signed degrees) from the most recent decoded packet. */
    var lastAngleDegrees: Int = 0
        private set

    /**
     * Returns the number of PCM samples written to [pcmOut], or 0 when the packet was dropped
     * (wrong length, duplicate/late, or codec failure; see the counters).
     */
    fun decodePacket(packet: ByteArray?, pcmOut: ShortArray?): Int {
        if (packet == null || packet.size != PACKET_BYTES) {
            decodeErrors++
            return 0
        }
        if (pcmOut == null || pcmOut.size < SAMPLES_PER_PACKET) {
            throw IllegalArgumentException("pcmOut must hold $SAMPLES_PER_PACKET samples")
        }
        val counter = packet[COUNTER_OFFSET].toInt() and 0xff
        if (lastCounter >= 0) {
            val gap = (counter - lastCounter) and 0xff
            if (gap == 0 || gap >= LATE_GAP) {
                duplicatePackets++
                return 0
            }
            missingPackets += (gap - 1).toLong()
        }
        val decoded = codec.decodeFrames(packet, 0, LC3_BYTES, pcmOut)
        if (decoded <= 0) {
            decodeErrors++
            return 0
        }
        realPackets++
        lastCounter = counter
        lastSsr = readTrailerS16(packet, SSR_OFFSET)
        lastAngleDegrees = readTrailerS16(packet, ANGLE_OFFSET)
        return decoded
    }
}
