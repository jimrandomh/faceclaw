package com.faceclaw.app

/**
 * Callbacks for one on-phone LLM generation. Like the other bridge listeners, implementations are
 * typically created on the NativeScript JS thread and FaceclawLlamaRunner posts these callbacks
 * back to that thread's Looper.
 */
interface FaceclawLlamaListener {
    /** A piece of generated text (may be a partial word). */
    fun onToken(piece: String?): Unit

    /** Generation finished: "stop" (EOG), "length", or "cancelled". */
    fun onDone(stopReason: String?): Unit

    fun onError(message: String?): Unit
}
