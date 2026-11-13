package com.faceclaw.app

interface FaceclawVoiceControllerListener {
    fun onStatus(status: String?): Unit

    /**
     * Best transcript of the current utterance so far. REPLACE semantics: text is the complete
     * transcript, not a delta — display it verbatim, replacing any previous partial. isFinal marks
     * the end of the utterance.
     */
    fun onTranscript(text: String?, isFinal: Boolean): Unit

    /** Capture has finished, after the final transcript or a startup/recognition error. */
    fun onStopped(captureId: Int): Unit

    /**
     * Decoded microphone audio: 16 kHz mono signed 16-bit little-endian PCM. Emitted in every mode
     * so raw-PCM consumers (levels, recording, captions) keep working while the onboard recognizer
     * owns the transcript.
     */
    fun onPcm(pcm16le: ByteArray?): Unit

    /**
     * Per-packet DSP metadata the glasses firmware appends to each 50 ms audio packet, computed on
     * the raw stereo capture before its mono downmix: the direction-of-arrival in signed degrees (0
     * = straight ahead, positive to the wearer's right) and a signal-strength ratio that serves as
     * a confidence/energy proxy for the angle.
     */
    fun onFrameMeta(angleDegrees: Int, ssr: Int): Unit

    /**
     * The speaker stopped, in a hands-free session that has no button release to end it. Only fires
     * when endpointing was enabled for the session; see FaceclawVoiceController.setEndpointing.
     */
    fun onSpeechEnd(): Unit

    /**
     * Result of speaker verification against the enrolled wearer voice-print, emitted once per
     * capture session just before the final transcript. Only fires when verification was configured
     * for the session; fails open (isWearer=true) when the utterance was too short to verify or the
     * speaker model could not be loaded.
     */
    fun onSpeakerVerified(isWearer: Boolean, similarity: Float): Unit

    /**
     * Progress of a capture that replays a recording (see VoiceCaptureSession.setReplay):
     * "start" once the file is open, "position" about once per second of it played, "seek" after
     * a jump took effect (the transcript of what played before it has been emitted as final),
     * "end" when the file ran out, and "error" when it could not be opened (the status says
     * why). Positions are milliseconds into the file.
     */
    fun onReplay(event: String?, positionMs: Long, durationMs: Long): Unit
}
