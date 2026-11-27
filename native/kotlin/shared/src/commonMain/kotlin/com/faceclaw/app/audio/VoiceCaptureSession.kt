package com.faceclaw.app

import kotlin.concurrent.Volatile
import kotlin.jvm.JvmStatic
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/** Platform services the voice-capture session needs; supplied by the Android/iOS adapter. */
interface VoiceCaptureHost {
    val dispatcher: CallbackDispatcher

    /** Runs first on the worker thread of every session (Android deletes legacy model files here). */
    fun onSessionStarting()

    /** True when a glasses session can carry microphone packets (false when no communicator is set). */
    fun isG2SessionReady(): Boolean

    /** Whether the glasses are still delivering packets; see [VoiceCaptureSession.isCapturing]. */
    fun isG2AudioCaptureActive(): Boolean

    /** The glasses packet source, or null when no communicator is available. */
    fun g2AudioSource(): PacketAudioSource?

    fun createPacketDecoder(): AudioPacketDecoder

    /** Opens the phone microphone at 16 kHz mono PCM16, or null when it cannot start. */
    fun openPhoneMic(): PcmAudioSource?

    /** Whether the on-device model files for [kind] are present (downloaded). */
    fun hasTranscriberModel(kind: VoiceModelKind): Boolean

    /** Loads the recognizer for [kind]; throws when the model cannot be loaded. */
    fun loadTranscriber(kind: VoiceModelKind): OfflineTranscriber

    /** The speaker-embedding model at [modelPath] (may be shared/cached across sessions). */
    fun speakerEmbedder(modelPath: String): SpeakerEmbedder

    /** The glasses' per-temple microphone channel, or null when there are no glasses that have one. */
    fun micArrayLink(): MicArrayLink? = null

    /** Opens a recording to replay; throws when it cannot be read. */
    fun openRecording(path: String): SeekableInput = openFileInput(path)
}

/**
 * Voice-input capture pipeline shared by both platforms: LC3 packet queue with drop/late
 * accounting, firmware-DoA beam gate, per-chunk processing (suppression, speaker
 * verification buffer, endpointing, PCM emit), the segmented on-device transcript machine with
 * REPLACE-semantics partials, and speaker verification at session end. The session owns its
 * worker thread (started through the shared [startThread]); listener callbacks go through the
 * host's [CallbackDispatcher] so the adapter decides the delivery thread.
 *
 * Audio comes from one of four sources, chosen at start(): the glasses' stock mixed stream, the
 * phone's microphone, the glasses' per-temple microphones ([setMicArray]), or a recording
 * played back in real time ([setReplay]). Each delivers [MicChunk]s; a live capture's chunks go
 * to the recorder ([setRecorder]) as they came, before any processing, which is what lets a
 * replay of the recording run the same processing again.
 */
