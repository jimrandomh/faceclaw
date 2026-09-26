package com.faceclaw.app

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

/**
 * Android implementations of the shared voice ports: the sherpa-onnx offline recognizer as an
 * [OfflineTranscriber], the phone microphone as a [PcmAudioSource], and the JNI LC3 decoder as
 * an [AudioPacketDecoder]. The pipelines themselves live in the shared VoiceCaptureSession and
 * CaptionSession.
 */
internal object AndroidSpeechEngines {
    private const val TAG = "FaceclawVoice"
    private const val SAMPLE_RATE = 16000
    private const val FEATURE_DIM = 80

    /** Sherpa-onnx configuration for the on-device model files in [modelDir]. */
    fun recognizerConfig(modelDir: File, kind: VoiceModelKind): OfflineRecognizerConfig {
        val modelConfig = OfflineModelConfig.builder()
            .setNumThreads(1)
        if (kind == VoiceModelKind.WHISPER) {
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

    class SherpaTranscriber(config: OfflineRecognizerConfig) : OfflineTranscriber {
        private var recognizer: OfflineRecognizer? = OfflineRecognizer(config)

        override fun recognize(samples: FloatArray, count: Int): String {
            val currentRecognizer = recognizer ?: return ""
            val segment = if (count == samples.size) samples else samples.copyOf(count)
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

        override fun release() {
            recognizer?.release()
            recognizer = null
        }
    }

    /** The JNI LC3 decoder behind the shared packet-decoder port. */
    class Lc3DecoderAdapter : AudioPacketDecoder {
        private val decoder = FaceclawLc3Decoder()

        override fun decodePacket(packet: ByteArray?, pcmOut: ShortArray?): Int = decoder.decodePacket(packet, pcmOut)

        override val lastAngleDegrees: Int get() = decoder.getLastAngleDegrees()
        override val lastSsr: Int get() = decoder.getLastSsr()
        override val realPackets: Long get() = decoder.getRealPackets()
        override val duplicatePackets: Long get() = decoder.getDuplicatePackets()
        override val missingPackets: Long get() = decoder.getMissingPackets()
        override val decodeErrors: Long get() = decoder.getDecodeErrors()

        override fun close() = decoder.close()
    }

    /**
     * Open the phone's own microphone at the pipeline's native format (16 kHz
     * mono PCM16), or null when it cannot start — the permission is missing
     * (SecurityException) or the device refuses the configuration.
     */
    fun openPhoneMic(chunkSamples: Int): PcmAudioSource? {
        var record: android.media.AudioRecord? = null
        try {
            val minBytes = android.media.AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                android.media.AudioFormat.CHANNEL_IN_MONO,
                android.media.AudioFormat.ENCODING_PCM_16BIT)
            val bufferBytes = Math.max(minBytes, chunkSamples * 2 * 4)
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
            return AudioRecordSource(record)
        } catch (t: Throwable) {
            Log.w(TAG, "phone mic open failed", t)
            if (record != null) {
                record.release()
            }
            return null
        }
    }

    private class AudioRecordSource(private val record: android.media.AudioRecord) : PcmAudioSource {
        override fun read(pcm: ShortArray): Int = record.read(pcm, 0, pcm.size)

        override fun close() {
            try {
                record.stop()
            } catch (ignored: Throwable) {
                // Already stopped or never recording; release below either way.
            }
            record.release()
        }
    }
}
