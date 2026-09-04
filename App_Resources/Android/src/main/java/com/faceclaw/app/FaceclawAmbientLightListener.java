package com.faceclaw.app;

public interface FaceclawAmbientLightListener {
    /**
     * A CFW ambient-light report (settings-channel field 105) from the master
     * temple. body is the raw 24-byte ['A','L',ver,reason,...] record; it is
     * decoded on the TS side (app/native/ambient-light.ts).
     */
    void onAmbientLight(byte[] body);
}
