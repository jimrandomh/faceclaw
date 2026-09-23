package com.faceclaw.app

import android.os.Handler
import android.os.Looper
import android.util.Log

import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineMoonshineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizerResult
import com.k2fsa.sherpa.onnx.OfflineStream

import java.io.File
import java.util.ArrayDeque
import java.util.Arrays

/**
 * Continuous captioning over the decoded mic PCM: segments speech into
 * utterances with an adaptive energy gate, transcribes each utterance with
 * the on-device Moonshine model, and attaches a speaker voice-print per
 * utterance. PCM is pushed in from the TS side (which owns mic arbitration
 * and any beam-direction gating), so this engine has no BLE dependencies.
 *
 * Utterance boundaries are measured on the sample clock, not the wall clock:
 * BLE delivers mic packets in bursts, so elapsed real time overestimates the
 * audio heard. The TS side converts startMs/endMs to wall-clock times using
 * the engine start timestamp.
 */
class FaceclawCaptionEngine {
    companion object {
        private const val TAG = "FaceclawCaptions"
        private const val SAMPLE_RATE = 16000
        private const val FEATURE_DIM = 80
        private const val MAX_QUEUE_PACKETS = 200

        // Segmentation: RMS thresholds relative to a rolling noise floor, in the
        // same spirit as FaceclawVoiceController.EndpointDetector but recurring.
        private const val ONSET_FACTOR = 3.0
        private const val RELEASE_FACTOR = 1.8
        private const val MIN_RMS = 220.0
        private const val NOISE_EMA_ALPHA = 0.05
        private const val PRE_ROLL_MS = 400
        private const val DEFAULT_SILENCE_MS = 800
        private const val MIN_UTTERANCE_MS = 350
        private const val MAX_UTTERANCE_MS = 15000
        // Moonshine v2 fails past ~9.1 s of input; decode long utterances in
        // segments cut at the quietest window (mirrors FaceclawVoiceController).
        private const val DECODE_SEGMENT_MAX_SAMPLES = SAMPLE_RATE * 8
        private const val CUT_SEARCH_SAMPLES = SAMPLE_RATE * 2
        private const val CUT_WINDOW_SAMPLES = SAMPLE_RATE * 30 / 1000
        private const val NORMALIZE_TARGET_PEAK = 0.9f
        private const val NORMALIZE_MAX_GAIN = 30f
        // Voice-prints degrade on very long inputs; embed at most the first 10 s.
        private const val EMBED_MAX_SAMPLES = SAMPLE_RATE * 10
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val lock = Any()
    private val queueLock = Any()
    private val queue = ArrayDeque<ByteArray>()

    @Volatile
    private var listener: FaceclawCaptionEngineListener? = null
    @Volatile
    private var asrModelDir: String? = null
    @Volatile
    private var speakerModelPath: String? = null
    @Volatile
    private var silenceMs = DEFAULT_SILENCE_MS
    private var workerThread: Thread? = null
    @Volatile
    private var started = false

    private var recognizer: OfflineRecognizer? = null
    private var speakerId: FaceclawSpeakerId? = null

    // Segmentation state (worker thread only).
    private var totalSamples: Long = 0
    private var noiseFloor = 0.0
    private var inUtterance = false
    private var utteranceStartSample: Long = 0
    private var silenceRunSamples: Long = 0
    private var utterancePeakRms = 0.0
    private var utterance = ShortArray(SAMPLE_RATE * (MAX_UTTERANCE_MS / 1000))
    private var utteranceLength = 0
    private val preRoll = ShortArray(SAMPLE_RATE * PRE_ROLL_MS / 1000)
    private var preRollLength = 0

    fun setListener(listener: FaceclawCaptionEngineListener?) {
        this.listener = listener
    }

    /** Directory holding the Moonshine model files, or null to disable ASR. */
    fun setAsrModelDir(dir: String?) {
        this.asrModelDir = dir
    }

    /** Speaker-embedding ONNX model path, or null to disable voice-prints. */
    fun setSpeakerModelPath(path: String?) {
        this.speakerModelPath = path
    }

    fun setSilenceMs(ms: Int) {
        this.silenceMs = Math.max(200, Math.min(3000, ms))
    }

    fun start() {
        synchronized(lock) {
            if (started) {
                return
            }
            started = true
            workerThread = Thread(Runnable { runLoop() }, "FaceclawCaptionEngine")
            workerThread!!.start()
        }
    }

    fun stop() {
        val threadToJoin: Thread?
        synchronized(lock) {
            if (!started) {
                return
            }
            started = false
            threadToJoin = workerThread
            workerThread = null
        }
        synchronized(queueLock) {
            (queueLock as java.lang.Object).notifyAll()
        }
        if (threadToJoin != null) {
            threadToJoin.interrupt()
            if (Thread.currentThread() !== threadToJoin) {
                try {
                    threadToJoin.join(2000)
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                }
            }
        }
    }

    /** Push decoded 16 kHz mono S16LE PCM (any chunking). */
    fun acceptPcm(pcm16le: ByteArray?) {
        if (!started || pcm16le == null || pcm16le.size < 2) {
            return
        }
        synchronized(queueLock) {
            if (queue.size >= MAX_QUEUE_PACKETS) {
                queue.removeFirst()
            }
            queue.addLast(pcm16le)
            (queueLock as java.lang.Object).notifyAll()
        }
    }

    private fun runLoop() {
        try {
            loadModels()
            resetSegmentation()
            while (started && !Thread.currentThread().isInterrupted) {
                val chunk = takeChunk()
                if (chunk == null) {
                    continue
                }
                processChunk(chunk)
            }
            // Flush a trailing utterance so its text isn't lost on stop.
            if (inUtterance && utteranceLength > 0) {
                finalizeUtterance()
            }
        } catch (t: Throwable) {
            Log.e(TAG, "caption engine failed", t)
            emitStatus("Captions failed: " + t.message)
        } finally {
            releaseModels()
        }
    }

    private fun loadModels() {
        val modelDir = asrModelDir
        if (modelDir != null && File(modelDir, "tokens.txt").exists()) {
            emitStatus("Loading caption model...")
            recognizer = OfflineRecognizer(OfflineRecognizerConfig.builder()
                .setFeatureConfig(FeatureConfig.builder()
                    .setSampleRate(SAMPLE_RATE)
                    .setFeatureDim(FEATURE_DIM)
                    .build())
                .setModelConfig(OfflineModelConfig.builder()
                    .setMoonshine(OfflineMoonshineModelConfig.builder()
                        .setEncoder(File(modelDir, "encoder_model.ort").absolutePath)
                        .setMergedDecoder(File(modelDir, "decoder_model_merged.ort").absolutePath)
                        .build())
                    .setTokens(File(modelDir, "tokens.txt").absolutePath)
                    .setNumThreads(1)
                    .build())
                .build())
        } else {
            recognizer = null
        }
        val embedModel = speakerModelPath
        if (embedModel != null && File(embedModel).exists()) {
            speakerId = FaceclawSpeakerId(embedModel)
            speakerId!!.ensureLoaded()
        } else {
            speakerId = null
        }
        emitStatus(if (recognizer != null) "Captions listening..." else "Captions listening (no ASR model)...")
    }

    private fun releaseModels() {
        if (recognizer != null) {
            recognizer!!.release()
            recognizer = null
        }
        if (speakerId != null) {
            speakerId!!.close()
            speakerId = null
        }
    }

    private fun takeChunk(): ByteArray? {
        synchronized(queueLock) {
            while (started && queue.isEmpty()) {
                try {
                    (queueLock as java.lang.Object).wait(250)
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return null
                }
            }
            return queue.pollFirst()
        }
    }

    private fun resetSegmentation() {
        totalSamples = 0
        noiseFloor = 0.0
        inUtterance = false
        utteranceLength = 0
        preRollLength = 0
        silenceRunSamples = 0
        utterancePeakRms = 0.0
    }

    private fun processChunk(chunk: ByteArray) {
        val count = chunk.size / 2
        val pcm = ShortArray(count)
        var sumSquares = 0.0
        for (i in 0 until count) {
            val s = ((chunk[i * 2].toInt() and 0xff) or (chunk[i * 2 + 1].toInt() shl 8)).toShort()
            pcm[i] = s
            sumSquares += s.toDouble() * s
        }
        val rms = Math.sqrt(sumSquares / Math.max(1, count))
        totalSamples += count.toLong()

        if (!inUtterance) {
            // Track the noise floor only while idle so speech doesn't raise it.
            noiseFloor = if (noiseFloor == 0.0) rms else noiseFloor * (1 - NOISE_EMA_ALPHA) + rms * NOISE_EMA_ALPHA
            val threshold = Math.max(noiseFloor, MIN_RMS)
            if (rms >= threshold * ONSET_FACTOR) {
                inUtterance = true
                utteranceLength = 0
                silenceRunSamples = 0
                utterancePeakRms = rms
                appendUtterance(preRoll, preRollLength)
                utteranceStartSample = Math.max(0L, totalSamples - count - preRollLength)
                appendUtterance(pcm, count)
                emitSpeechStart(utteranceStartSample * 1000 / SAMPLE_RATE)
            } else {
                appendPreRoll(pcm, count)
            }
            return
        }

        appendUtterance(pcm, count)
        utterancePeakRms = Math.max(utterancePeakRms, rms)
        val threshold = Math.max(noiseFloor, MIN_RMS)
        if (rms < threshold * RELEASE_FACTOR) {
            silenceRunSamples += count.toLong()
        } else {
            silenceRunSamples = 0
        }
        val utteranceMs = utteranceLength.toLong() * 1000 / SAMPLE_RATE
        val silenceEnded = silenceRunSamples * 1000L / SAMPLE_RATE >= silenceMs
        if (silenceEnded || utteranceMs >= MAX_UTTERANCE_MS) {
            finalizeUtterance()
            inUtterance = false
            preRollLength = 0
        }
    }

    private fun appendPreRoll(pcm: ShortArray, count: Int) {
        // Keep the last PRE_ROLL_MS of idle audio so onset consonants survive.
        if (count >= preRoll.size) {
            System.arraycopy(pcm, count - preRoll.size, preRoll, 0, preRoll.size)
            preRollLength = preRoll.size
            return
        }
        val keep = Math.min(preRollLength, preRoll.size - count)
        System.arraycopy(preRoll, preRollLength - keep, preRoll, 0, keep)
        System.arraycopy(pcm, 0, preRoll, keep, count)
        preRollLength = keep + count
    }

    private fun appendUtterance(pcm: ShortArray, count: Int) {
        val room = utterance.size - utteranceLength
        val copied = Math.min(room, count)
        if (copied > 0) {
            System.arraycopy(pcm, 0, utterance, utteranceLength, copied)
            utteranceLength += copied
        }
    }

    private fun finalizeUtterance() {
        val length = utteranceLength
        val startMs = utteranceStartSample * 1000 / SAMPLE_RATE
        val endMs = (utteranceStartSample + length) * 1000 / SAMPLE_RATE
        if (endMs - startMs < MIN_UTTERANCE_MS) {
            return
        }
        val text = recognizeUtterance(length)
        val embedding = embedUtterance(length)
        emitUtterance(text, embedding, startMs, endMs, utterancePeakRms)
    }

    private fun recognizeUtterance(length: Int): String {
        if (recognizer == null || length <= 0) {
            return ""
        }
        val joined = StringBuilder()
        var offset = 0
        while (offset < length) {
            val remaining = length - offset
            var segment = Math.min(remaining, DECODE_SEGMENT_MAX_SAMPLES)
            if (remaining > DECODE_SEGMENT_MAX_SAMPLES) {
                segment = findQuietCut(offset, segment)
            }
            val part = recognizeRange(offset, segment)
            if (part.length > 0) {
                if (joined.length > 0 && ".,!?;:%)]}".indexOf(part[0]) < 0) {
                    joined.append(' ')
                }
                joined.append(part)
            }
            offset += segment
        }
        return joined.toString().trim()
    }

    /**
     * End a decode segment at the center of the quietest window near its end
     * so the cut lands between words (same approach as the PTT controller).
     */
    private fun findQuietCut(offset: Int, segment: Int): Int {
        val searchStart = Math.max(0, segment - CUT_SEARCH_SAMPLES)
        val win = CUT_WINDOW_SAMPLES
        if (segment - searchStart <= win) {
            return segment
        }
        var sum = 0.0
        for (i in searchStart until searchStart + win) {
            val s = utterance[offset + i].toDouble()
            sum += s * s
        }
        var best = sum
        var bestStart = searchStart
        var start = searchStart + 1
        while (start + win <= segment) {
            val dropped = utterance[offset + start - 1].toDouble()
            val added = utterance[offset + start + win - 1].toDouble()
            sum += added * added - dropped * dropped
            if (sum < best) {
                best = sum
                bestStart = start
            }
            start++
        }
        return bestStart + win / 2
    }

    private fun recognizeRange(offset: Int, count: Int): String {
        val samples = FloatArray(count)
        var peak = 0f
        for (i in 0 until count) {
            val v = utterance[offset + i] / 32768.0f
            samples[i] = v
            val a = Math.abs(v)
            if (a > peak) {
                peak = a
            }
        }
        if (peak > 0f) {
            val gain = Math.min(NORMALIZE_TARGET_PEAK / peak, NORMALIZE_MAX_GAIN)
            if (gain > 1f) {
                for (i in 0 until count) {
                    samples[i] *= gain
                }
            }
        }
        val recognizer = this.recognizer!!
        val stream: OfflineStream = recognizer.createStream()
        try {
            stream.acceptWaveform(samples, SAMPLE_RATE)
            recognizer.decode(stream)
            val result: OfflineRecognizerResult? = recognizer.getResult(stream)
            val raw: String? = if (result == null) "" else result.text
            return raw?.trim() ?: ""
        } finally {
            stream.release()
        }
    }

    private fun embedUtterance(length: Int): FloatArray? {
        val currentSpeakerId = speakerId
        if (currentSpeakerId == null || length <= 0) {
            return null
        }
        val count = Math.min(length, EMBED_MAX_SAMPLES)
        val le = ByteArray(count * 2)
        for (i in 0 until count) {
            val s = utterance[i].toInt()
            le[i * 2] = (s and 0xff).toByte()
            le[i * 2 + 1] = ((s shr 8) and 0xff).toByte()
        }
        return currentSpeakerId.embed(le, SAMPLE_RATE)
    }

    private fun emitUtterance(text: String?, embedding: FloatArray?, startMs: Long, endMs: Long, peakRms: Double) {
        val currentListener = listener
        if (currentListener == null) {
            return
        }
        val embeddingCopy = if (embedding == null) null else Arrays.copyOf(embedding, embedding.size)
        mainHandler.post { currentListener.onUtterance(text, embeddingCopy, startMs, endMs, peakRms) }
    }

    private fun emitSpeechStart(startMs: Long) {
        val currentListener = listener
        if (currentListener == null) {
            return
        }
        mainHandler.post { currentListener.onSpeechStart(startMs) }
    }

    private fun emitStatus(status: String?) {
        val currentListener = listener
        if (currentListener == null) {
            return
        }
        mainHandler.post { currentListener.onStatus(status) }
    }
}
