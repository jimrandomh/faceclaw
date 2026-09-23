package com.faceclaw.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log

import java.io.File

/**
 * Android host for the shared [VoiceCaptureSession]: supplies the glasses packet source (the
 * BLE communicator), the phone microphone, the sherpa-onnx recognizer and speaker model, model
 * directory lookup, recording storage, and main-thread callback delivery. The capture pipeline
 * itself (packet queue, beam gate, endpointing, segmented transcript, verification) is shared
 * with iOS.
 */
class FaceclawVoiceController(context: Context) {
    companion object {
        private const val TAG = "FaceclawVoice"
        private const val SAMPLE_RATE = 16000
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
        // Whisper re-encodes the whole buffer on every call, so the shared session
        // skips live partials for it; see VoiceCaptureSession.processRecognizer.
        private const val ASR_WHISPER_MODEL_DIR = "sherpa-onnx-whisper-base-en-int8"
        private val ASR_WHISPER_MODEL_FILES = arrayOf(
            "base.en-encoder.int8.onnx",
            "base.en-decoder.int8.onnx",
            "base.en-tokens.txt"
        )
        // 50 ms chunks match the G2 packet cadence the rest of the pipeline
        // (endpointing, transcript pacing) is tuned for.
        private const val PHONE_MIC_CHUNK_SAMPLES = SAMPLE_RATE / 20

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

    private val appContext: Context = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile
    private var communicator: FaceclawBleCommunicator? = null

    private val host = object : VoiceCaptureHost {
        override val dispatcher = CallbackDispatcher { action -> mainHandler.post { action() } }

        override fun onSessionStarting() {
            deleteLegacyKwsFiles()
        }

        override fun isG2SessionReady(): Boolean {
            val currentCommunicator = communicator
            return currentCommunicator != null && currentCommunicator.isSessionReady()
        }

        override fun isG2AudioCaptureActive(): Boolean {
            val currentCommunicator = communicator
            return currentCommunicator != null && currentCommunicator.isAudioCaptureActive()
        }

        override fun g2AudioSource(): PacketAudioSource? {
            val currentCommunicator = communicator ?: return null
            return object : PacketAudioSource {
                override fun start(listener: FaceclawAudioPacketListener): Boolean =
                    currentCommunicator.startG2AudioCapture(listener)

                override fun stop() = currentCommunicator.stopG2AudioCapture()

                override fun isActive(): Boolean = currentCommunicator.isAudioCaptureActive()
            }
        }

        override fun createPacketDecoder(): AudioPacketDecoder = AndroidSpeechEngines.Lc3DecoderAdapter()

        override fun openPhoneMic(): PcmAudioSource? = AndroidSpeechEngines.openPhoneMic(PHONE_MIC_CHUNK_SAMPLES)

        override fun hasTranscriberModel(kind: VoiceModelKind): Boolean = findAsrModelDir(kind) != null

        override fun loadTranscriber(kind: VoiceModelKind): OfflineTranscriber {
            val modelDir = findAsrModelDir(kind) ?: throw IllegalStateException("voice model missing")
            return AndroidSpeechEngines.SherpaTranscriber(AndroidSpeechEngines.recognizerConfig(modelDir, kind))
        }

        override fun speakerEmbedder(modelPath: String): SpeakerEmbedder {
            val cached = cachedSpeakerId(modelPath)
            // The cached model outlives the session; never release it here.
            return object : SpeakerEmbedder {
                override fun embed(pcm16le: ByteArray, sampleRate: Int): FloatArray? = cached.embed(pcm16le, sampleRate)

                override fun release() {}
            }
        }

        override fun recordingSink(): RecordingSink = RecordingSink { pcmBytes, sampleRate -> saveRecording(pcmBytes, sampleRate) }
    }

    private val session = VoiceCaptureSession(host)

    fun setListener(listener: FaceclawVoiceControllerListener?) {
        session.setListener(listener)
    }

    fun setCommunicator(communicator: FaceclawBleCommunicator?) {
        this.communicator = communicator
    }

    /** Source the next capture from the phone microphone (no glasses paired). */
    fun setUsePhoneMic(usePhoneMic: Boolean) {
        session.setUsePhoneMic(usePhoneMic)
    }

    /** When true, the decoded mic PCM for each session is saved as a WAV. */
    fun setSaveRecordings(saveRecordings: Boolean) {
        session.setSaveRecordings(saveRecordings)
    }

    /**
     * Which on-device model {@link #start}("onboard") should load: "whisper"
     * selects the second on-device model (sherpa-onnx offline Whisper); any
     * other value (including null/absent) keeps the existing Moonshine model.
     * Must be set before {@link #start}; has no effect in CLOUD mode.
     */
    fun setOnboardModelKind(kind: String?) {
        session.setOnboardModelKind(kind)
    }

    /**
     * When true, watch the decoded PCM and fire {@code onSpeechEnd} once the
     * speaker stops. Used by hands-free ("Hey Even") capture, which has no
     * button release to end the utterance. Must be set before {@link #start}.
     */
    fun setEndpointing(endpointing: Boolean) {
        session.setEndpointing(endpointing)
    }

    /**
     * Verify this session's speaker against the enrolled wearer voice-print
     * and report the result via onSpeakerVerified just before the final
     * transcript. Must be set before {@link #start}; pass a null model path
     * to disable.
     */
    fun setSpeakerVerification(speakerModelPath: String?, wearerEmbedding: FloatArray?, threshold: Float) {
        session.setSpeakerVerification(speakerModelPath, wearerEmbedding, threshold)
    }

    fun clearSpeakerVerification() {
        session.clearSpeakerVerification()
    }

    /** Spectral noise suppression on the decoded stream. Safe to flip mid-run. */
    fun setNoiseSuppression(enabled: Boolean) {
        session.setNoiseSuppression(enabled)
    }

    /**
     * Direction gating from the Sonic Radar beam: packets whose firmware
     * direction-of-arrival falls outside centerDeg ± halfWidthDeg (device
     * frame, 0 = straight ahead, positive right) are dropped before any
     * consumer sees them. Safe to update mid-run.
     */
    fun setBeamFilter(enabled: Boolean, centerDeg: Int, halfWidthDeg: Int) {
        session.setBeamFilter(enabled, centerDeg, halfWidthDeg)
    }

    fun start(requestedMode: String?) {
        session.start(requestedMode, 0)
    }

    fun start(requestedMode: String?, captureId: Int) {
        session.start(requestedMode, captureId)
    }

    /**
     * Whether mic audio is actually flowing. {@link #start} only records
     * intent: the enable lives in the glasses' EvenHub session, so a transport
     * drop or a session suspend can leave this controller started with a
     * worker that will never see another packet. Anything deciding whether to
     * (re)start capture must ask this rather than assume its own bookkeeping.
     */
    fun isCapturing(): Boolean = session.isCapturing()

    fun stop() {
        session.stop()
    }

    fun close() {
        stop()
    }

    /** Save the session's decoded mic PCM as a 16 kHz mono 16-bit WAV. */
    private fun saveRecording(pcmBytes: ByteArray, sampleRate: Int) {
        try {
            val dir = File(appContext.getExternalFilesDir(null), "voice-recordings")
            if (!dir.exists() && !dir.mkdirs()) {
                Log.w(TAG, "could not create voice-recordings dir")
                return
            }
            val stamp = java.text.SimpleDateFormat("yyyyMMdd-HHmmss-SSS", java.util.Locale.US)
                .format(java.util.Date())
            val file = File(dir, "voice-$stamp.wav")
            java.io.FileOutputStream(file).use { fos ->
                fos.write(BinaryEncoding.wavHeader(pcmBytes.size, sampleRate, 1))
                fos.write(pcmBytes)
            }
            Log.i(TAG, "saved voice recording " + file.absolutePath
                + " samples=" + (pcmBytes.size / 2)
                + " sec=" + String.format(java.util.Locale.US, "%.2f", pcmBytes.size / 2.0 / sampleRate))
        } catch (t: Throwable) {
            Log.w(TAG, "failed to save voice recording", t)
        }
    }

    /**
     * The on-device model directory for the given kind, populated by the
     * download flow in asr-model.ts (releases before 0.5.0 copied the
     * Moonshine files out of the APK directly, so upgraded installs are
     * already complete for that model). Null when any expected file is
     * missing, i.e. the model still needs to be downloaded.
     */
    private fun findAsrModelDir(kind: VoiceModelKind): File? {
        val whisper = kind == VoiceModelKind.WHISPER
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
}
