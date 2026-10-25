package com.faceclaw.app

interface FaceclawCaptionEngineListener {
    /**
     * One finished utterance. text may be empty when no ASR model is loaded or recognition produced
     * nothing; embedding is the L2-normalized voice-print or null when the speaker model is
     * unavailable or the utterance was too short. startMs/endMs are on the engine's sample clock
     * (milliseconds of audio since start()).
     */
    fun onUtterance(
        text: String?,
        embedding: FloatArray?,
        startMs: Long,
        endMs: Long,
        peakRms: Double,
    ): Unit

    /** A speech onset was detected; the utterance is now being collected. */
    fun onSpeechStart(startMs: Long): Unit

    fun onStatus(status: String?): Unit

    /**
     * The worker has exited, after delivering any trailing utterance. error is null after
     * stop()/requestStop(), or the failure that ended captioning on its own.
     */
    fun onStopped(error: String?): Unit
}
