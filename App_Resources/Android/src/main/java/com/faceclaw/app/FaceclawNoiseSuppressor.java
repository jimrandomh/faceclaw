package com.faceclaw.app;

import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.AudioEffect;
import android.media.audiofx.AutomaticGainControl;
import android.media.audiofx.NoiseSuppressor;

import java.util.ArrayList;
import java.util.Arrays;

/**
 * Phone-side noise suppression for the microphone stream.
 *
 * Android's built-in noise cancellation (the {@link NoiseSuppressor} capture
 * effect) only attaches to AudioRecord sessions on the phone's own microphones. Faceclaw's audio
 * arrives as raw PCM over BLE from the glasses, which that effect chain never
 * sees, so this class picks the best engine that can actually reach the
 * samples:
 *
 * - Audio captured by the phone itself: {@link #attachPlatformEffects(int)}
 *   enables the device's built-in NS/AEC/AGC chain (hardware or OEM software,
 *   whatever the Android build ships) on the AudioRecord session.
 * - Audio from the glasses (the normal case): {@link #process(byte[])} runs a
 *   WebRTC-NS-family spectral suppressor here on the phone — 16 ms sqrt-Hann
 *   frames at 50% overlap, per-bin asymmetric noise-floor tracking, and an
 *   over-subtracted Wiener gain with a residual floor so speech never pumps
 *   in and out of silence.
 */
public final class FaceclawNoiseSuppressor {

    private static final int FFT_SIZE = 256;
    private static final int HOP = FFT_SIZE / 2;
    private static final float OVERSUBTRACTION = 1.6f;
    /** About -16 dB of residual: keeps the noise bed natural instead of gated. */
    private static final float GAIN_FLOOR = 0.15f;
    private static final float GAIN_SMOOTHING = 0.6f;
    /** Frames of pure noise-floor learning after start/reset (~100 ms). */
    private static final int NOISE_WARMUP_FRAMES = 12;

    private final int sampleRate;
    private final float[] window = new float[FFT_SIZE];
    private final float[] history = new float[FFT_SIZE];
    private final float[] overlap = new float[HOP];
    private final float[] noise = new float[FFT_SIZE / 2 + 1];
    private final float[] gain = new float[FFT_SIZE / 2 + 1];
    private final float[] re = new float[FFT_SIZE];
    private final float[] im = new float[FFT_SIZE];
    private final short[] pending = new short[HOP];
    private int pendingCount = 0;
    private int warmupFrames = 0;

    public FaceclawNoiseSuppressor(int sampleRate) {
        this.sampleRate = sampleRate;
        // sqrt-Hann (sine) analysis+synthesis windows: exact COLA at 50% overlap.
        for (int i = 0; i < FFT_SIZE; i++) {
            window[i] = (float) Math.sin(Math.PI * (i + 0.5) / FFT_SIZE);
        }
        reset();
    }

    public int getSampleRate() {
        return sampleRate;
    }

    /** Forget the learned noise floor (e.g. after the suppressor was toggled off). */
    public void reset() {
        Arrays.fill(history, 0f);
        Arrays.fill(overlap, 0f);
        Arrays.fill(noise, 0f);
        Arrays.fill(gain, 1f);
        pendingCount = 0;
        warmupFrames = 0;
    }

    /**
     * Suppress noise in 16-bit little-endian mono PCM. Streaming: input not
     * filling a whole 8 ms hop is carried into the next call, so the output
     * may be up to one hop shorter than the input (and longer on a later
     * call); total latency is one hop.
     */
    public byte[] process(byte[] pcm16le) {
        if (pcm16le == null || pcm16le.length < 2) {
            return pcm16le;
        }
        int sampleCount = pcm16le.length / 2;
        int hops = (pendingCount + sampleCount) / HOP;
        byte[] out = new byte[hops * HOP * 2];
        int outPos = 0;
        int inPos = 0;
        while (inPos < sampleCount) {
            int take = Math.min(HOP - pendingCount, sampleCount - inPos);
            for (int i = 0; i < take; i++) {
                int lo = pcm16le[(inPos + i) * 2] & 0xff;
                int hi = pcm16le[(inPos + i) * 2 + 1];
                pending[pendingCount + i] = (short) ((hi << 8) | lo);
            }
            pendingCount += take;
            inPos += take;
            if (pendingCount == HOP) {
                outPos = processHop(out, outPos);
                pendingCount = 0;
            }
        }
        return out;
    }

