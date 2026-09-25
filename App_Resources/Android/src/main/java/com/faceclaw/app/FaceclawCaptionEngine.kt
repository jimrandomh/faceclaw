package com.faceclaw.app

import android.os.Handler
import android.os.Looper

import java.io.File

/**
 * Continuous captioning over the decoded mic PCM: the shared [CaptionSession] segments speech
 * into utterances with an adaptive energy gate, transcribes each with the on-device Moonshine
 * model and attaches a speaker voice-print. This Android class only supplies the sherpa-onnx
 * recognizer and speaker model and delivers callbacks on the main thread. PCM is pushed in
 * from the TS side (which owns mic arbitration and any beam-direction gating), so the engine
 * has no BLE dependencies.
 *
 * Utterance boundaries are measured on the sample clock, not the wall clock; the TS side
 * converts startMs/endMs to wall-clock times using the engine start timestamp.
 */
class FaceclawCaptionEngine {
    private val mainHandler = Handler(Looper.getMainLooper())

    private val host = object : CaptionHost {
        override val dispatcher = CallbackDispatcher { action -> mainHandler.post { action() } }

        override fun loadTranscriber(modelDir: String): OfflineTranscriber? {
            if (!File(modelDir, "tokens.txt").exists()) {
                return null
            }
            return AndroidSpeechEngines.SherpaTranscriber(
                AndroidSpeechEngines.recognizerConfig(File(modelDir), VoiceModelKind.MOONSHINE))
        }

        override fun loadEmbedder(modelPath: String): SpeakerEmbedder? {
            if (!File(modelPath).exists()) {
                return null
            }
            val speakerId = FaceclawSpeakerId(modelPath)
            speakerId.ensureLoaded()
            return speakerId
        }
    }

    private val session = CaptionSession(host)

    fun setListener(listener: FaceclawCaptionEngineListener?) {
        session.setListener(listener)
    }

    /** Directory holding the Moonshine model files, or null to disable ASR. */
    fun setAsrModelDir(dir: String?) {
        session.setAsrModelDir(dir)
    }

    /** Speaker-embedding ONNX model path, or null to disable voice-prints. */
    fun setSpeakerModelPath(path: String?) {
        session.setSpeakerModelPath(path)
    }

    fun setSilenceMs(ms: Int) {
        session.setSilenceMs(ms)
    }

    fun start() {
        session.start()
    }

    fun stop() {
        session.stop()
    }

    /** Push decoded 16 kHz mono S16LE PCM (any chunking). */
    fun acceptPcm(pcm16le: ByteArray?) {
        session.acceptPcm(pcm16le)
    }
}
