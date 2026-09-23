package com.faceclaw.app

import android.util.Log

class FaceclawLc3Decoder {
    companion object {
        private const val TAG = "FaceclawLc3"
        const val SAMPLE_RATE = 16000
        const val FRAME_US = 10000
        const val FRAME_BYTES = 40
        const val FRAMES_PER_PACKET = 5
        const val PACKET_BYTES = 205
        const val COUNTER_OFFSET = 204
        const val SAMPLES_PER_FRAME = 160
        const val SAMPLES_PER_PACKET = FRAMES_PER_PACKET * SAMPLES_PER_FRAME
        // Trailer layout (firmware service_audio.c): after the 200 LC3 bytes the
        // glasses DSP appends two signed 16-bit LE values computed on the raw
        // stereo capture before the mono downmix — a signal-strength ratio and the
        // asin-derived direction-of-arrival in degrees — then the packet counter.
        const val SSR_OFFSET = 200
        const val ANGLE_OFFSET = 202

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

    private var nativeHandle: Long
    private var lastCounter = -1
    private var realPackets: Long = 0
    private var duplicatePackets: Long = 0
    private var missingPackets: Long = 0
    private var decodeErrors: Long = 0
    private var lastSsr = 0
    private var lastAngleDegrees = 0

    init {
        nativeHandle = nativeCreate(FRAME_US, SAMPLE_RATE)
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
            decodeErrors++
            Log.w(TAG, "unexpected G2 audio packet length=" + (packet?.size ?: -1))
            return 0
        }
        if (pcmOut == null || pcmOut.size < SAMPLES_PER_PACKET) {
            throw IllegalArgumentException("pcmOut must hold $SAMPLES_PER_PACKET samples")
        }

        val counter = packet[COUNTER_OFFSET].toInt() and 0xff
        if (lastCounter >= 0) {
            val gap = (counter - lastCounter) and 0xff
            if (gap == 0) {
                duplicatePackets++
                return 0
            }
            val missing = gap - 1
            if (missing > 0) {
                missingPackets += missing.toLong()
            }
        }

        val decoded = nativeDecodePacket(nativeHandle, packet, pcmOut)
        if (decoded <= 0) {
            decodeErrors++
            return 0
        }
        realPackets++
        lastCounter = counter
        lastSsr = ((packet[SSR_OFFSET].toInt() and 0xff) or (packet[SSR_OFFSET + 1].toInt() shl 8)).toShort().toInt()
        lastAngleDegrees = ((packet[ANGLE_OFFSET].toInt() and 0xff) or (packet[ANGLE_OFFSET + 1].toInt() shl 8)).toShort().toInt()
        return decoded
    }

    /** Firmware signal-strength ratio from the most recent decoded packet. */
    @Synchronized
    fun getLastSsr(): Int {
        return lastSsr
    }

    /** Firmware direction-of-arrival (signed degrees) from the most recent decoded packet. */
    @Synchronized
    fun getLastAngleDegrees(): Int {
        return lastAngleDegrees
    }

    @Synchronized
    fun getRealPackets(): Long {
        return realPackets
    }

    @Synchronized
    fun getDuplicatePackets(): Long {
        return duplicatePackets
    }

    @Synchronized
    fun getMissingPackets(): Long {
        return missingPackets
    }

    @Synchronized
    fun getDecodeErrors(): Long {
        return decodeErrors
    }

    @Synchronized
    fun close() {
        val handle = nativeHandle
        nativeHandle = 0
        if (handle != 0L) {
            nativeDestroy(handle)
        }
    }
}
