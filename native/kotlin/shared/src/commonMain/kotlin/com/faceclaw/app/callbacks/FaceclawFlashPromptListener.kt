package com.faceclaw.app

/** Callbacks from FaceclawFlashPromptCommunicator to the TypeScript layer. */
interface FaceclawFlashPromptListener {
    fun onLog(line: String?): Unit

    /**
     * Lifecycle updates. `state` is one of: connecting, connected, prompting, battery, result,
     * cancelled, timeout, disconnected, error. `detail` carries the "approved"/"declined" text for
     * result, or an error/explanation message.
     */
    fun onState(state: String?, detail: String?): Unit

    /**
     * Battery percent of each arm, read after the user approved (or right after auth when the
     * prompt is skipped); -1 when an arm didn't answer. Always fires before onResult(true).
     */
    fun onBattery(rightPercent: Int, leftPercent: Int): Unit

    /**
     * Fires once the user picks a menu row (or, with skipPrompt, once the battery is read): true =
     * flash, false = cancel.
     */
    fun onResult(approved: Boolean): Unit
}
