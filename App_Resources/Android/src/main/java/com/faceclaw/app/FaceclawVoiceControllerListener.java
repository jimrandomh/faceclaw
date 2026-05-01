package com.faceclaw.app;

public interface FaceclawVoiceControllerListener {
    void onStatus(String status);

    void onWakeWord(String keyword);

    void onTranscript(String text, boolean isFinal);
}
