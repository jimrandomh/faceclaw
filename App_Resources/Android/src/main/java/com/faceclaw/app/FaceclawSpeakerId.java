package com.faceclaw.app;

import android.util.Log;

import com.k2fsa.sherpa.onnx.OnlineStream;
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractor;
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig;

/**
 * Speaker voice-print extraction over sherpa-onnx. One embedding per
 * utterance; matching/enrollment happens on the TS side (cosine similarity
 * against the stored speaker profiles).
 */
public class FaceclawSpeakerId {
    private static final String TAG = "FaceclawSpeakerId";

    private SpeakerEmbeddingExtractor extractor;
    private final String modelPath;

    public FaceclawSpeakerId(String modelPath) {
        this.modelPath = modelPath;
    }

    /** Lazily loads the model; returns false when it cannot be loaded. */
    public synchronized boolean ensureLoaded() {
        if (extractor != null) {
            return true;
        }
        try {
            SpeakerEmbeddingExtractorConfig config = SpeakerEmbeddingExtractorConfig.builder()
                    .setModel(modelPath)
                    .setNumThreads(1)
                    .setDebug(false)
                    .setProvider("cpu")
                    .build();
            extractor = new SpeakerEmbeddingExtractor(config);
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "could not load speaker model at " + modelPath, t);
            extractor = null;
            return false;
        }
    }

    public synchronized int embeddingDim() {
        return extractor == null ? 0 : extractor.getDim();
    }

    /**
     * Compute an L2-normalized voice-print for one utterance of 16 kHz mono
     * S16LE PCM. Returns null when the model is unavailable or the utterance
     * is too short to embed (under ~0.5 s).
     */
    public synchronized float[] embed(byte[] pcm16le, int sampleRate) {
        if (pcm16le == null || pcm16le.length < sampleRate) {
            return null;
        }
        if (!ensureLoaded()) {
            return null;
        }
        int count = pcm16le.length / 2;
        float[] samples = new float[count];
        for (int i = 0; i < count; i++) {
            short s = (short) ((pcm16le[i * 2] & 0xff) | (pcm16le[i * 2 + 1] << 8));
            samples[i] = s / 32768.0f;
        }
        OnlineStream stream = null;
        try {
            stream = extractor.createStream();
            stream.acceptWaveform(samples, sampleRate);
            stream.inputFinished();
            if (!extractor.isReady(stream)) {
                return null;
            }
            float[] embedding = extractor.compute(stream);
            return l2Normalize(embedding);
        } catch (Throwable t) {
            Log.w(TAG, "embedding failed", t);
            return null;
        } finally {
            if (stream != null) {
                stream.release();
            }
        }
    }

    private static float[] l2Normalize(float[] v) {
        if (v == null) {
            return null;
        }
        double sum = 0;
        for (float x : v) {
            sum += (double) x * x;
        }
        double norm = Math.sqrt(sum);
        if (norm <= 0) {
            return v;
        }
        for (int i = 0; i < v.length; i++) {
            v[i] = (float) (v[i] / norm);
        }
        return v;
    }

    public synchronized void close() {
        if (extractor != null) {
            extractor.release();
            extractor = null;
        }
    }
}
