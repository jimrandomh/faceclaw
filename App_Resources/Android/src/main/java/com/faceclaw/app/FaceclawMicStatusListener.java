package com.faceclaw.app;

public interface FaceclawMicStatusListener {
    /**
     * A CFW mic_control field-104 status record from one temple. body is the
     * raw 21-byte ['M','C',ver,...] record (decoded on the TS side); arm is
     * "L" or "R" for the temple's own BLE link, "?" if unmatched.
     */
    void onMicStatus(byte[] body, String arm);
}
