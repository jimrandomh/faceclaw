package com.faceclaw.app;

import android.media.audiofx.*;
import java.util.ArrayList;

/** Android AudioRecord effect attachment; PCM processing lives in shared Kotlin. */
public final class AndroidNoiseEffects {
    /** Whether this Android build ships the built-in capture noise suppressor. */
    public static boolean platformSuppressorAvailable() {
        try {
            return NoiseSuppressor.isAvailable();
        } catch (Throwable t) {
            return false;
        }
    }

    /** Short engine name for the UI. */
    public static String engineDescription() {
        return "spectral (phone DSP)";
    }

    /**
     * Attach the platform's built-in capture-effect chain (NoiseSuppressor,
     * AcousticEchoCanceler, AutomaticGainControl — whichever this Android
     * build provides) to a phone AudioRecord session. Only applicable when the
     * phone itself captures the audio; the BLE glasses stream must go through
     * {@link #process(byte[])} instead. The caller keeps the returned effects
     * for the life of the recording and release()s them with it.
     */
    public static AudioEffect[] attachPlatformEffects(int audioSessionId) {
        ArrayList<AudioEffect> effects = new ArrayList<>();
        try {
            if (NoiseSuppressor.isAvailable()) {
                NoiseSuppressor ns = NoiseSuppressor.create(audioSessionId);
                if (ns != null) {
                    ns.setEnabled(true);
                    effects.add(ns);
                }
            }
            if (AcousticEchoCanceler.isAvailable()) {
                AcousticEchoCanceler aec = AcousticEchoCanceler.create(audioSessionId);
                if (aec != null) {
                    aec.setEnabled(true);
                    effects.add(aec);
                }
            }
            if (AutomaticGainControl.isAvailable()) {
                AutomaticGainControl agc = AutomaticGainControl.create(audioSessionId);
                if (agc != null) {
                    agc.setEnabled(true);
                    effects.add(agc);
                }
            }
        } catch (Throwable t) {
            // A missing effect just means this tier is unavailable.
        }
        return effects.toArray(new AudioEffect[0]);
    }
}
