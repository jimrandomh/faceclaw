package com.faceclaw.app

/** Callback interface implemented from TypeScript (app/native/neural-band.ts) to receive FaceclawNeuralBand events. */
interface FaceclawNeuralBandListener {
    /**
     * One event as a JSON object with a `type`: "status" (the whole status snapshot),
     * "gesture" (`gesture` and, for pinches, `finger`), "discovered" (`name`, `address`,
     * `rssi`) or "log" (`text`). Delivered on the thread that registered the listener.
     */
    fun onEvent(json: String?): Unit
}
