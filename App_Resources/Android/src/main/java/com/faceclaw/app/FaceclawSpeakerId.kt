package com.faceclaw.app

import android.util.Log

import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractor
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig

/**
 * Speaker voice-print extraction over sherpa-onnx. One embedding per
 * utterance; matching/enrollment happens on the TS side (cosine similarity
 * against the stored speaker profiles).
 */
class FaceclawSpeakerId(private val modelPath: String?) {
    companion object {
        private const val TAG = "FaceclawSpeakerId"

        @JvmStatic
        private fun l2Normalize(v: FloatArray?): FloatArray? {
            if (v == null) {
                return null
            }
            var sum = 0.0
            for (x in v) {
                sum += x.toDouble() * x
            }
            val norm = Math.sqrt(sum)
            if (norm <= 0) {
                return v
            }
            for (i in v.indices) {
                v[i] = (v[i] / norm).toFloat()
            }
            return v
        }
    }

    private var extractor: SpeakerEmbeddingExtractor? = null

    /** Lazily loads the model; returns false when it cannot be loaded. */
    @Synchronized
    fun ensureLoaded(): Boolean {
        if (extractor != null) {
            return true
        }
        try {
            val config = SpeakerEmbeddingExtractorConfig.builder()
                .setModel(modelPath)
                .setNumThreads(1)
                .setDebug(false)
                .setProvider("cpu")
                .build()
            extractor = SpeakerEmbeddingExtractor(config)
            return true
        } catch (t: Throwable) {
            Log.w(TAG, "could not load speaker model at $modelPath", t)
            extractor = null
            return false
        }
    }

    @Synchronized
    fun embeddingDim(): Int {
        val extractor = this.extractor
        return if (extractor == null) 0 else extractor.dim
    }

    /**
     * Compute an L2-normalized voice-print for one utterance of 16 kHz mono
     * S16LE PCM. Returns null when the model is unavailable or the utterance
     * is too short to embed (under ~0.5 s).
     */
    @Synchronized
    fun embed(pcm16le: ByteArray?, sampleRate: Int): FloatArray? {
        if (pcm16le == null || pcm16le.size < sampleRate) {
            return null
        }
        if (!ensureLoaded()) {
            return null
        }
        val extractor = this.extractor!!
        val count = pcm16le.size / 2
        val samples = FloatArray(count)
        for (i in 0 until count) {
            val s = ((pcm16le[i * 2].toInt() and 0xff) or (pcm16le[i * 2 + 1].toInt() shl 8)).toShort()
            samples[i] = s / 32768.0f
        }
        var stream: OnlineStream? = null
        try {
            stream = extractor.createStream()
            stream.acceptWaveform(samples, sampleRate)
            stream.inputFinished()
            if (!extractor.isReady(stream)) {
                return null
            }
            val embedding = extractor.compute(stream)
            return l2Normalize(embedding)
        } catch (t: Throwable) {
            Log.w(TAG, "embedding failed", t)
            return null
        } finally {
            if (stream != null) {
                stream.release()
            }
        }
    }

    @Synchronized
    fun close() {
        val extractor = this.extractor
        if (extractor != null) {
            extractor.release()
            this.extractor = null
        }
    }
}
