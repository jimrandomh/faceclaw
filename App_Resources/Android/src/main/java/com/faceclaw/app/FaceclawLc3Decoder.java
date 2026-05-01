package com.faceclaw.app;

import android.util.Log;

public class FaceclawLc3Decoder {
    private static final String TAG = "FaceclawLc3";
    public static final int SAMPLE_RATE = 16000;
    public static final int FRAME_US = 10000;
    public static final int FRAME_BYTES = 40;
    public static final int FRAMES_PER_PACKET = 5;
    public static final int PACKET_BYTES = 205;
    public static final int COUNTER_OFFSET = 204;
    public static final int SAMPLES_PER_FRAME = 160;
    public static final int SAMPLES_PER_PACKET = FRAMES_PER_PACKET * SAMPLES_PER_FRAME;

    static {
        System.loadLibrary("faceclaw_lc3");
    }

    private long nativeHandle;
    private int lastCounter = -1;
    private long realPackets;
    private long duplicatePackets;
    private long missingPackets;
    private long decodeErrors;

    public FaceclawLc3Decoder() {
        nativeHandle = nativeCreate(FRAME_US, SAMPLE_RATE);
        if (nativeHandle == 0) {
            throw new IllegalStateException("Could not create LC3 decoder");
        }
    }

    public synchronized int decodePacket(byte[] packet, short[] pcmOut) {
        if (nativeHandle == 0) {
            throw new IllegalStateException("LC3 decoder is closed");
        }
        if (packet == null || packet.length != PACKET_BYTES) {
            decodeErrors++;
            Log.w(TAG, "unexpected G2 audio packet length=" + (packet == null ? -1 : packet.length));
            return 0;
        }
        if (pcmOut == null || pcmOut.length < SAMPLES_PER_PACKET) {
            throw new IllegalArgumentException("pcmOut must hold " + SAMPLES_PER_PACKET + " samples");
        }

        int counter = packet[COUNTER_OFFSET] & 0xff;
        if (lastCounter >= 0) {
            int gap = (counter - lastCounter) & 0xff;
            if (gap == 0) {
                duplicatePackets++;
                return 0;
            }
            int missing = gap - 1;
            if (missing > 0) {
                missingPackets += missing;
            }
        }

        int decoded = nativeDecodePacket(nativeHandle, packet, pcmOut);
        if (decoded <= 0) {
            decodeErrors++;
            return 0;
        }
        realPackets++;
        lastCounter = counter;
        return decoded;
    }

    public synchronized long getRealPackets() {
        return realPackets;
    }

    public synchronized long getDuplicatePackets() {
        return duplicatePackets;
    }

    public synchronized long getMissingPackets() {
        return missingPackets;
    }

    public synchronized long getDecodeErrors() {
        return decodeErrors;
    }

    public synchronized void close() {
        long handle = nativeHandle;
        nativeHandle = 0;
        if (handle != 0) {
            nativeDestroy(handle);
        }
    }

    private static native long nativeCreate(int frameUs, int sampleRate);
    private static native int nativeDecodePacket(long handle, byte[] packet, short[] pcmOut);
    private static native void nativeDestroy(long handle);
}
