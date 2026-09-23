package com.faceclaw.app

import android.util.Log

/**
 * Android LC3 decoder for G2 microphone packets: the liblc3 JNI codec behind the shared
 * [Lc3PacketFramer], which owns the counter/duplicate/trailer logic and statistics.
 */
class FaceclawLc3Decoder {
    companion object {
        private const val TAG = "FaceclawLc3"
        const val SAMPLE_RATE = Lc3PacketFramer.SAMPLE_RATE
        const val FRAME_US = Lc3PacketFramer.FRAME_US
        const val FRAME_BYTES = Lc3PacketFramer.FRAME_BYTES
        const val FRAMES_PER_PACKET = Lc3PacketFramer.FRAMES_PER_PACKET
        const val PACKET_BYTES = Lc3PacketFramer.PACKET_BYTES
        const val COUNTER_OFFSET = Lc3PacketFramer.COUNTER_OFFSET
        const val SAMPLES_PER_FRAME = Lc3PacketFramer.SAMPLES_PER_FRAME
        const val SAMPLES_PER_PACKET = Lc3PacketFramer.SAMPLES_PER_PACKET
        const val SSR_OFFSET = Lc3PacketFramer.SSR_OFFSET
        const val ANGLE_OFFSET = Lc3PacketFramer.ANGLE_OFFSET

        init {
            System.loadLibrary("faceclaw_lc3")
        }

        @JvmStatic
        private external fun nativeCreate(frameUs: Int, sampleRate: Int): Long
        @JvmStatic
        private external fun nativeDecodePacket(handle: Long, packet: ByteArray, pcmOut: ShortArray): Int
        @JvmStatic
        private external fun nativeDestroy(handle: Long)
    }

    private var nativeHandle: Long = nativeCreate(FRAME_US, SAMPLE_RATE)
    private val framer = Lc3PacketFramer(object : Lc3Codec {
        override fun decodeFrames(packet: ByteArray, offset: Int, length: Int, pcmOut: ShortArray): Int {
            // The JNI entry decodes the five 40-byte frames at the start of the packet.
            return nativeDecodePacket(nativeHandle, packet, pcmOut)
        }
    })

    init {
        if (nativeHandle == 0L) {
            throw IllegalStateException("Could not create LC3 decoder")
        }
    }

    @Synchronized
    fun decodePacket(packet: ByteArray?, pcmOut: ShortArray?): Int {
        if (nativeHandle == 0L) {
            throw IllegalStateException("LC3 decoder is closed")
        }
        if (packet == null || packet.size != PACKET_BYTES) {
            Log.w(TAG, "unexpected G2 audio packet length=" + (packet?.size ?: -1))
        }
        return framer.decodePacket(packet, pcmOut)
    }

    /** Firmware signal-strength ratio from the most recent decoded packet. */
    @Synchronized
    fun getLastSsr(): Int = framer.lastSsr

    /** Firmware direction-of-arrival (signed degrees) from the most recent decoded packet. */
    @Synchronized
    fun getLastAngleDegrees(): Int = framer.lastAngleDegrees

    @Synchronized
    fun getRealPackets(): Long = framer.realPackets

    @Synchronized
    fun getDuplicatePackets(): Long = framer.duplicatePackets

    @Synchronized
    fun getMissingPackets(): Long = framer.missingPackets

    @Synchronized
    fun getDecodeErrors(): Long = framer.decodeErrors

    @Synchronized
    fun close() {
        val handle = nativeHandle
        nativeHandle = 0
        if (handle != 0L) {
            nativeDestroy(handle)
        }
    }
}