class VoiceCaptureSession(
    private val host: VoiceCaptureHost,
    private val platform: ProtocolPlatform = protocolPlatform(),
    private val threadName: String = "FaceclawVoiceController",
    private val logInfo: (String) -> Unit = { PlatformLog.i(TAG, it) },
    private val logWarn: (String) -> Unit = { PlatformLog.w(TAG, it) },
    private val logError: (String, Throwable) -> Unit = { message, error -> PlatformLog.e(TAG, message, error) },
) {
    companion object {
        const val TAG = "FaceclawVoice"
        const val SAMPLE_RATE = 16000
        const val MAX_AUDIO_QUEUE_PACKETS = 80
        const val EXPECTED_PACKET_INTERVAL_MS = 50
        const val LATE_PACKET_INTERVAL_MS = 90
        const val STATS_INTERVAL_MS = 5_000
        // Push-to-talk utterance boundaries come from the button. We re-decode the
        // current audio segment in full for each live partial and emit the complete
        // utterance text (REPLACE, never a delta). The sherpa Moonshine v2 decoder
        // used here fails once a single input grows past roughly 9.1 seconds, so
        // longer utterances are committed in model-safe segments.
        const val TRANSCRIPT_DECODE_INTERVAL_MS = 700
        const val TRANSCRIPT_MIN_SAMPLES = SAMPLE_RATE / 3
        const val TRANSCRIPT_SEGMENT_MAX_SAMPLES = SAMPLE_RATE * 8
        // When a segment fills, cut at the quietest window within the last
        // TRANSCRIPT_CUT_SEARCH_SAMPLES rather than mid-word at the 8s mark; the
        // audio after the cut carries over into the next segment.
        const val TRANSCRIPT_CUT_SEARCH_SAMPLES = SAMPLE_RATE * 2
        const val TRANSCRIPT_CUT_WINDOW_SAMPLES = SAMPLE_RATE * 30 / 1000
        // Glasses-mic PCM peaks around 0.1 full scale, and at that level the
        // quantized Moonshine model often returns empty or garbled text. Boost
        // each decode window toward this peak, with a gain cap so near-silent
        // buffers aren't amplified into pure noise.
        const val TRANSCRIPT_NORMALIZE_TARGET_PEAK = 0.9f
        const val TRANSCRIPT_NORMALIZE_MAX_GAIN = 30f
        const val TRANSCRIPT_LOG_PREVIEW_CHARS = 80
        // Below this peak amplitude (pre-normalization, of a full-scale +/-1.0f
        // buffer) a segment is treated as silence and never reaches the Whisper
        // recognizer at all, rather than risking a hallucinated non-answer. Picked
        // conservatively low (well under typical mic noise floor already seen in
        // this pipeline's normalization target) -- UNTESTED on real hardware, tune
        // against real glasses captures rather than trusting this number.
        const val WHISPER_SILENCE_PEAK_THRESHOLD = 0.01f
        // Speaker verification against the enrolled wearer voice-print ("my voice
        // only" command gating). Configured before start(); the utterance PCM is
        // buffered (capped) and verified once at session end.
        const val VERIFY_MAX_SAMPLES = SAMPLE_RATE * 10
        const val VERIFY_MIN_SAMPLES = SAMPLE_RATE
        const val DEFAULT_VERIFY_THRESHOLD = 0.8f
        /** Samples per G2 packet; the decode buffer the worker reuses. */
        const val PACKET_SAMPLES = Lc3PacketFramer.SAMPLES_PER_PACKET
        // Mic array upkeep: the temples stop streaming unless their lease is renewed, and a
        // temple that goes quiet (a lost CONFIGURE, or it restarted) is configured again.
        const val ARRAY_CHECK_MS = 1000L
        const val ARRAY_RENEW_MS = MicArrayProtocol.LEASE_MS / 3
        const val ARRAY_TEMPLE_SILENT_MS = 5000L
        const val ARRAY_WAITING_MS = 2000L
        const val ARRAY_WAITING_STATUS = "Waiting for the glasses microphones..."
        // Temples that have streamed nothing this long after arming aren't going to (the
        // firmware armed but cannot send, or isn't the one that streams them): the capture
        // goes on with the mixed stream. Longer than ARRAY_TEMPLE_SILENT_MS, so each temple
        // has been configured a second time first.
        const val ARRAY_FALLBACK_MS = 8000L
        // The mixed stream sends a packet every EXPECTED_PACKET_INTERVAL_MS while its enable
        // holds, speech or not. This long without one means the glasses dropped it.
        const val G2_SILENT_MS = 5000L
        const val G2_LOST_STATUS = "Waiting for the glasses microphone..."
        /** How long stop() waits for the worker; it winds down on its own thread either way. */
        const val STOP_WAIT_MS = 1500L
        // How long a new capture's worker waits for the previous one to finish with the
        // session's state (its final decode, speaker verification, the mic disable).
        const val PREVIOUS_WORKER_WAIT_MS = 15_000L
        // A replay skips stretches of the recording with no audio longer than this
        // (a recording made across a disconnect) instead of sitting through them.
        const val REPLAY_MAX_GAP_MS = 2000L
        const val REPLAY_POSITION_INTERVAL_MS = 1000L
        const val REPLAY_WAIT_SLICE_MS = 20L
        const val REPLAY_FINISHED_STATUS = "Replay finished."

        /** Joins transcript pieces, attaching leading punctuation to the previous text. */
        @JvmStatic
        fun joinTranscript(prefix: String?, suffix: String?): String {
            if (prefix.isNullOrEmpty()) {
                return suffix ?: ""
            }
            if (suffix.isNullOrEmpty()) {
                return prefix
            }
            val first = suffix[0]
            val attachesToPrevious = ".,!?;:%)]}".indexOf(first) >= 0
            return prefix + (if (attachesToPrevious) "" else " ") + suffix
        }

        @JvmStatic
        fun parseModelKind(kind: String?): VoiceModelKind =
            if ("whisper" == kind) VoiceModelKind.WHISPER else VoiceModelKind.MOONSHINE
    }

    enum class Mode {
        ONBOARD, // on-phone transcription (Moonshine or Whisper; see onboardModelKind)
        CLOUD, // decode locally, emit PCM for a cloud recognizer on the TS side
    }

    private enum class Source { G2, PHONE, ARRAY, REPLAY }

    private class AudioPacket(val data: ByteArray, arm: String?, val arrivalMs: Long) {
        val arm: String = arm ?: "?"
    }

    /** What one start() asked for, latched for its worker: later setters and starts don't change it. */
    private class CapturePlan(
        /** The session generation this capture is; see [active]. */
        val worker: Int,
        val captureId: Int,
        val mode: Mode,
        val source: Source,
        val configure: ByteArray?,
        val replayPath: String?,
        val replayStartMs: Long,
    )

    private val lock = platform.createLock()
    private val audioQueue = DroppingPacketQueue<AudioPacket>(MAX_AUDIO_QUEUE_PACKETS, platform)
    @Volatile
    private var listener: FaceclawVoiceControllerListener? = null
    @Volatile
    private var started = false
    // Set once the worker has the mic enabled for this session. Read and
    // written under `lock`, so it flips with `started` atomically.
    private var audioStarted = false
    // The newest worker's latch, until that worker has finished.
    private var workerFinished: Latch? = null
    // Bumped by every start(): a worker runs while `started` holds and this is still its
    // own, so one that outlived its stop() can't mistake the next capture for its own.
    @Volatile
    private var generation = 0
    @Volatile
    private var workerThreadName: String? = null
    // Capture from the phone's own microphone instead of the G2 over BLE
    // (preview-only mode). Latched into activeSource at start() (under `lock`)
    // so a mid-session setter call can't switch pipelines underneath the worker.
    @Volatile
    private var usePhoneMic = false
    // What the next capture reads (see start()); latched into activeSource and its
    // companions under `lock`, like usePhoneMic.
    @Volatile
    private var micArrayConfigure: ByteArray? = null
    @Volatile
    private var replayPath: String? = null
    @Volatile
    private var replayStartMs = 0L
    // What the running capture reads from, for isCapturing and the recorder. A capture that
    // falls back from the temples' microphones to the mixed stream changes it.
    private var activeSource = Source.G2
    // Replay controls, picked up by the worker between chunks.
    @Volatile
    private var replaySeekMs = -1L
    @Volatile
    private var replayPaused = false
    @Volatile
    private var recorder: MicRecordingWriter? = null
    @Volatile
    private var mixer: MicArrayMixer = SingleTempleMixer()
    private var lastMissingPackets = 0L
    private var arrayRateWarned = false
    private var mode = Mode.CLOUD
    @Volatile
    private var onboardModelKind = VoiceModelKind.MOONSHINE
    private var recognizer: OfflineTranscriber? = null
    private var packetDecoder: AudioPacketDecoder? = null
    private val transcriptSamples = FloatArray(TRANSCRIPT_SEGMENT_MAX_SAMPLES)
    private var transcriptSampleCount = 0
    private var committedTranscriptSampleCount: Long = 0
    private var committedTranscript = ""
    private var currentSegmentTranscript = ""
    private var lastTranscriptDecodeAtMs: Long = 0
    private var lastTranscript = ""
    @Volatile
    private var endpointing = false
    private val endpointDetector = VoiceEndpointDetector()
    @Volatile
    private var verifySpeakerModelPath: String? = null
    @Volatile
    private var verifyWearerEmbedding: FloatArray? = null
    @Volatile
    private var verifyThreshold = DEFAULT_VERIFY_THRESHOLD
    private var verifyBuffer: ShortArray? = null
    private var verifyCount = 0
    // Global mic processing (Microphones app config): spectral noise
    // suppression and firmware-DoA beam gating, applied to every capture
    // session that opts in. The raw tap opts out.
    @Volatile
    private var suppressionEnabled = false
    @Volatile
    private var beamFilterEnabled = false
    @Volatile
    private var beamCenterDeg = 0
    @Volatile
    private var beamHalfWidthDeg = 180
    private var suppressor: FaceclawNoiseSuppressor? = null
    private var queuedPackets: Long = 0
    private var decodedSamples: Long = 0
    private var latePackets: Long = 0
    private var wrongArmPackets: Long = 0
    private var lastPacketArrivalMs: Long = 0
    private var maxInterPacketMs: Long = 0
    private var lastStatsAtMs: Long = 0

    fun setListener(listener: FaceclawVoiceControllerListener?) {
        this.listener = listener
    }

    fun setUsePhoneMic(usePhoneMic: Boolean) {
        this.usePhoneMic = usePhoneMic
    }

    /**
     * Capture the next glasses session from the temples' own microphones instead of the stock
     * mixed stream: [configureRecord] is the mic_control CONFIGURE record sent to both temples
     * (it decides how many microphones each one streams). Null goes back to the mixed stream.
     */
    fun setMicArray(configureRecord: ByteArray?) {
        this.micArrayConfigure = if (MicArrayProtocol.isConfigure(configureRecord)) configureRecord else null
    }

    /** How the temples' chunks become the mono feed that is transcribed. */
    fun setMicArrayMixer(mixer: MicArrayMixer) {
        this.mixer = mixer
    }

    /**
     * Have the next capture play the recording at [path] from [startMs] in real time, in place
     * of any microphone; null goes back to the microphones. A replay needs no glasses.
     */
    fun setReplay(path: String?, startMs: Long) {
        this.replayPath = path
        this.replayStartMs = maxOf(0L, startMs)
    }

    /** Continue the running replay from [positionMs] into its recording. */
    fun seekReplay(positionMs: Long) {
        this.replaySeekMs = maxOf(0L, positionMs)
    }

    /** Hold the running replay where it is, or let it go on. A new capture starts unpaused. */
    fun setReplayPaused(paused: Boolean) {
        this.replayPaused = paused
    }

    /**
     * Where live captures' chunks are recorded as they arrive, or null. Takes effect at once,
     * also mid-capture; the caller finishes the recording. A replay is never recorded.
     */
    fun setRecorder(recorder: MicRecordingWriter?) {
        this.recorder = recorder
    }

    fun setOnboardModelKind(kind: String?) {
        this.onboardModelKind = parseModelKind(kind)
    }

    fun setEndpointing(endpointing: Boolean) {
        this.endpointing = endpointing
    }

    fun setSpeakerVerification(speakerModelPath: String?, wearerEmbedding: FloatArray?, threshold: Float) {
        this.verifySpeakerModelPath = speakerModelPath
        this.verifyWearerEmbedding = wearerEmbedding
        this.verifyThreshold = if (threshold > 0) threshold else DEFAULT_VERIFY_THRESHOLD
    }

    fun clearSpeakerVerification() {
        this.verifySpeakerModelPath = null
        this.verifyWearerEmbedding = null
    }

    fun setNoiseSuppression(enabled: Boolean) {
        this.suppressionEnabled = enabled
    }

    fun setBeamFilter(enabled: Boolean, centerDeg: Int, halfWidthDeg: Int) {
        this.beamFilterEnabled = enabled
        this.beamCenterDeg = centerDeg
        this.beamHalfWidthDeg = max(5, min(180, halfWidthDeg))
    }

    /** Direction gating: true when [angleDegrees] lies within centerDeg ± halfWidthDeg (wrap-safe). */
    fun withinBeam(angleDegrees: Int): Boolean {
        var delta = angleDegrees - beamCenterDeg
        while (delta > 180) delta -= 360
        while (delta < -180) delta += 360
        return abs(delta) <= beamHalfWidthDeg
    }

    private fun applySuppression(pcm: ShortArray, count: Int) {
        try {
            if (suppressor == null) {
                suppressor = FaceclawNoiseSuppressor(SAMPLE_RATE)
            }
            val le = AudioSegmentation.pcm16ToLittleEndian(pcm, 0, count)
            val cleaned = suppressor!!.process(le)!!
            val cleanedCount = min(count, cleaned.size / 2)
            for (i in 0 until cleanedCount) {
                pcm[i] = AudioSegmentation.pcm16le(cleaned[i * 2], cleaned[i * 2 + 1])
            }
        } catch (t: Throwable) {
            logWarn("noise suppression failed; passing audio through (${t.message})")
            suppressionEnabled = false
        }
    }

    fun start(requestedMode: String?) {
        start(requestedMode, 0)
    }

    fun start(requestedMode: String?, captureId: Int) {
        lock.withLock {
            if (started) {
                emitStatus("Voice control is already listening.")
                emitStopped(captureId)
                return
            }
            val path = replayPath
            val configure = micArrayConfigure
            val source = when {
                path != null -> Source.REPLAY
                usePhoneMic -> Source.PHONE
                configure != null -> Source.ARRAY
                else -> Source.G2
            }
            if ((source == Source.G2 || source == Source.ARRAY) && !host.isG2SessionReady()) {
                emitStatus("Voice control needs an active G2 connection.")
                emitStopped(captureId)
                return
            }
            mode = parseMode(requestedMode)
            activeSource = source
            replaySeekMs = -1L
            replayPaused = false
            started = true
            audioStarted = false
            // A worker still winding down from the last capture, if any.
            val previous = workerFinished
            val finished = Latch(1, platform)
            workerFinished = finished
            val plan = CapturePlan(++generation, captureId, mode, source, configure, path, replayStartMs)
            startThread(threadName, true) { runLoop(plan, finished, previous) }
        }
    }

    /** Whether the capture [worker] was started for is still wanted. */
    private fun active(worker: Int): Boolean = started && generation == worker

    /**
     * Whether mic audio is actually flowing. start() only records intent: the
     * enable lives in the glasses' EvenHub session, so a transport drop or a
     * session suspend can leave this session started with a worker that will
     * never see another packet.
     */
    fun isCapturing(): Boolean {
        var audioUp = false
        var source = Source.G2
        lock.withLock {
            if (!started) {
                return false
            }
            audioUp = audioStarted
            source = activeSource
        }
        if (!audioUp) {
            // The worker is still bringing the mic up; report it as running so
            // a concurrent request shares it instead of restarting it.
            return true
        }
        if (source == Source.PHONE || source == Source.REPLAY) {
            // Neither has a glasses session to lose the enable to: the phone mic runs
            // until stop(), a replay until its recording ends.
            return true
        }
        return host.isG2AudioCaptureActive()
    }

    /**
     * Stops the session and waits up to STOP_WAIT_MS for the worker to finish unless
     * called from the worker itself. The worker checks the stop flag between
     * packets (every packet or 250 ms wait) and between phone-mic reads (50 ms),
     * then releases what it holds on the glasses from its own thread: the mic
     * disable waits on a Bluetooth acknowledgement, which the caller (the UI
     * thread) must not sit through.
     */
    fun stop() {
        var finished: Latch? = null
        var workerName: String? = null
        lock.withLock {
            if (!started) {
                return
            }
            started = false
            finished = workerFinished
            workerName = workerThreadName
        }
        audioQueue.wake()
        if (finished != null && (workerName == null || currentThreadName() != workerName)) {
            finished.await(STOP_WAIT_MS)
        }
    }

    fun close() {
        stop()
    }

    private fun parseMode(requestedMode: String?): Mode {
        if ("cloud" == requestedMode) {
            return Mode.CLOUD
        }
        return Mode.ONBOARD
    }

    private fun runLoop(plan: CapturePlan, finished: Latch, previous: Latch?) {
        val worker = plan.worker
        workerThreadName = currentThreadName()
        // What this worker has running on the glasses. Ended as soon as the capture loop
        // returns (before the final decode), and again on the way out in case it threw.
        var release: (() -> Unit)? = null
        fun releaseSource() {
            val current = release ?: return
            release = null
            current()
            maybeEmitAudioStats(true)
        }
        // What this worker put in the session's recognizer and decoder slots.
        var ownRecognizer: OfflineTranscriber? = null
        var ownDecoder: AudioPacketDecoder? = null
        fun markAudioStarted() = lock.withLock { if (generation == worker) audioStarted = true }
        fun captureG2(listening: String): Boolean {
            val source = host.g2AudioSource()
            val decoder = host.createPacketDecoder()
            ownDecoder = decoder
            packetDecoder = decoder
            if (source == null || !startG2Audio(source)) {
                emitStatus("Could not start G2 microphone input.")
                return false
            }
            release = { source.stop() }
            markAudioStarted()
            if (active(worker)) emitStatus(listening)
            processG2Audio(source, worker)
            return true
        }
        try {
            // The last capture's worker may still be on its final decode, speaker
            // verification or mic disable. It uses this session's buffers, so it goes first.
            if (previous != null && !previous.await(PREVIOUS_WORKER_WAIT_MS)) {
                logWarn("the previous capture's worker is still running after $PREVIOUS_WORKER_WAIT_MS ms; starting beside it")
            }
            if (!active(worker)) {
                return
            }
            host.onSessionStarting()
            val currentMode = plan.mode
            val currentOnboardKind = onboardModelKind
            if (currentMode == Mode.ONBOARD) {
                if (!host.hasTranscriberModel(currentOnboardKind)) {
                    emitStatus("Voice model not downloaded (see Settings > Voice).")
                    return
                }
                emitStatus("Loading transcription model...")
                val transcriber = host.loadTranscriber(currentOnboardKind)
                ownRecognizer = transcriber
                recognizer = transcriber
                resetTranscriptState()
                lastTranscript = ""
            }
            endpointDetector.reset()
            suppressor?.reset()
            val verifying = verifySpeakerModelPath != null && verifyWearerEmbedding != null
            verifyBuffer = if (verifying) ShortArray(VERIFY_MAX_SAMPLES) else null
            verifyCount = 0
            mixer.reset()
            lastMissingPackets = 0
            val listening = if (currentMode == Mode.CLOUD) "Listening (cloud)..." else "Listening..."
            // A stop while the model loaded: the mic isn't brought up just to be taken down.
            if (active(worker)) {
                when (plan.source) {
                    Source.PHONE -> {
                        val record = host.openPhoneMic()
                        if (record == null) {
                            emitStatus("Could not start the phone microphone.")
                            return
                        }
                        markAudioStarted()
                        emitStatus(listening)
                        try {
                            // What it heard before failing is still transcribed below.
                            if (!processPhoneAudio(record, worker)) emitStatus("The phone microphone stopped.")
                        } finally {
                            record.close()
                        }
                    }
                    Source.REPLAY -> {
                        val reader = try {
                            MicRecordingReader(host.openRecording(plan.replayPath!!))
                        } catch (error: Throwable) {
                            emitStatus("Could not open the recording: " + error.message)
                            emitReplay("error", 0, 0)
                            return
                        }
                        try {
                            markAudioStarted()
                            logInfo("replaying " + reader.description + ", " + formatFixed(reader.durationMs / 1000.0, 1) + " s")
                            emitStatus(listening)
                            processReplay(reader, plan)
                        } finally {
                            reader.close()
                        }
                    }
                    Source.ARRAY -> {
                        val link = host.micArrayLink()
                        val configure = plan.configure
                        if (link == null || configure == null || !startArray(link, configure)) {
                            emitStatus("Could not start the glasses microphone array.")
                            return
                        }
                        release = { stopArray(link) }
                        markAudioStarted()
                        if (active(worker)) emitStatus(listening)
                        if (!processArray(link, configure, listening, worker) && active(worker)) {
                            logWarn("mic array streamed nothing in $ARRAY_FALLBACK_MS ms; capturing the mixed stream instead")
                            releaseSource()
                            lock.withLock {
                                if (generation == worker) {
                                    activeSource = Source.G2
                                    audioStarted = false
                                }
                            }
                            if (!captureG2(listening)) {
                                return
                            }
                        }
                    }
                    Source.G2 -> if (!captureG2(listening)) {
                        return
                    }
                }
            }
            // The mic goes off now, not after the decodes below.
            releaseSource()
            // Verification result must precede the final transcript so the
            // TS bridge can suppress a non-wearer command before it is acted
            // on (the callbacks are posted in order to the dispatcher).
            runSpeakerVerification()
            // Button released / stop requested: emit one final full-utterance
            // transcript so the UI can freeze it.
            if (currentMode == Mode.ONBOARD) {
                decodeTranscript(true)
            }
        } catch (error: Throwable) {
            logError("Voice control failed", error)
            emitStatus("Voice control failed: " + error.message)
        } finally {
            try {
                releaseSource()
            } catch (error: Throwable) {
                logError("Voice source release failed", error)
            }
            // Only what this worker made: a newer capture that gave up waiting for this one
            // has its own in the session's slots.
            ownRecognizer?.release()
            if (recognizer === ownRecognizer) recognizer = null
            ownDecoder?.close()
            if (packetDecoder === ownDecoder) packetDecoder = null
            lock.withLock {
                // A capture started since then owns the session's state now.
                if (workerFinished === finished) {
                    started = false
                    audioStarted = false
                    workerFinished = null
                    workerThreadName = null
                }
            }
            emitStopped(plan.captureId)
            finished.countDown()
        }
    }

    private fun packetListener() = object : FaceclawAudioPacketListener {
        override fun onAudioPacket(data: ByteArray?, arm: String?, arrivalMs: Long) {
            queueAudioPacket(data, arm, arrivalMs)
        }
    }

    private fun startG2Audio(source: PacketAudioSource): Boolean {
        resetAudioStats()
        audioQueue.clear()
        return source.start(packetListener())
    }

    private fun processG2Audio(source: PacketAudioSource, worker: Int) {
        var pcm = ShortArray(PACKET_SAMPLES)
        var packetAt = platform.elapsedRealtimeMs()
        while (active(worker)) {
            val currentDecoder = packetDecoder ?: return
            if (pcm.size < currentDecoder.maxSamplesPerPacket) pcm = ShortArray(currentDecoder.maxSamplesPerPacket)
            val packet = takeAudioPacket(worker)
            if (packet == null) {
                // The enable lives in the glasses' EvenHub page, so a page that ended by
                // itself (or glasses that stopped streaming) leaves this loop waiting for
                // packets that will not come. End the capture: whoever holds it starts again.
                val lost = if (!source.isActive()) "the glasses session no longer has the mic enabled"
                    else if (source.streamsContinuously && platform.elapsedRealtimeMs() - packetAt >= G2_SILENT_MS) "no audio for $G2_SILENT_MS ms"
                    else null
                if (lost != null && active(worker)) {
                    logWarn("G2 microphone lost: $lost")
                    emitStatus(G2_LOST_STATUS)
                    return
                }
                continue
            }
            packetAt = platform.elapsedRealtimeMs()
            val count = currentDecoder.decodePacket(packet.data, pcm)
            if (count <= 0) {
                maybeEmitAudioStats(false)
                continue
            }
            decodedSamples += count.toLong()
            val chunk = MicChunk(MicStream.MONO, 1, SAMPLE_RATE, pcm, count, packet.arrivalMs)
            chunk.hasDirection = currentDecoder.hasFrameMeta
            chunk.angleDegrees = currentDecoder.lastAngleDegrees
            chunk.ssr = currentDecoder.lastSsr
            // Packets the decoder found missing ahead of this one: a gap in a recording.
            val missing = currentDecoder.missingPackets
            chunk.lostFramesBefore = ((missing - lastMissingPackets) * currentDecoder.maxSamplesPerPacket).toInt()
            lastMissingPackets = missing
            handleMonoChunk(chunk)
            maybeEmitAudioStats(false)
        }
    }

    /**
     * A mixed-microphone chunk from any source: recorded as it came, then on to processing
     * unless the beam filter drops it. The filter drops chunks whose firmware
     * direction-of-arrival falls outside the listening wedge (isolating the aimed talker for
     * every consumer, recognition included); the spectral noise suppressor then cleans what
     * remains before it reaches the recognizer, cloud PCM, endpointing, or speaker verification.
     */
    private fun handleMonoChunk(chunk: MicChunk) {
        recordChunk(chunk)
        if (beamFilterEnabled && chunk.ssr > 0 && !withinBeam(chunk.angleDegrees)) {
            emitFrameMeta(chunk.angleDegrees, chunk.ssr)
            return
        }
        processPcmChunk(chunk.pcm, chunk.frames, chunk.angleDegrees, chunk.ssr, chunk.hasDirection)
    }

    /**
     * A chunk of one temple's own microphones: recorded as it came, then mixed into the mono
     * feed, which is recorded too (as what was transcribed) and processed like a mixed chunk.
     * The beam filter does not apply: a temple's bearing is along its own pair, not the
     * head-frame direction the filter is aimed in.
     */
    private fun handleArrayChunk(chunk: MicChunk) {
        recordChunk(chunk)
        val feed = mixer.mix(chunk) ?: return
        recordChunk(feed)
        if (feed.sampleRate != SAMPLE_RATE || feed.channels != 1) {
            if (!arrayRateWarned) logWarn("mic array feed is ${feed.channels}ch ${feed.sampleRate} Hz; recognition needs mono $SAMPLE_RATE Hz")
            arrayRateWarned = true
            return
        }
        processPcmChunk(feed.pcm, feed.frames, feed.angleDegrees, feed.ssr, feed.hasDirection)
    }

    private fun recordChunk(chunk: MicChunk) {
        if (activeSource != Source.REPLAY) recorder?.write(chunk)
    }

    private fun handleChunk(chunk: MicChunk) {
        if (chunk.stream == MicStream.MONO) handleMonoChunk(chunk) else handleArrayChunk(chunk)
    }

    private fun startArray(link: MicArrayLink, configure: ByteArray): Boolean {
        resetAudioStats()
        audioQueue.clear()
        if (!link.startForwarding(packetListener())) return false
        return link.sendControl(configure, "configure", true, true)
    }

    private fun stopArray(link: MicArrayLink) {
        link.sendControl(MicArrayProtocol.control(MicArrayProtocol.OP_STOP), "stop", true, true)
        link.stopForwarding()
    }

    /**
     * Mic array capture loop: each temple's 'SM' frames become chunks of that temple's stream.
     * Between frames it keeps the streams alive: renews the temples' lease, configures a temple
     * again when it has gone quiet, and takes forwarding back when the glasses session dropped it.
     * Returns false when neither temple streamed anything in ARRAY_FALLBACK_MS, for the caller
     * to capture the mixed stream instead.
     */
    private fun processArray(link: MicArrayLink, configure: ByteArray, listening: String, worker: Int): Boolean {
        val startedAt = platform.elapsedRealtimeMs()
        var checkedAt = startedAt
        var renewedAt = startedAt
        // Left, right.
        val armedAt = longArrayOf(startedAt, startedAt)
        val frameAt = longArrayOf(startedAt, startedAt)
        var streamed = false
        var waiting = false
        while (active(worker)) {
            val packet = takeAudioPacket(worker)
            val now = platform.elapsedRealtimeMs()
            if (packet != null) {
                val side = if (packet.arm == "L") 0 else if (packet.arm == "R") 1 else -1
                val frame = if (side >= 0) MicArrayProtocol.decodeFrame(packet.data) else null
                val pcm = if (frame != null) MicArrayProtocol.pcm16(packet.data, frame) else null
                // Anything else is a stock-format packet from before arming took effect.
                if (frame != null && pcm != null) {
                    streamed = true
                    frameAt[side] = now
                    val frames = pcm.size / frame.channels
                    decodedSamples += frames.toLong()
                    val stream = if (side == 0) MicStream.LEFT else MicStream.RIGHT
                    val chunk = MicChunk(stream, frame.channels, frame.sampleRate, pcm, frames, packet.arrivalMs)
                    chunk.hasDirection = frame.angleDegrees != 0 || frame.ssr != 0
                    chunk.angleDegrees = frame.angleDegrees
                    chunk.ssr = frame.ssr
                    chunk.sequence = frame.sequence
                    chunk.deviceTickMs = frame.deviceTickMs
                    chunk.truncated = frame.truncated
                    handleArrayChunk(chunk)
                }
            }
            if (!streamed && now - startedAt >= ARRAY_FALLBACK_MS) {
                return false
            }
            if (now - checkedAt >= ARRAY_CHECK_MS) {
                checkedAt = now
                if (!link.isForwarding()) {
                    if (host.isG2SessionReady() && link.startForwarding(packetListener()) && link.sendControl(configure, "configure", true, true)) {
                        logInfo("mic array forwarding re-established")
                        armedAt.fill(now)
                        renewedAt = now
                    }
                } else {
                    if (now - renewedAt >= ARRAY_RENEW_MS) {
                        link.sendControl(MicArrayProtocol.control(MicArrayProtocol.OP_RENEW), "renew", true, true)
                        renewedAt = now
                    }
                    for (side in 0..1) {
                        if (now - maxOf(frameAt[side], armedAt[side]) < ARRAY_TEMPLE_SILENT_MS) continue
                        logWarn("mic array: " + (if (side == 0) "left" else "right") + " temple silent; configuring it again")
                        link.sendControl(configure, "configure-" + (if (side == 0) "left" else "right"), side == 1, side == 0)
                        armedAt[side] = now
                    }
                }
                val silent = now - maxOf(frameAt[0], frameAt[1]) >= ARRAY_WAITING_MS
                if (silent != waiting) {
                    waiting = silent
                    emitStatus(if (silent) ARRAY_WAITING_STATUS else listening)
                }
            }
            maybeEmitAudioStats(false)
        }
        return true
    }

    /**
     * Replay loop: hands the recording's chunks to the pipeline at the pace they were captured,
     * so recognition (its partials, a cloud provider's stream) sees what a live capture would.
     * Jumps and pauses asked for from outside take effect between chunks.
     */
    private fun processReplay(reader: MicRecordingReader, plan: CapturePlan) {
        val worker = plan.worker
        val duration = reader.durationMs
        var position = minOf(plan.replayStartMs, duration)
        reader.seekTo(position)
        emitReplay("start", position, duration)
        var reportedAt = position
        // Wall-clock time at which file time `anchorFile` plays; unset after a jump, pause or gap.
        var anchorWall = -1L
        var anchorFile = 0L
        var pending: MicChunk? = null
        while (active(worker)) {
            val seek = replaySeekMs
            if (seek >= 0) {
                replaySeekMs = -1L
                // What played so far is a finished utterance; the rest starts clean.
                finishReplayedUtterance()
                position = minOf(seek, duration)
                reader.seekTo(position)
                pending = null
                anchorWall = -1L
                reportedAt = position
                emitReplay("seek", position, duration)
            }
            if (replayPaused) {
                anchorWall = -1L
                sleepMs(REPLAY_WAIT_SLICE_MS)
                continue
            }
            val chunk = pending ?: reader.next()
            if (chunk == null) {
                emitReplay("end", duration, duration)
                emitStatus(REPLAY_FINISHED_STATUS)
                return
            }
            pending = chunk
            val now = platform.elapsedRealtimeMs()
            if (anchorWall < 0 || chunk.timeMs - position > REPLAY_MAX_GAP_MS) {
                anchorWall = now
                anchorFile = chunk.timeMs
            }
            val wait = anchorWall + (chunk.timeMs - anchorFile) - now
            if (wait > 0) {
                // Short slices, so a stop, jump or pause is noticed promptly.
                sleepMs(minOf(wait, REPLAY_WAIT_SLICE_MS))
                continue
            }
            pending = null
            position = chunk.timeMs
            decodedSamples += chunk.frames.toLong()
            handleChunk(chunk)
            if (position - reportedAt >= REPLAY_POSITION_INTERVAL_MS) {
                reportedAt = position
                emitReplay("position", position, duration)
            }
        }
    }

    /** Ends the utterance a replay was in the middle of when it jumped, so the audio on both sides isn't joined. */
    private fun finishReplayedUtterance() {
        mixer.reset()
        endpointDetector.reset()
        suppressor?.reset()
        if (mode != Mode.ONBOARD) return
        decodeTranscript(true)
        resetTranscriptState()
        lastTranscript = ""
    }

    /**
     * Per-chunk processing shared by the G2 and phone-mic paths, downstream of
     * decode and the beam filter. hasFrameMeta is false for the phone mic,
     * which has no firmware DSP metadata to report.
     */
    internal fun processPcmChunk(pcm: ShortArray, count: Int, angleDegrees: Int, ssr: Int, hasFrameMeta: Boolean) {
        if (suppressionEnabled) {
            applySuppression(pcm, count)
        }
        val verifyBuffer = this.verifyBuffer
        if (verifyBuffer != null && verifyCount < VERIFY_MAX_SAMPLES) {
            val copied = min(count, VERIFY_MAX_SAMPLES - verifyCount)
            pcm.copyInto(verifyBuffer, verifyCount, 0, copied)
            verifyCount += copied
        }
        if (endpointing && endpointDetector.accept(pcm, count)) {
            emitSpeechEnd()
        }
        // PCM and frame metadata flow in every mode so levels, recording,
        // and the Microphones radar keep working alongside onboard ASR.
        emitPcm(pcm, count)
        if (hasFrameMeta) {
            emitFrameMeta(angleDegrees, ssr)
        }
        if (mode != Mode.CLOUD) {
            processRecognizer(AudioSegmentation.pcm16ToFloat(pcm, 0, count))
        }
    }

    /**
     * Phone-mic capture loop: no LC3 decode, no arm bookkeeping, no frame
     * metadata. The blocking read returns every chunk (50 ms), which bounds how
     * long a stop() waits for the loop to notice `started` dropped. Returns false
     * when the microphone failed under it.
     */
    private fun processPhoneAudio(record: PcmAudioSource, worker: Int): Boolean {
        val pcm = ShortArray(SAMPLE_RATE / 20)
        while (active(worker)) {
            val read = record.read(pcm)
            if (read < 0) {
                logWarn("phone mic read failed: $read")
                return false
            }
            if (read == 0) {
                continue
            }
            decodedSamples += read.toLong()
            handleMonoChunk(MicChunk(MicStream.MONO, 1, SAMPLE_RATE, pcm, read, platform.elapsedRealtimeMs()))
        }
        return true
    }

    private fun processRecognizer(samples: FloatArray) {
        appendTranscriptSamples(samples)
        // Each Whisper call re-encodes the whole buffer plus ~10s of tail padding,
        // so it skips the live-partial redecode Moonshine does on this interval and
        // only decodes when a segment commits (8s buffer fill) or the utterance ends
        // (decodeTranscript(true) in runLoop()). No live preview text in Whisper
        // mode -- status stays "Listening..." until release. Deliberate tradeoff.
        if (onboardModelKind == VoiceModelKind.WHISPER) {
            return
        }
        val now = platform.elapsedRealtimeMs()
        if (transcriptSampleCount >= TRANSCRIPT_MIN_SAMPLES &&
            now - lastTranscriptDecodeAtMs >= TRANSCRIPT_DECODE_INTERVAL_MS
        ) {
            decodeTranscript(false)
            lastTranscriptDecodeAtMs = now
        }
    }

    private fun appendTranscriptSamples(samples: FloatArray) {
        var sourceOffset = 0
        while (sourceOffset < samples.size) {
            val available = TRANSCRIPT_SEGMENT_MAX_SAMPLES - transcriptSampleCount
            val count = min(available, samples.size - sourceOffset)
            samples.copyInto(transcriptSamples, transcriptSampleCount, sourceOffset, sourceOffset + count)
            transcriptSampleCount += count
            sourceOffset += count
            if (transcriptSampleCount == TRANSCRIPT_SEGMENT_MAX_SAMPLES) {
                commitTranscriptSegment()
            }
        }
    }

    /**
     * Decode the current model-safe segment and emit the best transcript of the
     * complete utterance (REPLACE semantics — the caller displays it as-is).
     */
    private fun decodeTranscript(isFinal: Boolean) {
        if (recognizer == null || transcriptSampleCount <= 0) {
            if (isFinal) {
                emitTranscript(lastTranscript, true)
            }
            return
        }
        val segmentSampleCount = transcriptSampleCount
        var segmentText = recognizeTranscriptSegment(segmentSampleCount)
        if (segmentText.isNotEmpty()) {
            currentSegmentTranscript = segmentText
        } else {
            segmentText = currentSegmentTranscript
        }
        val text = joinTranscript(committedTranscript, segmentText)
        lastTranscript = text
        logTranscriptDecode(isFinal, segmentSampleCount, text)
        emitTranscript(text, isFinal)
    }

    /**
     * Finalize a full segment before accepting more audio. This keeps every
     * Moonshine invocation below its failing sequence length while retaining
     * all earlier text in the replace-semantics preview.
     */
    private fun commitTranscriptSegment() {
        val cut = AudioSegmentation.quietestCutPoint(
            transcriptSamples, transcriptSampleCount, TRANSCRIPT_CUT_SEARCH_SAMPLES, TRANSCRIPT_CUT_WINDOW_SAMPLES,
        )
        var segmentText = recognizeTranscriptSegment(cut)
        if (segmentText.isEmpty()) {
            // Fallback text came from partial decodes of the full buffer, so it
            // may include words from the carried-over tail; rare now that decode
            // windows are peak-normalized.
            segmentText = currentSegmentTranscript
        }
        committedTranscript = joinTranscript(committedTranscript, segmentText)
        currentSegmentTranscript = ""
        committedTranscriptSampleCount += cut.toLong()
        val tail = transcriptSampleCount - cut
        transcriptSamples.copyInto(transcriptSamples, 0, cut, cut + tail)
        transcriptSampleCount = tail
        lastTranscript = committedTranscript
        lastTranscriptDecodeAtMs = platform.elapsedRealtimeMs()
        logTranscriptDecode(false, cut, committedTranscript)
        emitTranscript(committedTranscript, false)
    }

    private fun recognizeTranscriptSegment(sampleCount: Int): String {
        val currentRecognizer = recognizer
        if (currentRecognizer == null || sampleCount <= 0) {
            return ""
        }
        val segment = transcriptSamples.copyOf(sampleCount)
        // Whisper hallucinates text on near-silent input; gate it on the
        // PRE-normalization peak, since normalizePeak() below would otherwise
        // amplify true silence right up to the target level. Moonshine does not
        // share this failure mode in practice, so it is left unchanged.
        if (onboardModelKind == VoiceModelKind.WHISPER &&
            AudioSegmentation.peakAmplitude(segment) < WHISPER_SILENCE_PEAK_THRESHOLD
        ) {
            return ""
        }
        AudioSegmentation.normalizePeak(segment, TRANSCRIPT_NORMALIZE_TARGET_PEAK, TRANSCRIPT_NORMALIZE_MAX_GAIN)
        return currentRecognizer.recognize(segment, segment.size).trim()
    }

    private fun logTranscriptDecode(isFinal: Boolean, segmentSampleCount: Int, text: String) {
        val totalAudioSec = (committedTranscriptSampleCount + transcriptSampleCount) / SAMPLE_RATE.toDouble()
        val preview = if (text.length <= TRANSCRIPT_LOG_PREVIEW_CHARS) text
        else text.substring(0, TRANSCRIPT_LOG_PREVIEW_CHARS) + "..."
        logInfo(
            (if (onboardModelKind == VoiceModelKind.WHISPER) "Whisper" else "Moonshine") + " decode final=" + isFinal +
                " audioSec=" + formatFixed(totalAudioSec, 2) +
                " segmentAudioSec=" + formatFixed(segmentSampleCount / SAMPLE_RATE.toDouble(), 2) +
                " textLen=" + text.length + " text=\"" + preview + "\"",
        )
    }

    private fun resetTranscriptState() {
        transcriptSampleCount = 0
        committedTranscriptSampleCount = 0
        committedTranscript = ""
        currentSegmentTranscript = ""
        lastTranscriptDecodeAtMs = 0
    }

    private fun emitPcm(pcm: ShortArray, count: Int) {
        val currentListener = listener
        if (currentListener == null || count <= 0) {
            return
        }
        val le = AudioSegmentation.pcm16ToLittleEndian(pcm, 0, count)
        host.dispatcher.post { currentListener.onPcm(le) }
    }

    /**
     * Embed the session's buffered utterance and compare it to the enrolled
     * wearer voice-print. Fails open: a session too short to verify, or a
     * model that will not load, counts as the wearer rather than silencing
     * every command.
     */
    private fun runSpeakerVerification() {
        val buffer = verifyBuffer
        val wearer = verifyWearerEmbedding
        val modelPath = verifySpeakerModelPath
        verifyBuffer = null
        if (buffer == null || wearer == null || modelPath == null) {
            return
        }
        if (verifyCount < VERIFY_MIN_SAMPLES) {
            emitSpeakerVerified(true, 0f)
            return
        }
        try {
            val embedder = host.speakerEmbedder(modelPath)
            val le = AudioSegmentation.pcm16ToLittleEndian(buffer, 0, verifyCount)
            val embedding = embedder.embed(le, SAMPLE_RATE)
            if (embedding == null || embedding.size != wearer.size) {
                emitSpeakerVerified(true, 0f)
                return
            }
            val dot = VoicePrint.dot(embedding, wearer)
            val isWearer = dot >= verifyThreshold
            logInfo(
                "speaker verification similarity=" + formatFixed(dot, 3) +
                    " threshold=" + verifyThreshold + " isWearer=" + isWearer,
            )
            emitSpeakerVerified(isWearer, dot.toFloat())
        } catch (t: Throwable) {
            logWarn("speaker verification failed (${t.message})")
            emitSpeakerVerified(true, 0f)
        }
    }

    private fun emitSpeakerVerified(isWearer: Boolean, similarity: Float) {
        val currentListener = listener ?: return
        host.dispatcher.post { currentListener.onSpeakerVerified(isWearer, similarity) }
    }

    private fun emitFrameMeta(angleDegrees: Int, ssr: Int) {
        val currentListener = listener ?: return
        host.dispatcher.post { currentListener.onFrameMeta(angleDegrees, ssr) }
    }

    private fun emitReplay(event: String, positionMs: Long, durationMs: Long) {
        val currentListener = listener ?: return
        host.dispatcher.post { currentListener.onReplay(event, positionMs, durationMs) }
    }

    private fun emitSpeechEnd() {
        val currentListener = listener ?: return
        host.dispatcher.post { currentListener.onSpeechEnd() }
    }

    private fun emitStopped(captureId: Int) {
        val currentListener = listener ?: return
        host.dispatcher.post { currentListener.onStopped(captureId) }
    }

    /** Called from the BLE notification thread for every glasses mic packet. */
    fun queueAudioPacket(data: ByteArray?, arm: String?, arrivalMs: Long) {
        if (!started || data == null) {
            return
        }
        if ("L" != arm && activeSource != Source.ARRAY) {
            wrongArmPackets++
        }
        audioQueue.put(AudioPacket(data, arm, arrivalMs)) {
            queuedPackets++
            if (lastPacketArrivalMs > 0) {
                val delta = arrivalMs - lastPacketArrivalMs
                if (delta > maxInterPacketMs) {
                    maxInterPacketMs = delta
                }
                if (delta > LATE_PACKET_INTERVAL_MS) {
                    latePackets++
                }
            }
            lastPacketArrivalMs = arrivalMs
        }
    }

    private fun takeAudioPacket(worker: Int): AudioPacket? {
        val packet = audioQueue.take(250) { active(worker) }
        if (packet == null) {
            maybeEmitAudioStats(false)
        }
        return packet
    }

    private fun resetAudioStats() {
        queuedPackets = 0
        decodedSamples = 0
        latePackets = 0
        wrongArmPackets = 0
        lastPacketArrivalMs = 0
        maxInterPacketMs = 0
        lastStatsAtMs = platform.elapsedRealtimeMs()
    }

    /** Diagnostic packet accounting for tests and adapters. */
    class AudioStats(
        val queuedPackets: Long,
        val queueDroppedPackets: Long,
        val latePackets: Long,
        val wrongArmPackets: Long,
        val maxInterPacketMs: Long,
        val decodedSamples: Long,
    )

    fun audioStats(): AudioStats = AudioStats(
        queuedPackets, audioQueue.droppedCount, latePackets, wrongArmPackets, maxInterPacketMs, decodedSamples,
    )

    private fun maybeEmitAudioStats(force: Boolean) {
        val now = platform.elapsedRealtimeMs()
        if (!force && now - lastStatsAtMs < STATS_INTERVAL_MS) {
            return
        }
        lastStatsAtMs = now
        val currentDecoder = packetDecoder
        val real = currentDecoder?.realPackets ?: 0L
        val duplicate = currentDecoder?.duplicatePackets ?: 0L
        val missing = currentDecoder?.missingPackets ?: 0L
        val decodeErrors = currentDecoder?.decodeErrors ?: 0L
        val status = "G2 mic packets=" + queuedPackets +
            " decoded=" + real +
            " missing=" + missing +
            " duplicate=" + duplicate +
            " late=" + latePackets +
            " maxGapMs=" + maxInterPacketMs +
            " queueDrop=" + audioQueue.droppedCount +
            " decodeErrors=" + decodeErrors +
            " wrongArm=" + wrongArmPackets +
            " audioSec=" + formatFixed(decodedSamples / SAMPLE_RATE.toDouble(), 1)
        // Audio-pipeline stats are diagnostic; keep them in the log only, out of
        // the on-glasses voice UI.
        logInfo(status + " expectedIntervalMs=" + EXPECTED_PACKET_INTERVAL_MS)
    }

    private fun emitStatus(status: String?) {
        val currentListener = listener ?: return
        host.dispatcher.post { currentListener.onStatus(status) }
    }

    private fun emitTranscript(text: String?, isFinal: Boolean) {
        val currentListener = listener ?: return
        logInfo("Emit transcript final=" + isFinal + " textLen=" + (text?.trim()?.length ?: 0))
        host.dispatcher.post { currentListener.onTranscript(text, isFinal) }
    }
}
