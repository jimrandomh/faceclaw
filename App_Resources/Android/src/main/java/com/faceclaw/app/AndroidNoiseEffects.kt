package com.faceclaw.app

import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AudioEffect
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import java.util.ArrayList

/** Android AudioRecord effect attachment; PCM processing lives in shared Kotlin. */
class AndroidNoiseEffects {
    companion object {
        /** Whether this Android build ships the built-in capture noise suppressor. */
        @JvmStatic
        fun platformSuppressorAvailable(): Boolean {
            return try {
                NoiseSuppressor.isAvailable()
            } catch (t: Throwable) {
                false
            }
        }

        /** Short engine name for the UI. */
        @JvmStatic
        fun engineDescription(): String {
            return "spectral (phone DSP)"
        }

        /**
         * Attach the platform's built-in capture-effect chain (NoiseSuppressor,
         * AcousticEchoCanceler, AutomaticGainControl — whichever this Android
         * build provides) to a phone AudioRecord session. Only applicable when the
         * phone itself captures the audio; the BLE glasses stream must go through
         * {@link #process(byte[])} instead. The caller keeps the returned effects
         * for the life of the recording and release()s them with it.
         */
        @JvmStatic
        fun attachPlatformEffects(audioSessionId: Int): Array<AudioEffect> {
            val effects = ArrayList<AudioEffect>()
            try {
                if (NoiseSuppressor.isAvailable()) {
                    val ns = NoiseSuppressor.create(audioSessionId)
                    if (ns != null) {
                        ns.setEnabled(true)
                        effects.add(ns)
                    }
                }
                if (AcousticEchoCanceler.isAvailable()) {
                    val aec = AcousticEchoCanceler.create(audioSessionId)
                    if (aec != null) {
                        aec.setEnabled(true)
                        effects.add(aec)
                    }
                }
                if (AutomaticGainControl.isAvailable()) {
                    val agc = AutomaticGainControl.create(audioSessionId)
                    if (agc != null) {
                        agc.setEnabled(true)
                        effects.add(agc)
                    }
                }
            } catch (t: Throwable) {
                // A missing effect just means this tier is unavailable.
            }
            return effects.toTypedArray()
        }
    }
}
