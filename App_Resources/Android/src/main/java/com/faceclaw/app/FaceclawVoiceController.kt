package com.faceclaw.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log

import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineMoonshineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizerResult
import com.k2fsa.sherpa.onnx.OfflineStream
import com.k2fsa.sherpa.onnx.OfflineWhisperModelConfig

import java.io.File
import java.nio.charset.StandardCharsets
import java.util.ArrayDeque
import java.util.Arrays

class FaceclawVoiceController(context: Context) {
    companion object {
        private const val TAG = "FaceclawVoice"
        private const val SAMPLE_RATE = 16000
        private const val FEATURE_DIM = 80
        private const val MAX_AUDIO_QUEUE_PACKETS = 80
        private const val EXPECTED_PACKET_INTERVAL_MS = 50
        private const val LATE_PACKET_INTERVAL_MS = 90
        private const val STATS_INTERVAL_MS = 5_000
        // Push-to-talk utterance boundaries come from the button. We re-decode the
        // current audio segment in full for each live partial and emit the complete
        // utterance text (REPLACE, never a delta). The sherpa Moonshine v2 decoder
        // used here fails once a single input grows past roughly 9.1 seconds, so
        // longer utterances are committed in model-safe segments.
        private const val TRANSCRIPT_DECODE_INTERVAL_MS = 700
        private const val TRANSCRIPT_MIN_SAMPLES = SAMPLE_RATE / 3
        private const val TRANSCRIPT_SEGMENT_MAX_SAMPLES = SAMPLE_RATE * 8
        // When a segment fills, cut at the quietest window within the last
        // TRANSCRIPT_CUT_SEARCH_SAMPLES rather than mid-word at the 8s mark; the
        // audio after the cut carries over into the next segment.
        private const val TRANSCRIPT_CUT_SEARCH_SAMPLES = SAMPLE_RATE * 2
        private const val TRANSCRIPT_CUT_WINDOW_SAMPLES = SAMPLE_RATE * 30 / 1000
        // Glasses-mic PCM peaks around 0.1 full scale, and at that level the
        // quantized Moonshine model often returns empty or garbled text. Boost
        // each decode window toward this peak, with a gain cap so near-silent
        // buffers aren't amplified into pure noise.
        private const val TRANSCRIPT_NORMALIZE_TARGET_PEAK = 0.9f
        private const val TRANSCRIPT_NORMALIZE_MAX_GAIN = 30f
        private const val TRANSCRIPT_LOG_PREVIEW_CHARS = 80
        // Model directory shared with the TS-side download flow (asr-model.ts),
        // which fetches the Moonshine files here on demand; they are no longer
        // bundled in the APK.
        private const val ASR_ROOT = "faceclaw-voice-asr"
        private const val ASR_MODEL_DIR = "sherpa-onnx-moonshine-base-en-quantized-2026-02-27"
        // Model files for the retired on-phone wake-word spotter, copied to
        // filesDir by earlier releases; deleted on sight to reclaim the space.
        // (The wakeword is now detected by the glasses firmware itself.)
        private const val LEGACY_KWS_ROOT = "faceclaw-voice"
        private val ASR_MODEL_FILES = arrayOf(
            "encoder_model.ort",
            "decoder_model_merged.ort",
            "tokens.txt"
        )
        // Second on-device model: sherpa-onnx's offline Whisper backend (base.en,
        // int8-quantized -- see the model-choice note in asr-model.ts). Directory
        // shared with the TS-side download flow, same convention as ASR_MODEL_DIR.
        //
        // On every call, sherpa-onnx (offline-recognizer-whisper-impl.h, v1.13.0)
        // runs Whisper's encoder over the whole buffer plus 1000 frames (~10s) of
        // zero tail padding, capped at 30s. Re-decoding on Moonshine's
        // TRANSCRIPT_DECODE_INTERVAL_MS live-partial cadence would repeat that
        // encode, growing with the utterance, roughly 1.4x/second while the user is
        // still speaking, so onboardModelKind gates that loop off for Whisper --
        // see processRecognizer(). Whisper is also known to hallucinate text on
        // near-silent input; recognizeTranscriptSegment() gates that too.
        private const val ASR_WHISPER_MODEL_DIR = "sherpa-onnx-whisper-base-en-int8"
        private val ASR_WHISPER_MODEL_FILES = arrayOf(
            "base.en-encoder.int8.onnx",
            "base.en-decoder.int8.onnx",
            "base.en-tokens.txt"
        )
        // Below this peak amplitude (pre-normalization, of a full-scale +/-1.0f
        // buffer) a segment is treated as silence and never reaches the Whisper
        // recognizer at all, rather than risking a hallucinated non-answer. Picked
        // conservatively low (well under typical mic noise floor already seen in
        // this pipeline's normalization target) -- UNTESTED on real hardware, tune
        // against real glasses captures rather than trusting this number.
        private const val WHISPER_SILENCE_PEAK_THRESHOLD = 0.01f

        // Speaker verification against the enrolled wearer voice-print ("my voice
        // only" command gating). Configured before start(); the utterance PCM is
        // buffered (capped) and verified once at session end.
        private const val VERIFY_MAX_SAMPLES = SAMPLE_RATE * 10
        private const val VERIFY_MIN_SAMPLES = SAMPLE_RATE

        // 50 ms chunks match the G2 packet cadence the rest of the pipeline
        // (endpointing, transcript pacing) is tuned for.
        private const val PHONE_MIC_CHUNK_SAMPLES = SAMPLE_RATE / 20

        @JvmStatic
        private fun buildWavHeader(pcmBytes: Int, sampleRate: Int, channels: Int, bitsPerSample: Int): ByteArray {
            val byteRate = sampleRate * channels * bitsPerSample / 8
            val blockAlign = channels * bitsPerSample / 8
            val dataSize = pcmBytes
            val riffSize = 36 + dataSize
            val b = java.nio.ByteBuffer.allocate(44).order(java.nio.ByteOrder.LITTLE_ENDIAN)
            b.put("RIFF".toByteArray(StandardCharsets.US_ASCII))
            b.putInt(riffSize)
            b.put("WAVE".toByteArray(StandardCharsets.US_ASCII))
            b.put("fmt ".toByteArray(StandardCharsets.US_ASCII))
            b.putInt(16)                       // PCM fmt chunk size
            b.putShort(1.toShort())            // PCM
            b.putShort(channels.toShort())
            b.putInt(sampleRate)
            b.putInt(byteRate)
            b.putShort(blockAlign.toShort())
            b.putShort(bitsPerSample.toShort())
            b.put("data".toByteArray(StandardCharsets.US_ASCII))
            b.putInt(dataSize)
            return b.array()
        }

        @JvmStatic
        private fun deleteRecursively(file: File) {
            if (!file.exists()) {
                return
            }
            val children = file.listFiles()
            if (children != null) {
                for (child in children) {
                    deleteRecursively(child)
                }
            }
            file.delete()
        }

        @JvmStatic
        private fun peakAmplitude(samples: FloatArray): Float {
            var peak = 0f
            for (s in samples) {
                val a = Math.abs(s)
                if (a > peak) {
                    peak = a
                }
            }
            return peak
        }

        @JvmStatic
        private fun normalizePeak(samples: FloatArray) {
            val peak = peakAmplitude(samples)
            if (peak <= 0f) {
                return
            }
            val gain = Math.min(TRANSCRIPT_NORMALIZE_TARGET_PEAK / peak, TRANSCRIPT_NORMALIZE_MAX_GAIN)
            if (gain <= 1f) {
                return
            }
            for (i in samples.indices) {
                samples[i] *= gain
            }
        }

        @JvmStatic
        private fun joinTranscript(prefix: String?, suffix: String?): String {
            if (prefix == null || prefix.length == 0) {
                return suffix ?: ""
            }
            if (suffix == null || suffix.length == 0) {
                return prefix
            }
            val first = suffix[0]
            val attachesToPrevious = ".,!?;:%)]}".indexOf(first) >= 0
            return prefix + (if (attachesToPrevious) "" else " ") + suffix
        }

        // The 28 MB embedding model takes seconds to load; keep one instance
        // across capture sessions so verification adds only the embed time.
        private var sharedSpeakerId: FaceclawSpeakerId? = null
        private var sharedSpeakerIdPath: String? = null

        @JvmStatic
        @Synchronized
        private fun cachedSpeakerId(modelPath: String): FaceclawSpeakerId {
            if (sharedSpeakerId == null || modelPath != sharedSpeakerIdPath) {
                if (sharedSpeakerId != null) {
                    sharedSpeakerId!!.close()
                }
                sharedSpeakerId = FaceclawSpeakerId(modelPath)
                sharedSpeakerIdPath = modelPath
            }
            return sharedSpeakerId!!
        }
    }

