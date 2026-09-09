package com.faceclaw.sdk;

import org.json.JSONObject;

/** Typed assistant/refinement/transcription final results; no automatic dispatch or retry. */
public final class ProviderResult {
    private final String text, error;
    private final boolean dispatched;
    private ProviderResult(String text, String error, boolean dispatched) {
        if (text == null || text.length() > 16000) throw new IllegalArgumentException("Invalid result text");
        this.text = text; this.error = error; this.dispatched = dispatched;
    }
    public static ProviderResult success(String text) { return new ProviderResult(text, "", true); }
    /** Use only when the backend operation definitely was not dispatched. */
    public static ProviderResult unavailableBeforeDispatch() { return new ProviderResult("", "provider-unavailable", false); }
    public static ProviderResult unknownOutcome() { return new ProviderResult("", "outcome-unknown", true); }
    JSONObject data() {
        return error.isEmpty() ? Protocol.object("text", text, "stopReason", "end_turn")
            : Protocol.object("error", error, "dispatched", dispatched);
    }
    @Override public String toString() { return "ProviderResult"; }
}
