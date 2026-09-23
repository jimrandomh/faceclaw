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

    /** Where a saved recording goes, or null when recordings cannot be stored. */
    fun recordingSink(): RecordingSink?
}

/**
 * Voice-input capture pipeline shared by both platforms: LC3 packet queue with drop/late
 * accounting, firmware-DoA beam gate, per-chunk processing (suppression, recording, speaker
 * verification buffer, endpointing, PCM emit), the segmented on-device transcript machine with
 * REPLACE-semantics partials, and speaker verification at session end. The session owns its
 * worker thread (started through the shared [startThread]); listener callbacks go through the
 * host's [CallbackDispatcher] so the adapter decides the delivery thread.
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

    private class AudioPacket(val data: ByteArray, arm: String?, val arrivalMs: Long) {
        val arm: String = arm ?: "?"
    }

    private val lock = platform.createLock()
    private val audioQueue = DroppingPacketQueue<AudioPacket>(MAX_AUDIO_QUEUE_PACKETS, platform)
    @Volatile
    private var listener: FaceclawVoiceControllerListener? = null
    @Volatile
    private var started = false
    // Set once the worker has the mic enabled for this session. Read and
    // written under `lock`, so it flips with `started` atomically.
    private var audioStarted = false
    private var workerFinished: Latch? = null
    @Volatile
    private var workerThreadName: String? = null
    // Capture from the phone's own microphone instead of the G2 over BLE
    // (preview-only mode). Latched into activePhoneMic at start() (under `lock`)
    // so a mid-session setter call can't switch pipelines underneath the worker.
    @Volatile
    private var usePhoneMic = false
    private var activePhoneMic = false
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
    private var saveRecordings = false
    @Volatile
    private var endpointing = false
    private val endpointDetector = VoiceEndpointDetector()
    private var recordingPcm: ByteSink? = null
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

    fun setSaveRecordings(saveRecordings: Boolean) {
        this.saveRecordings = saveRecordings
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
            if (!usePhoneMic && !host.isG2SessionReady()) {
                emitStatus("Voice control needs an active G2 connection.")
                emitStopped(captureId)
                return
            }
            mode = parseMode(requestedMode)
            activePhoneMic = usePhoneMic
            started = true
            audioStarted = false
            val finished = Latch(1, platform)
            workerFinished = finished
            startThread(threadName, true) { runLoop(captureId, finished) }
        }
    }

    /**
     * Whether mic audio is actually flowing. start() only records intent: the
     * enable lives in the glasses' EvenHub session, so a transport drop or a
     * session suspend can leave this session started with a worker that will
     * never see another packet.
     */
    fun isCapturing(): Boolean {
        var audioUp = false
        var phoneMic = false
        lock.withLock {
            if (!started) {
                return false
            }
            audioUp = audioStarted
            phoneMic = activePhoneMic
        }
        if (!audioUp) {
            // The worker is still bringing the mic up; report it as running so
            // a concurrent request shares it instead of restarting it.
            return true
        }
        if (phoneMic) {
            // The phone mic has no session to lose the enable to; it runs until stop().
            return true
        }
        return host.isG2AudioCaptureActive()
    }

    /**
     * Stops the session and waits up to 1.5 s for the worker to finish unless
     * called from the worker itself. The worker checks the stop flag between
     * packets (every packet or 250 ms wait) and between phone-mic reads (50 ms).
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
        stopG2Audio()
        audioQueue.wake()
        if (finished != null && (workerName == null || currentThreadName() != workerName)) {
            finished.await(1500)
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

    private fun runLoop(captureId: Int, finished: Latch) {
        workerThreadName = currentThreadName()
        try {
            host.onSessionStarting()
            val currentMode = mode
            val currentOnboardKind = onboardModelKind
            if (currentMode == Mode.ONBOARD) {
                if (!host.hasTranscriberModel(currentOnboardKind)) {
                    emitStatus("Voice model not downloaded (see Settings > Voice).")
                    return
                }
                emitStatus("Loading transcription model...")
                recognizer = host.loadTranscriber(currentOnboardKind)
                resetTranscriptState()
                lastTranscript = ""
            }
            endpointDetector.reset()
            suppressor?.reset()
            recordingPcm = if (saveRecordings) ByteSink(SAMPLE_RATE * 2 * 4) else null
            val verifying = verifySpeakerModelPath != null && verifyWearerEmbedding != null
            verifyBuffer = if (verifying) ShortArray(VERIFY_MAX_SAMPLES) else null
            verifyCount = 0
            if (activePhoneMic) {
                val record = host.openPhoneMic()
                if (record == null) {
                    emitStatus("Could not start the phone microphone.")
                    return
                }
                lock.withLock { audioStarted = true }
                emitStatus(if (currentMode == Mode.CLOUD) "Listening (cloud)..." else "Listening...")
                try {
                    processPhoneAudio(record)
                } finally {
                    record.close()
                }
            } else {
                packetDecoder = host.createPacketDecoder()
                if (!startG2Audio()) {
                    emitStatus("Could not start G2 microphone input.")
                    return
                }
                lock.withLock { audioStarted = true }
                emitStatus(if (currentMode == Mode.CLOUD) "Listening (cloud)..." else "Listening...")
                processG2Audio()
            }
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
            stopG2Audio()
            writeRecordingIfAny()
            releaseRecognizer()
            releaseDecoder()
            lock.withLock {
                started = false
                audioStarted = false
                workerFinished = null
                workerThreadName = null
            }
            emitStopped(captureId)
            finished.countDown()
        }
    }

    private fun appendRecording(pcm: ShortArray, count: Int) {
        val out = recordingPcm ?: return
        out.write(AudioSegmentation.pcm16ToLittleEndian(pcm, 0, count))
    }

    private fun writeRecordingIfAny() {
        val out = recordingPcm
        recordingPcm = null
        if (out == null || out.size() == 0) {
            return
        }
        val sink = host.recordingSink() ?: return
        try {
            sink.save(out.toByteArray(), SAMPLE_RATE)
        } catch (t: Throwable) {
            logWarn("failed to save voice recording (${t.message})")
        }
    }

    private fun startG2Audio(): Boolean {
        val source = host.g2AudioSource() ?: return false
        resetAudioStats()
        audioQueue.clear()
        return source.start(object : FaceclawAudioPacketListener {
            override fun onAudioPacket(data: ByteArray?, arm: String?, arrivalMs: Long) {
                queueAudioPacket(data, arm, arrivalMs)
            }
        })
    }

    private fun processG2Audio() {
        val pcm = ShortArray(PACKET_SAMPLES)
        while (started) {
            val currentDecoder = packetDecoder ?: return
            val packet = takeAudioPacket()
            if (packet == null) {
                continue
            }
            val count = currentDecoder.decodePacket(packet.data, pcm)
            if (count <= 0) {
                maybeEmitAudioStats(false)
                continue
            }
            decodedSamples += count.toLong()
            // The beam filter drops packets whose firmware direction-of-arrival
            // falls outside the listening wedge (isolating the aimed talker for
            // every consumer, recognition included); the spectral noise
            // suppressor then cleans what remains before it reaches the
            // recognizer, cloud PCM, endpointing, or speaker verification.
            val angleDegrees = currentDecoder.lastAngleDegrees
            val ssr = currentDecoder.lastSsr
            if (beamFilterEnabled && ssr > 0 && !withinBeam(angleDegrees)) {
                emitFrameMeta(angleDegrees, ssr)
                maybeEmitAudioStats(false)
                continue
            }
            processPcmChunk(pcm, count, angleDegrees, ssr, true)
            maybeEmitAudioStats(false)
        }
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
        if (recordingPcm != null) {
            appendRecording(pcm, count)
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
     * long a stop() waits for the loop to notice `started` dropped.
     */
    private fun processPhoneAudio(record: PcmAudioSource) {
        val pcm = ShortArray(SAMPLE_RATE / 20)
        while (started) {
            val read = record.read(pcm)
            if (read < 0) {
                logWarn("phone mic read failed: $read")
                return
            }
            if (read == 0) {
                continue
            }
            decodedSamples += read.toLong()
            processPcmChunk(pcm, read, 0, 0, false)
        }
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

    private fun emitSpeechEnd() {
        val currentListener = listener ?: return
        host.dispatcher.post { currentListener.onSpeechEnd() }
    }

    private fun emitStopped(captureId: Int) {
        val currentListener = listener ?: return
        host.dispatcher.post { currentListener.onStopped(captureId) }
    }

    private fun stopG2Audio() {
        host.g2AudioSource()?.stop()
        maybeEmitAudioStats(true)
    }

    private fun releaseRecognizer() {
        recognizer?.release()
        recognizer = null
    }

    private fun releaseDecoder() {
        packetDecoder?.close()
        packetDecoder = null
    }

    /** Called from the BLE notification thread for every glasses mic packet. */
    fun queueAudioPacket(data: ByteArray?, arm: String?, arrivalMs: Long) {
        if (!started || data == null) {
            return
        }
        if ("L" != arm) {
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

    private fun takeAudioPacket(): AudioPacket? {
        val packet = audioQueue.take(250) { started }
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