    private enum class VoiceInputMode {
        ONBOARD,  // on-phone transcription (Moonshine or Whisper; see onboardModelKind)
        CLOUD     // decode locally, emit PCM for a cloud recognizer on the TS side
    }

    /** Which on-device model ONBOARD mode uses. Set via setOnboardModelKind() before start(). */
    private enum class OnboardModelKind {
        MOONSHINE,
        WHISPER
    }

    private val appContext: Context = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())
    private val lock = Any()
    private val audioQueueLock = Any()
    private val audioQueue = ArrayDeque<AudioPacket>()
    @Volatile
    private var listener: FaceclawVoiceControllerListener? = null
    @Volatile
    private var communicator: FaceclawBleCommunicator? = null
    private var workerThread: Thread? = null
    @Volatile
    private var started = false
    // Set once the worker has the glasses mic enabled for this session.
    // Read and written under `lock`, so it flips with `started` atomically.
    private var audioStarted = false
    // Capture from the phone's own microphone instead of the G2 over BLE
    // (preview-only mode, where no glasses are connected). Latched into
    // activePhoneMic at start() (under `lock`) so a mid-session setter call
    // can't switch pipelines underneath the worker.
    @Volatile
    private var usePhoneMic = false
    private var activePhoneMic = false
    private var mode = VoiceInputMode.CLOUD
    @Volatile
    private var onboardModelKind = OnboardModelKind.MOONSHINE
    private var recognizer: OfflineRecognizer? = null
    private var lc3Decoder: FaceclawLc3Decoder? = null
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
    private var recordingPcm: java.io.ByteArrayOutputStream? = null
    // Speaker verification against the enrolled wearer voice-print ("my voice
    // only" command gating). Configured before start(); the utterance PCM is
    // buffered (capped) and verified once at session end.
    @Volatile
    private var verifySpeakerModelPath: String? = null
    @Volatile
    private var verifyWearerEmbedding: FloatArray? = null
    @Volatile
    private var verifyThreshold = 0.8f
    private var verifyBuffer: ShortArray? = null
    private var verifyCount = 0
    // Global mic processing (Microphones app config): spectral noise
    // suppression and firmware-DoA beam gating, applied to every capture
    // session that opts in (assistant push-to-talk, Transcribe, hands-free).
    // The raw tap opts out — raw means raw, and the Microphones session does
    // its own beam-compensated processing on that path.
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
    private var queueDroppedPackets: Long = 0
    private var decodedSamples: Long = 0
    private var latePackets: Long = 0
    private var wrongArmPackets: Long = 0
    private var lastPacketArrivalMs: Long = 0
    private var maxInterPacketMs: Long = 0
    private var lastStatsAtMs: Long = 0

    fun setListener(listener: FaceclawVoiceControllerListener?) {
        this.listener = listener
    }

    fun setCommunicator(communicator: FaceclawBleCommunicator?) {
        this.communicator = communicator
    }

    /** Source the next capture from the phone microphone (no glasses paired). */
    fun setUsePhoneMic(usePhoneMic: Boolean) {
        this.usePhoneMic = usePhoneMic
    }

    /** When true, the decoded mic PCM for each session is saved as a WAV. */
    fun setSaveRecordings(saveRecordings: Boolean) {
        this.saveRecordings = saveRecordings
    }

    /**
     * Which on-device model {@link #start}("onboard") should load: "whisper"
     * selects the second on-device model (sherpa-onnx offline Whisper); any
     * other value (including null/absent) keeps the existing Moonshine model,
     * so callers that never call this see unchanged behavior. Must be set
     * before {@link #start}; has no effect in CLOUD mode.
     */
    fun setOnboardModelKind(kind: String?) {
        this.onboardModelKind = if ("whisper" == kind) OnboardModelKind.WHISPER else OnboardModelKind.MOONSHINE
    }

    /**
     * When true, watch the decoded PCM and fire {@code onSpeechEnd} once the
     * speaker stops. Used by hands-free ("Hey Even") capture, which has no
     * button release to end the utterance. Must be set before {@link #start}.
     */
    fun setEndpointing(endpointing: Boolean) {
        this.endpointing = endpointing
    }

    /**
     * Verify this session's speaker against the enrolled wearer voice-print
     * and report the result via onSpeakerVerified just before the final
     * transcript. Must be set before {@link #start}; pass a null model path
     * to disable.
     */
    fun setSpeakerVerification(speakerModelPath: String?, wearerEmbedding: FloatArray?, threshold: Float) {
        this.verifySpeakerModelPath = speakerModelPath
        this.verifyWearerEmbedding = wearerEmbedding
        this.verifyThreshold = if (threshold > 0) threshold else 0.8f
    }

    fun clearSpeakerVerification() {
        this.verifySpeakerModelPath = null
        this.verifyWearerEmbedding = null
    }

    /** Spectral noise suppression on the decoded stream. Safe to flip mid-run. */
    fun setNoiseSuppression(enabled: Boolean) {
        this.suppressionEnabled = enabled
    }

    /**
     * Direction gating from the Sonic Radar beam: packets whose firmware
     * direction-of-arrival falls outside centerDeg ± halfWidthDeg (device
     * frame, 0 = straight ahead, positive right) are dropped before any
     * consumer sees them. Safe to update mid-run.
     */
    fun setBeamFilter(enabled: Boolean, centerDeg: Int, halfWidthDeg: Int) {
        this.beamFilterEnabled = enabled
        this.beamCenterDeg = centerDeg
        this.beamHalfWidthDeg = Math.max(5, Math.min(180, halfWidthDeg))
    }

    private fun withinBeam(angleDegrees: Int): Boolean {
        var delta = angleDegrees - beamCenterDeg
        while (delta > 180) delta -= 360
        while (delta < -180) delta += 360
        return Math.abs(delta) <= beamHalfWidthDeg
    }

    private fun applySuppression(pcm: ShortArray, count: Int) {
        try {
            if (suppressor == null) {
                suppressor = FaceclawNoiseSuppressor(SAMPLE_RATE)
            }
            val le = ByteArray(count * 2)
            for (i in 0 until count) {
                le[i * 2] = (pcm[i].toInt() and 0xff).toByte()
                le[i * 2 + 1] = ((pcm[i].toInt() shr 8) and 0xff).toByte()
            }
            val cleaned = suppressor!!.process(le)!!
            val cleanedCount = Math.min(count, cleaned.size / 2)
            for (i in 0 until cleanedCount) {
                pcm[i] = ((cleaned[i * 2].toInt() and 0xff) or (cleaned[i * 2 + 1].toInt() shl 8)).toShort()
            }
        } catch (t: Throwable) {
            Log.w(TAG, "noise suppression failed; passing audio through", t)
            suppressionEnabled = false
        }
    }

    fun start(requestedMode: String?) {
        start(requestedMode, 0)
    }

    fun start(requestedMode: String?, captureId: Int) {
        synchronized(lock) {
            if (started) {
                emitStatus("Voice control is already listening.")
                emitStopped(captureId)
                return
            }
            if (!usePhoneMic && (communicator == null || !communicator!!.isSessionReady())) {
                emitStatus("Voice control needs an active G2 connection.")
                emitStopped(captureId)
                return
            }
            mode = parseMode(requestedMode)
            activePhoneMic = usePhoneMic
            started = true
            audioStarted = false
            workerThread = Thread(Runnable { runLoop(captureId) }, "FaceclawVoiceController")
            workerThread!!.start()
        }
    }

    /**
     * Whether mic audio is actually flowing. {@link #start} only records
     * intent: the enable lives in the glasses' EvenHub session, so a transport
     * drop or a session suspend can leave this controller started with a
     * worker that will never see another packet. Anything deciding whether to
     * (re)start capture must ask this rather than assume its own bookkeeping.
     */
    fun isCapturing(): Boolean {
        val audioUp: Boolean
        val phoneMic: Boolean
        synchronized(lock) {
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
            // AudioRecord has no session to lose the enable to; it runs until stop().
            return true
        }
        val currentCommunicator = communicator
        return currentCommunicator != null && currentCommunicator.isAudioCaptureActive()
    }

    fun stop() {
        val threadToJoin: Thread?
        synchronized(lock) {
            if (!started) {
                return
            }
            started = false
            threadToJoin = workerThread
        }
        stopG2Audio()
        synchronized(audioQueueLock) {
            (audioQueueLock as java.lang.Object).notifyAll()
        }
        if (threadToJoin != null) {
            threadToJoin.interrupt()
            if (Thread.currentThread() !== threadToJoin) {
                try {
                    threadToJoin.join(1500)
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                }
            }
        }
    }

    fun close() {
        stop()
    }

    private fun parseMode(requestedMode: String?): VoiceInputMode {
        if ("cloud" == requestedMode) {
            return VoiceInputMode.CLOUD
        }
        return VoiceInputMode.ONBOARD
    }

    private fun runLoop(captureId: Int) {
        try {
            deleteLegacyKwsFiles()
            val currentMode = mode
            val currentOnboardKind = onboardModelKind
            if (currentMode == VoiceInputMode.ONBOARD) {
                val modelDir = findAsrModelDir(currentOnboardKind)
                if (modelDir == null) {
                    emitStatus("Voice model not downloaded (see Settings > Voice).")
                    return
                }
                emitStatus("Loading transcription model...")
                recognizer = OfflineRecognizer(buildRecognizerConfig(modelDir, currentOnboardKind))
                resetTranscriptState()
                lastTranscript = ""
            }
            endpointDetector.reset()
            if (suppressor != null) {
                suppressor!!.reset()
            }
            recordingPcm = if (saveRecordings) java.io.ByteArrayOutputStream(SAMPLE_RATE * 2 * 4) else null
            val verifying = verifySpeakerModelPath != null && verifyWearerEmbedding != null
            verifyBuffer = if (verifying) ShortArray(VERIFY_MAX_SAMPLES) else null
            verifyCount = 0
            if (activePhoneMic) {
                val record = openPhoneMic()
                if (record == null) {
                    emitStatus("Could not start the phone microphone.")
                    return
                }
                synchronized(lock) {
                    audioStarted = true
                }
                emitStatus(if (currentMode == VoiceInputMode.CLOUD)
                    "Listening (cloud)..."
                else
                    "Listening...")
                try {
                    processPhoneAudio(record)
                } finally {
                    try {
                        record.stop()
                    } catch (ignored: Throwable) {
                        // Already stopped or never recording; release below either way.
                    }
                    record.release()
                }
            } else {
                lc3Decoder = FaceclawLc3Decoder()
                if (!startG2Audio()) {
                    emitStatus("Could not start G2 microphone input.")
                    return
                }
                synchronized(lock) {
                    audioStarted = true
                }
                emitStatus(if (currentMode == VoiceInputMode.CLOUD)
                    "Listening (cloud)..."
                else
                    "Listening...")
                processG2Audio()
            }
            // Verification result must precede the final transcript so the
            // TS bridge can suppress a non-wearer command before it is acted
            // on (the callbacks are posted in order to the main handler).
            runSpeakerVerification()
            // Button released / stop requested: emit one final full-utterance
            // transcript so the UI can freeze it.
            if (currentMode == VoiceInputMode.ONBOARD) {
                decodeTranscript(true)
            }
        } catch (error: Throwable) {
            Log.e(TAG, "Voice control failed", error)
            emitStatus("Voice control failed: " + error.message)
        } finally {
            stopG2Audio()
            writeRecordingIfAny()
            releaseSherpa()
            releaseLc3()
            synchronized(lock) {
                started = false
                audioStarted = false
                workerThread = null
            }
            emitStopped(captureId)
        }
    }

    private fun appendRecording(pcm: ShortArray, count: Int) {
        val out = recordingPcm
        if (out == null) {
            return
        }
        for (i in 0 until count) {
            val s = pcm[i].toInt()
            out.write(s and 0xff)
            out.write((s shr 8) and 0xff)
        }
    }

    /** Save the session's decoded mic PCM as a 16 kHz mono 16-bit WAV. */
    private fun writeRecordingIfAny() {
        val out = recordingPcm
        recordingPcm = null
        if (out == null || out.size() == 0) {
            return
        }
        try {
            val pcmBytes = out.toByteArray()
            val dir = java.io.File(appContext.getExternalFilesDir(null), "voice-recordings")
            if (!dir.exists() && !dir.mkdirs()) {
                Log.w(TAG, "could not create voice-recordings dir")
                return
            }
            val stamp = java.text.SimpleDateFormat("yyyyMMdd-HHmmss-SSS", java.util.Locale.US)
                .format(java.util.Date())
            val file = java.io.File(dir, "voice-$stamp.wav")
            java.io.FileOutputStream(file).use { fos ->
                fos.write(buildWavHeader(pcmBytes.size, SAMPLE_RATE, 1, 16))
                fos.write(pcmBytes)
            }
            Log.i(TAG, "saved voice recording " + file.absolutePath
                + " samples=" + (pcmBytes.size / 2)
                + " sec=" + String.format(java.util.Locale.US, "%.2f", pcmBytes.size / 2.0 / SAMPLE_RATE))
        } catch (t: Throwable) {
            Log.w(TAG, "failed to save voice recording", t)
        }
    }

    private fun buildRecognizerConfig(modelDir: File, kind: OnboardModelKind): OfflineRecognizerConfig {
        val modelConfig = OfflineModelConfig.builder()
            .setNumThreads(1)
        if (kind == OnboardModelKind.WHISPER) {
            modelConfig
                .setWhisper(OfflineWhisperModelConfig.builder()
                    .setEncoder(File(modelDir, "base.en-encoder.int8.onnx").absolutePath)
                    .setDecoder(File(modelDir, "base.en-decoder.int8.onnx").absolutePath)
                    .setLanguage("en")
                    .setTask("transcribe")
                    .build())
                .setTokens(File(modelDir, "base.en-tokens.txt").absolutePath)
        } else {
            modelConfig
                .setMoonshine(OfflineMoonshineModelConfig.builder()
                    .setEncoder(File(modelDir, "encoder_model.ort").absolutePath)
                    .setMergedDecoder(File(modelDir, "decoder_model_merged.ort").absolutePath)
                    .build())
                .setTokens(File(modelDir, "tokens.txt").absolutePath)
        }
        return OfflineRecognizerConfig.builder()
            .setFeatureConfig(FeatureConfig.builder()
                .setSampleRate(SAMPLE_RATE)
                .setFeatureDim(FEATURE_DIM)
                .build())
            .setModelConfig(modelConfig.build())
            .build()
    }

    /**
     * The on-device model directory for the given kind, populated by the
     * download flow in asr-model.ts (releases before 0.5.0 copied the
     * Moonshine files out of the APK directly, so upgraded installs are
     * already complete for that model). Null when any expected file is
     * missing, i.e. the model still needs to be downloaded.
     */
    private fun findAsrModelDir(kind: OnboardModelKind): File? {
        val whisper = kind == OnboardModelKind.WHISPER
        val dirName = if (whisper) ASR_WHISPER_MODEL_DIR else ASR_MODEL_DIR
        val fileNames = if (whisper) ASR_WHISPER_MODEL_FILES else ASR_MODEL_FILES
        val modelDir = File(appContext.filesDir, ASR_ROOT + File.separator + dirName)
        for (fileName in fileNames) {
            val file = File(modelDir, fileName)
            if (!file.exists() || file.length() == 0L) {
                return null
            }
        }
        return modelDir
    }

    private fun deleteLegacyKwsFiles() {
        try {
            deleteRecursively(File(appContext.filesDir, LEGACY_KWS_ROOT))
        } catch (t: Throwable) {
            Log.w(TAG, "failed to delete legacy wake-word files", t)
        }
    }

    private fun startG2Audio(): Boolean {
        val currentCommunicator = communicator
        if (currentCommunicator == null) {
            return false
        }
        resetAudioStats()
        synchronized(audioQueueLock) {
            audioQueue.clear()
        }
        return currentCommunicator.startG2AudioCapture(object : FaceclawAudioPacketListener {
            override fun onAudioPacket(data: ByteArray?, arm: String?, arrivalMs: Long) {
                queueAudioPacket(data, arm, arrivalMs)
            }
        })
    }

    private fun processG2Audio() {
        val pcm = ShortArray(FaceclawLc3Decoder.SAMPLES_PER_PACKET)
        while (started && !Thread.currentThread().isInterrupted) {
            val currentDecoder = lc3Decoder
            if (currentDecoder == null) {
                return
            }

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
            // Global mic processing from the Microphones app config: the
            // beam filter drops packets whose firmware direction-of-arrival
            // falls outside the listening wedge (isolating the aimed talker
            // for every consumer, recognition included), and the spectral
            // noise suppressor cleans what remains before it reaches the
            // recognizer, cloud PCM, endpointing, or speaker verification.
            val angleDegrees = currentDecoder.getLastAngleDegrees()
            val ssr = currentDecoder.getLastSsr()
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
    private fun processPcmChunk(pcm: ShortArray, count: Int, angleDegrees: Int, ssr: Int, hasFrameMeta: Boolean) {
        if (suppressionEnabled) {
            applySuppression(pcm, count)
        }
        if (recordingPcm != null) {
            appendRecording(pcm, count)
        }
        val verifyBuffer = this.verifyBuffer
        if (verifyBuffer != null && verifyCount < VERIFY_MAX_SAMPLES) {
            val copied = Math.min(count, VERIFY_MAX_SAMPLES - verifyCount)
            System.arraycopy(pcm, 0, verifyBuffer, verifyCount, copied)
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
        if (mode != VoiceInputMode.CLOUD) {
            val samples = FloatArray(count)
            for (i in 0 until count) {
                samples[i] = pcm[i] / 32768.0f
            }
            processRecognizer(samples)
        }
    }

    /**
     * Open the phone's own microphone at the pipeline's native format
     * (16 kHz mono PCM16), or null when it cannot start — the permission is
     * missing (SecurityException) or the device refuses the configuration.
     */
    private fun openPhoneMic(): android.media.AudioRecord? {
        var record: android.media.AudioRecord? = null
        try {
            val minBytes = android.media.AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                android.media.AudioFormat.CHANNEL_IN_MONO,
                android.media.AudioFormat.ENCODING_PCM_16BIT)
            val bufferBytes = Math.max(minBytes, PHONE_MIC_CHUNK_SAMPLES * 2 * 4)
            record = android.media.AudioRecord(
                android.media.MediaRecorder.AudioSource.VOICE_RECOGNITION,
                SAMPLE_RATE,
                android.media.AudioFormat.CHANNEL_IN_MONO,
                android.media.AudioFormat.ENCODING_PCM_16BIT,
                bufferBytes)
            if (record.state != android.media.AudioRecord.STATE_INITIALIZED) {
                record.release()
                return null
            }
            record.startRecording()
            if (record.recordingState != android.media.AudioRecord.RECORDSTATE_RECORDING) {
                record.release()
                return null
            }
            return record
        } catch (t: Throwable) {
            Log.w(TAG, "phone mic open failed", t)
            if (record != null) {
                record.release()
            }
            return null
        }
    }

    /**
     * Phone-mic capture loop: no LC3 decode, no arm bookkeeping, no frame
     * metadata — AudioRecord already delivers the pipeline's PCM format. The
     * blocking read returns every chunk (50 ms), which bounds how long a
     * stop() waits for the loop to notice `started` dropped.
     */
    private fun processPhoneAudio(record: android.media.AudioRecord) {
        val pcm = ShortArray(PHONE_MIC_CHUNK_SAMPLES)
        while (started && !Thread.currentThread().isInterrupted) {
            val read = record.read(pcm, 0, pcm.size)
            if (read < 0) {
                Log.w(TAG, "phone mic read failed: $read")
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
        // Each Whisper call re-encodes the whole buffer plus ~10s of tail
        // padding (see the ASR_WHISPER_* comment above),
        // so it skips the live-partial redecode Moonshine does on this
        // interval and only decodes when a segment commits (8s buffer fill)
        // or the utterance ends (decodeTranscript(true) in runLoop()). This
        // means no live preview text while speaking in Whisper mode -- status
        // stays "Listening..." until release. This is a deliberate tradeoff.
        if (onboardModelKind == OnboardModelKind.WHISPER) {
            return
        }
        val now = SystemClock.elapsedRealtime()
        if (transcriptSampleCount >= TRANSCRIPT_MIN_SAMPLES
            && now - lastTranscriptDecodeAtMs >= TRANSCRIPT_DECODE_INTERVAL_MS) {
            decodeTranscript(false)
            lastTranscriptDecodeAtMs = now
        }
    }

    private fun appendTranscriptSamples(samples: FloatArray) {
        var sourceOffset = 0
        while (sourceOffset < samples.size) {
            val available = TRANSCRIPT_SEGMENT_MAX_SAMPLES - transcriptSampleCount
            val count = Math.min(available, samples.size - sourceOffset)
            System.arraycopy(samples, sourceOffset, transcriptSamples, transcriptSampleCount, count)
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
        if (segmentText.length > 0) {
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
        val cut = findSegmentCutPoint()
        var segmentText = recognizeTranscriptSegment(cut)
        if (segmentText.length == 0) {
            // Fallback text came from partial decodes of the full buffer, so it
            // may include words from the carried-over tail; rare now that decode
            // windows are peak-normalized.
            segmentText = currentSegmentTranscript
        }
        committedTranscript = joinTranscript(committedTranscript, segmentText)
        currentSegmentTranscript = ""
        committedTranscriptSampleCount += cut.toLong()
        val tail = transcriptSampleCount - cut
        System.arraycopy(transcriptSamples, cut, transcriptSamples, 0, tail)
        transcriptSampleCount = tail
        lastTranscript = committedTranscript
        lastTranscriptDecodeAtMs = SystemClock.elapsedRealtime()
        logTranscriptDecode(false, cut, committedTranscript)
        emitTranscript(committedTranscript, false)
    }

    /**
     * Pick where to end the committed segment: the center of the quietest
     * window within the search region at the end of the buffer, so the cut
     * lands between words instead of splitting one.
     */
    private fun findSegmentCutPoint(): Int {
        val count = transcriptSampleCount
        val searchStart = Math.max(0, count - TRANSCRIPT_CUT_SEARCH_SAMPLES)
        val win = TRANSCRIPT_CUT_WINDOW_SAMPLES
        if (count - searchStart <= win) {
            return count
        }
        var sum = 0.0
        for (i in searchStart until searchStart + win) {
            sum += transcriptSamples[i].toDouble() * transcriptSamples[i]
        }
        var best = sum
        var bestStart = searchStart
        var start = searchStart + 1
        while (start + win <= count) {
            val dropped = transcriptSamples[start - 1]
            val added = transcriptSamples[start + win - 1]
            sum += added.toDouble() * added - dropped.toDouble() * dropped
            if (sum < best) {
                best = sum
                bestStart = start
            }
            start++
        }
        return bestStart + win / 2
    }

    private fun recognizeTranscriptSegment(sampleCount: Int): String {
        val currentRecognizer = recognizer
        if (currentRecognizer == null || sampleCount <= 0) {
            return ""
        }
        val segment = Arrays.copyOf(transcriptSamples, sampleCount)
        // Whisper hallucinates text on near-silent input (a known quirk of the
        // model, not this pipeline); gate it on the PRE-normalization peak, since
        // normalizePeak() below would otherwise amplify true silence right up to
        // the target level and hide the very thing being checked for. Moonshine
        // does not share this failure mode in practice, so it is left unchanged.
        if (onboardModelKind == OnboardModelKind.WHISPER && peakAmplitude(segment) < WHISPER_SILENCE_PEAK_THRESHOLD) {
            return ""
        }
        normalizePeak(segment)
        val offlineStream: OfflineStream = currentRecognizer.createStream()
        try {
            offlineStream.acceptWaveform(segment, SAMPLE_RATE)
            currentRecognizer.decode(offlineStream)
            val result: OfflineRecognizerResult? = currentRecognizer.getResult(offlineStream)
            val raw: String? = if (result == null) "" else result.text
            return raw?.trim() ?: ""
        } finally {
            offlineStream.release()
        }
    }

    private fun logTranscriptDecode(isFinal: Boolean, segmentSampleCount: Int, text: String) {
        val totalAudioSec =
            (committedTranscriptSampleCount + transcriptSampleCount) / SAMPLE_RATE.toDouble()
        val preview = if (text.length <= TRANSCRIPT_LOG_PREVIEW_CHARS)
            text else text.substring(0, TRANSCRIPT_LOG_PREVIEW_CHARS) + "..."
        Log.i(TAG, (if (onboardModelKind == OnboardModelKind.WHISPER) "Whisper" else "Moonshine") + " decode final=" + isFinal
            + " audioSec=" + String.format(java.util.Locale.US, "%.2f", totalAudioSec)
            + " segmentAudioSec=" + String.format(java.util.Locale.US, "%.2f", segmentSampleCount / SAMPLE_RATE.toDouble())
            + " textLen=" + text.length + " text=\"" + preview + "\"")
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
        val le = ByteArray(count * 2)
        for (i in 0 until count) {
            val s = pcm[i].toInt()
            le[i * 2] = (s and 0xff).toByte()
            le[i * 2 + 1] = ((s shr 8) and 0xff).toByte()
        }
        mainHandler.post { currentListener.onPcm(le) }
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
        val speakerId = cachedSpeakerId(modelPath)
        try {
            val le = ByteArray(verifyCount * 2)
            for (i in 0 until verifyCount) {
                val s = buffer[i].toInt()
                le[i * 2] = (s and 0xff).toByte()
                le[i * 2 + 1] = ((s shr 8) and 0xff).toByte()
            }
            val embedding = speakerId.embed(le, SAMPLE_RATE)
            if (embedding == null || embedding.size != wearer.size) {
                emitSpeakerVerified(true, 0f)
                return
            }
            var dot = 0.0
            for (i in embedding.indices) {
                dot += embedding[i].toDouble() * wearer[i]
            }
            val isWearer = dot >= verifyThreshold
            Log.i(TAG, "speaker verification similarity=" + String.format(java.util.Locale.US, "%.3f", dot)
                + " threshold=" + verifyThreshold + " isWearer=" + isWearer)
            emitSpeakerVerified(isWearer, dot.toFloat())
        } catch (t: Throwable) {
            Log.w(TAG, "speaker verification failed", t)
            emitSpeakerVerified(true, 0f)
        }
    }

    private fun emitSpeakerVerified(isWearer: Boolean, similarity: Float) {
        val currentListener = listener
        if (currentListener == null) {
            return
        }
        mainHandler.post { currentListener.onSpeakerVerified(isWearer, similarity) }
    }

    private fun emitFrameMeta(angleDegrees: Int, ssr: Int) {
        val currentListener = listener
        if (currentListener == null) {
            return
        }
        mainHandler.post { currentListener.onFrameMeta(angleDegrees, ssr) }
    }

    private fun emitSpeechEnd() {
        val currentListener = listener
        if (currentListener == null) {
            return
        }
        mainHandler.post { currentListener.onSpeechEnd() }
    }

    private fun emitStopped(captureId: Int) {
        val currentListener = listener
        if (currentListener != null) {
            mainHandler.post { currentListener.onStopped(captureId) }
        }
    }

    private fun stopG2Audio() {
        val currentCommunicator = communicator
        if (currentCommunicator != null) {
            currentCommunicator.stopG2AudioCapture()
        }
        maybeEmitAudioStats(true)
    }

    private fun releaseSherpa() {
        if (recognizer != null) {
            recognizer!!.release()
            recognizer = null
        }
    }

    private fun releaseLc3() {
        if (lc3Decoder != null) {
            lc3Decoder!!.close()
            lc3Decoder = null
        }
    }

    private fun queueAudioPacket(data: ByteArray?, arm: String?, arrivalMs: Long) {
        if (!started || data == null) {
            return
        }
        if ("L" != arm) {
            wrongArmPackets++
        }
        synchronized(audioQueueLock) {
            if (audioQueue.size >= MAX_AUDIO_QUEUE_PACKETS) {
                audioQueue.removeFirst()
                queueDroppedPackets++
            }
            audioQueue.addLast(AudioPacket(data, arm, arrivalMs))
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
            (audioQueueLock as java.lang.Object).notifyAll()
        }
    }

    private fun takeAudioPacket(): AudioPacket? {
        synchronized(audioQueueLock) {
            while (started && audioQueue.isEmpty()) {
                try {
                    (audioQueueLock as java.lang.Object).wait(250)
                    maybeEmitAudioStats(false)
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return null
                }
            }
            return audioQueue.pollFirst()
        }
    }

    private fun resetAudioStats() {
        queuedPackets = 0
        queueDroppedPackets = 0
        decodedSamples = 0
        latePackets = 0
        wrongArmPackets = 0
        lastPacketArrivalMs = 0
        maxInterPacketMs = 0
        lastStatsAtMs = SystemClock.elapsedRealtime()
    }

    private fun maybeEmitAudioStats(force: Boolean) {
        val now = SystemClock.elapsedRealtime()
        if (!force && now - lastStatsAtMs < STATS_INTERVAL_MS) {
            return
        }
        lastStatsAtMs = now
        val currentDecoder = lc3Decoder
        val real = if (currentDecoder == null) 0L else currentDecoder.getRealPackets()
        val duplicate = if (currentDecoder == null) 0L else currentDecoder.getDuplicatePackets()
        val missing = if (currentDecoder == null) 0L else currentDecoder.getMissingPackets()
        val decodeErrors = if (currentDecoder == null) 0L else currentDecoder.getDecodeErrors()
        val status = "G2 mic packets=" + queuedPackets +
            " decoded=" + real +
            " missing=" + missing +
            " duplicate=" + duplicate +
            " late=" + latePackets +
            " maxGapMs=" + maxInterPacketMs +
            "\n" +
            " queueDrop=" + queueDroppedPackets +
            " decodeErrors=" + decodeErrors +
            " wrongArm=" + wrongArmPackets +
            " audioSec=" + String.format(java.util.Locale.US, "%.1f", decodedSamples / SAMPLE_RATE.toDouble())
        // Audio-pipeline stats are diagnostic; keep them in logcat only, out of
        // the on-glasses voice UI.
        Log.i(TAG, status.replace('\n', ' ') + " expectedIntervalMs=" + EXPECTED_PACKET_INTERVAL_MS)
    }

    private fun emitStatus(status: String?) {
        val currentListener = listener
        if (currentListener == null) {
            return
        }
        mainHandler.post { currentListener.onStatus(status) }
    }

    private fun emitTranscript(text: String?, isFinal: Boolean) {
        val currentListener = listener
        if (currentListener == null) {
            return
        }
        Log.i(TAG, "Emit transcript final=" + isFinal + " textLen=" + (text?.trim()?.length ?: 0))
        mainHandler.post { currentListener.onTranscript(text, isFinal) }
    }

    private class AudioPacket(val data: ByteArray?, arm: String?, val arrivalMs: Long) {
        val arm: String = arm ?: "?"
    }
}