    private int processHop(byte[] out, int outPos) {
        System.arraycopy(history, HOP, history, 0, FFT_SIZE - HOP);
        for (int i = 0; i < HOP; i++) {
            history[FFT_SIZE - HOP + i] = pending[i] / 32768f;
        }
        for (int i = 0; i < FFT_SIZE; i++) {
            re[i] = history[i] * window[i];
            im[i] = 0f;
        }
        fft(re, im, false);

        boolean warming = warmupFrames < NOISE_WARMUP_FRAMES;
        if (warming) {
            warmupFrames++;
        }
        for (int b = 0; b <= FFT_SIZE / 2; b++) {
            float power = re[b] * re[b] + im[b] * im[b];
            if (warming) {
                noise[b] = warmupFrames == 1 ? power : noise[b] + (power - noise[b]) / warmupFrames;
            } else if (power < noise[b]) {
                // Track the floor down quickly; drift up slowly so speech
                // energy never gets learned as noise.
                noise[b] += (power - noise[b]) * 0.2f;
            } else {
                noise[b] = Math.min(power, noise[b] * 1.006f + 1e-10f);
            }
            float clean = power - OVERSUBTRACTION * noise[b];
            float g = clean > 0f ? clean / power : 0f;
            if (g < GAIN_FLOOR) {
                g = GAIN_FLOOR;
            }
            g = GAIN_SMOOTHING * gain[b] + (1f - GAIN_SMOOTHING) * g;
            gain[b] = g;
            re[b] *= g;
            im[b] *= g;
            if (b > 0 && b < FFT_SIZE / 2) {
                re[FFT_SIZE - b] *= g;
                im[FFT_SIZE - b] *= g;
            }
        }

        fft(re, im, true);
        for (int i = 0; i < HOP; i++) {
            float value = (overlap[i] + re[i] * window[i]) * 32767f;
            int sample = Math.round(value);
            if (sample > 32767) {
                sample = 32767;
            }
            if (sample < -32768) {
                sample = -32768;
            }
            out[outPos + i * 2] = (byte) (sample & 0xff);
            out[outPos + i * 2 + 1] = (byte) ((sample >> 8) & 0xff);
        }
        for (int i = 0; i < HOP; i++) {
            overlap[i] = re[HOP + i] * window[HOP + i];
        }
        return outPos + HOP * 2;
    }

    /** In-place iterative radix-2 FFT (inverse includes the 1/N scale). */
    private static void fft(float[] re, float[] im, boolean inverse) {
        int n = re.length;
        for (int i = 1, j = 0; i < n; i++) {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) {
                j ^= bit;
            }
            j ^= bit;
            if (i < j) {
                float t = re[i];
                re[i] = re[j];
                re[j] = t;
                t = im[i];
                im[i] = im[j];
                im[j] = t;
            }
        }
        for (int len = 2; len <= n; len <<= 1) {
            double ang = 2 * Math.PI / len * (inverse ? 1 : -1);
            float wRe = (float) Math.cos(ang);
            float wIm = (float) Math.sin(ang);
            for (int i = 0; i < n; i += len) {
                float curRe = 1f;
                float curIm = 0f;
                for (int k = 0; k < len / 2; k++) {
                    int a = i + k;
                    int b = a + len / 2;
                    float xr = re[b] * curRe - im[b] * curIm;
                    float xi = re[b] * curIm + im[b] * curRe;
                    re[b] = re[a] - xr;
                    im[b] = im[a] - xi;
                    re[a] += xr;
                    im[a] += xi;
                    float nextRe = curRe * wRe - curIm * wIm;
                    curIm = curRe * wIm + curIm * wRe;
                    curRe = nextRe;
                }
            }
        }
        if (inverse) {
            for (int i = 0; i < n; i++) {
                re[i] /= n;
                im[i] /= n;
            }
        }
    }

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
