package com.k2fsa.sherpa.onnx;

public class OnlineRecognizerResult {
    private final String text;
    private final String[] tokens;
    private final float[] timestamps;
    private final float[] ysProbs;

    public OnlineRecognizerResult(String text, String[] tokens, float[] timestamps, float[] ysProbs) {
        this.text = text == null ? "" : text;
        this.tokens = tokens == null ? new String[0] : tokens;
        this.timestamps = timestamps == null ? new float[0] : timestamps;
        this.ysProbs = ysProbs == null ? new float[0] : ysProbs;
    }

    public String getText() {
        return text;
    }

    public String[] getTokens() {
        return tokens;
    }

    public float[] getTimestamps() {
        return timestamps;
    }

    public float[] getYsProbs() {
        return ysProbs;
    }
}
