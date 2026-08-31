package com.faceclaw.app;

public interface FaceclawCaptionEngineListener {
    /**
     * One finished utterance. text may be empty when no ASR model is loaded
     * or recognition produced nothing; embedding is the L2-normalized
     * voice-print or null when the speaker model is unavailable or the
     * utterance was too short. startMs/endMs are on the engine's sample
     * clock (milliseconds of audio since start()).
     */
    void onUtterance(String text, float[] embedding, long startMs, long endMs, double peakRms);

    /** A speech onset was detected; the utterance is now being collected. */
    void onSpeechStart(long startMs);

    void onStatus(String status);
}
