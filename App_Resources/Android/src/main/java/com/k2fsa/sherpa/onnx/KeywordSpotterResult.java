package com.k2fsa.sherpa.onnx;

public class KeywordSpotterResult {
    private final String keyword;
    private final String[] tokens;
    private final float[] timestamps;

    public KeywordSpotterResult(String keyword, String[] tokens, float[] timestamps) {
        this.keyword = keyword == null ? "" : keyword;
        this.tokens = tokens == null ? new String[0] : tokens;
        this.timestamps = timestamps == null ? new float[0] : timestamps;
    }

    public String getKeyword() {
        return keyword;
    }

    public String[] getTokens() {
        return tokens;
    }

    public float[] getTimestamps() {
        return timestamps;
    }
}
