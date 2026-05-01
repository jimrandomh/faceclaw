package com.faceclaw.app;

public interface FaceclawAudioPacketListener {
    void onAudioPacket(byte[] data, String arm, long arrivalMs);
}
