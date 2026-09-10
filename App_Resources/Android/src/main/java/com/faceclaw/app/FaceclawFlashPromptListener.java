package com.faceclaw.app;

/** Callbacks from FaceclawFlashPromptCommunicator to the TypeScript layer. */
public interface FaceclawFlashPromptListener {
    void onLog(String line);

    /**
     * Lifecycle updates. `state` is one of: connecting, connected, prompting,
     * battery, result, cancelled, timeout, disconnected, error. `detail` carries the
     * "approved"/"declined" text for result, or an error/explanation message.
     */
    void onState(String state, String detail);

    /**
     * Battery percent of each arm, read after the user approved (or right
     * after auth when the prompt is skipped); -1 when an arm didn't answer.
     * Always fires before onResult(true).
     */
    void onBattery(int rightPercent, int leftPercent);

    /** Fires once the user picks a menu row (or, with skipPrompt, once the battery is read): true = flash, false = cancel. */
    void onResult(boolean approved);
}
