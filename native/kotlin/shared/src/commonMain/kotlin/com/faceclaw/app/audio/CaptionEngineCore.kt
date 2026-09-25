package com.faceclaw.app

import kotlin.concurrent.Volatile
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/** Receives segmenter events synchronously on the thread feeding [CaptionSegmenter.processChunk]. */
interface CaptionSegmentSink {
    fun onSpeechStart(startMs: Long)

    /** [samples] is the segmenter's own buffer, valid only for the duration of the call. */
    fun onUtterance(samples: ShortArray, length: Int, startMs: Long, endMs: Long, peakRms: Double)
}

/**
 * Splits decoded mic PCM into utterances with an adaptive energy gate: the noise floor is a
 * rolling mean tracked while idle, onset fires at ONSET_FACTOR above it (keeping PRE_ROLL_MS of
 * idle audio so leading consonants survive), and the utterance ends after [silenceMs] below
 * RELEASE_FACTOR or at MAX_UTTERANCE_MS. Boundaries are measured on the 16 kHz sample clock,
 * not the wall clock: BLE delivers mic packets in bursts.
 */
class CaptionSegmenter(private val sink: CaptionSegmentSink) {
    companion object {
        const val SAMPLE_RATE = 16000
        const val ONSET_FACTOR = 3.0
        const val RELEASE_FACTOR = 1.8
        const val MIN_RMS = 220.0
        const val NOISE_EMA_ALPHA = 0.05
        const val PRE_ROLL_MS = 400
        const val DEFAULT_SILENCE_MS = 800
        const val MIN_SILENCE_MS = 200
        const val MAX_SILENCE_MS = 3000
        const val MIN_UTTERANCE_MS = 350
        const val MAX_UTTERANCE_MS = 15000
    }

    @Volatile
    var silenceMs = DEFAULT_SILENCE_MS
        set(value) {
            field = max(MIN_SILENCE_MS, min(MAX_SILENCE_MS, value))
        }

    private var totalSamples: Long = 0
    private var noiseFloor = 0.0
    private var inUtterance = false
    private var utteranceStartSample: Long = 0
    private var silenceRunSamples: Long = 0
    private var utterancePeakRms = 0.0
    private val utterance = ShortArray(SAMPLE_RATE * (MAX_UTTERANCE_MS / 1000))
    private var utteranceLength = 0
    private val preRoll = ShortArray(SAMPLE_RATE * PRE_ROLL_MS / 1000)
    private var preRollLength = 0

    val isInUtterance: Boolean
        get() = inUtterance

    fun reset() {
        totalSamples = 0
        noiseFloor = 0.0
        inUtterance = false
        utteranceLength = 0
        preRollLength = 0
        silenceRunSamples = 0
        utterancePeakRms = 0.0
    }

    /** Feeds one chunk of S16LE PCM bytes (any chunking). */
    fun processChunk(chunk: ByteArray) {
        val count = chunk.size / 2
        val pcm = ShortArray(count)
        for (i in 0 until count) {
            pcm[i] = AudioSegmentation.pcm16le(chunk[i * 2], chunk[i * 2 + 1])
        }
        processChunk(pcm, count)
    }

    fun processChunk(pcm: ShortArray, count: Int) {
        var sumSquares = 0.0
        for (i in 0 until count) {
            val s = pcm[i].toDouble()
            sumSquares += s * s
        }
        val rms = sqrt(sumSquares / max(1, count))
        totalSamples += count.toLong()

        if (!inUtterance) {
            // Track the noise floor only while idle so speech doesn't raise it.
            noiseFloor = if (noiseFloor == 0.0) rms else noiseFloor * (1 - NOISE_EMA_ALPHA) + rms * NOISE_EMA_ALPHA
            val threshold = max(noiseFloor, MIN_RMS)
            if (rms >= threshold * ONSET_FACTOR) {
                inUtterance = true
                utteranceLength = 0
                silenceRunSamples = 0
                utterancePeakRms = rms
                appendUtterance(preRoll, preRollLength)
                utteranceStartSample = max(0L, totalSamples - count - preRollLength)
                appendUtterance(pcm, count)
                sink.onSpeechStart(utteranceStartSample * 1000 / SAMPLE_RATE)
            } else {
                appendPreRoll(pcm, count)
            }
            return
        }

        appendUtterance(pcm, count)
        utterancePeakRms = max(utterancePeakRms, rms)
        val threshold = max(noiseFloor, MIN_RMS)
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

    /** Emits a trailing utterance (if any) so its text isn't lost on stop. */
    fun flush() {
        if (inUtterance && utteranceLength > 0) {
            finalizeUtterance()
        }
        inUtterance = false
        preRollLength = 0
    }

    private fun appendPreRoll(pcm: ShortArray, count: Int) {
        // Keep the last PRE_ROLL_MS of idle audio so onset consonants survive.
        if (count >= preRoll.size) {
            pcm.copyInto(preRoll, 0, count - preRoll.size, count)
            preRollLength = preRoll.size
            return
        }
        val keep = min(preRollLength, preRoll.size - count)
        preRoll.copyInto(preRoll, 0, preRollLength - keep, preRollLength)
        pcm.copyInto(preRoll, keep, 0, count)
        preRollLength = keep + count
    }

    private fun appendUtterance(pcm: ShortArray, count: Int) {
        val room = utterance.size - utteranceLength
        val copied = min(room, count)
        if (copied > 0) {
            pcm.copyInto(utterance, utteranceLength, 0, copied)
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
        sink.onUtterance(utterance, length, startMs, endMs, utterancePeakRms)
    }
}

/**
 * Transcribes one utterance in model-safe segments cut at the quietest window (Moonshine v2
 * fails past ~9.1 s of input) and attaches a voice-print from at most its first 10 s.
 */
class UtteranceDecoder(private val transcriber: OfflineTranscriber?, private val embedder: SpeakerEmbedder?) {
    companion object {
        const val SAMPLE_RATE = 16000
        const val DECODE_SEGMENT_MAX_SAMPLES = SAMPLE_RATE * 8
        const val CUT_SEARCH_SAMPLES = SAMPLE_RATE * 2
        const val CUT_WINDOW_SAMPLES = SAMPLE_RATE * 30 / 1000
        const val NORMALIZE_TARGET_PEAK = 0.9f
        const val NORMALIZE_MAX_GAIN = 30f
        // Voice-prints degrade on very long inputs; embed at most the first 10 s.
        const val EMBED_MAX_SAMPLES = SAMPLE_RATE * 10
    }

    val hasTranscriber: Boolean
        get() = transcriber != null

    fun recognize(utterance: ShortArray, length: Int): String {
        val recognizer = transcriber
        if (recognizer == null || length <= 0) {
            return ""
        }
        val joined = StringBuilder()
        var offset = 0
        while (offset < length) {
            val remaining = length - offset
            var segment = min(remaining, DECODE_SEGMENT_MAX_SAMPLES)
            if (remaining > DECODE_SEGMENT_MAX_SAMPLES) {
                segment = AudioSegmentation.quietestCutPoint(utterance, offset, segment, CUT_SEARCH_SAMPLES, CUT_WINDOW_SAMPLES)
            }
            val samples = AudioSegmentation.pcm16ToFloat(utterance, offset, segment)
            AudioSegmentation.normalizePeak(samples, NORMALIZE_TARGET_PEAK, NORMALIZE_MAX_GAIN)
            val part = recognizer.recognize(samples, samples.size).trim()
            if (part.isNotEmpty()) {
                if (joined.isNotEmpty() && ".,!?;:%)]}".indexOf(part[0]) < 0) {
                    joined.append(' ')
                }
                joined.append(part)
            }
            offset += segment
        }
        return joined.toString().trim()
    }

    fun embed(utterance: ShortArray, length: Int): FloatArray? {
        val currentEmbedder = embedder
        if (currentEmbedder == null || length <= 0) {
            return null
        }
        val count = min(length, EMBED_MAX_SAMPLES)
        return currentEmbedder.embed(AudioSegmentation.pcm16ToLittleEndian(utterance, 0, count), SAMPLE_RATE)
    }

    fun release() {
        transcriber?.release()
        embedder?.release()
    }
}

/** Platform services for [CaptionSession]. */
interface CaptionHost {
    val dispatcher: CallbackDispatcher

    /** Loads the caption recognizer from [modelDir], or null when the model files are absent. */
    fun loadTranscriber(modelDir: String): OfflineTranscriber?

    /** Loads the speaker-embedding model, or null when the file is absent. */
    fun loadEmbedder(modelPath: String): SpeakerEmbedder?
}

/**
 * Continuous captioning over pushed mic PCM: queue, worker thread (owned here, via the shared
 * [startThread]), model lifecycle, segmentation and per-utterance decode/embedding, with
 * listener callbacks marshalled through the host dispatcher.
 */
class CaptionSession(
    private val host: CaptionHost,
    private val platform: ProtocolPlatform = protocolPlatform(),
    private val threadName: String = "FaceclawCaptionEngine",
    private val logError: (String, Throwable) -> Unit = { message, error -> PlatformLog.e(TAG, message, error) },
) : CaptionSegmentSink {
    companion object {
        const val TAG = "FaceclawCaptions"
        const val MAX_QUEUE_PACKETS = 200
    }

    private val lock = platform.createLock()
    private val queue = DroppingPacketQueue<ByteArray>(MAX_QUEUE_PACKETS, platform)
    private val segmenter = CaptionSegmenter(this)
    @Volatile
    private var listener: FaceclawCaptionEngineListener? = null
    @Volatile
    private var asrModelDir: String? = null
    @Volatile
    private var speakerModelPath: String? = null
    @Volatile
    private var started = false
    private var workerFinished: Latch? = null
    @Volatile
    private var workerThreadName: String? = null
    private var decoder: UtteranceDecoder? = null

    fun setListener(listener: FaceclawCaptionEngineListener?) {
        this.listener = listener
    }

    fun setAsrModelDir(dir: String?) {
        this.asrModelDir = dir
    }

    fun setSpeakerModelPath(path: String?) {
        this.speakerModelPath = path
    }

    fun setSilenceMs(ms: Int) {
        segmenter.silenceMs = ms
    }

    fun start() {
        lock.withLock {
            if (started) {
                return
            }
            started = true
            val finished = Latch(1, platform)
            workerFinished = finished
            startThread(threadName, true) { runLoop(finished) }
        }
    }

    /** Stops and waits up to 2 s for the worker unless called from it. */
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
        queue.wake()
        if (finished != null && (workerName == null || currentThreadName() != workerName)) {
            finished.await(2000)
        }
    }

    /** Push decoded 16 kHz mono S16LE PCM (any chunking). */
    fun acceptPcm(pcm16le: ByteArray?) {
        if (!started || pcm16le == null || pcm16le.size < 2) {
            return
        }
        queue.put(pcm16le)
    }

    private fun runLoop(finished: Latch) {
        workerThreadName = currentThreadName()
        try {
            loadModels()
            segmenter.reset()
            while (started) {
                val chunk = queue.take(250) { started } ?: continue
                segmenter.processChunk(chunk)
            }
            // Flush a trailing utterance so its text isn't lost on stop.
            segmenter.flush()
        } catch (t: Throwable) {
            logError("caption engine failed", t)
            emitStatus("Captions failed: " + t.message)
        } finally {
            decoder?.release()
            decoder = null
            lock.withLock {
                workerFinished = null
                workerThreadName = null
            }
            finished.countDown()
        }
    }

    private fun loadModels() {
        val modelDir = asrModelDir
        val transcriber = if (modelDir != null) {
            emitStatus("Loading caption model...")
            host.loadTranscriber(modelDir)
        } else {
            null
        }
        val embedModel = speakerModelPath
        val embedder = if (embedModel != null) host.loadEmbedder(embedModel) else null
        decoder = UtteranceDecoder(transcriber, embedder)
        emitStatus(if (transcriber != null) "Captions listening..." else "Captions listening (no ASR model)...")
    }

    override fun onSpeechStart(startMs: Long) {
        val currentListener = listener ?: return
        host.dispatcher.post { currentListener.onSpeechStart(startMs) }
    }

    override fun onUtterance(samples: ShortArray, length: Int, startMs: Long, endMs: Long, peakRms: Double) {
        val currentDecoder = decoder ?: return
        val text = currentDecoder.recognize(samples, length)
        val embedding = currentDecoder.embed(samples, length)
        val currentListener = listener ?: return
        val embeddingCopy = embedding?.copyOf()
        host.dispatcher.post { currentListener.onUtterance(text, embeddingCopy, startMs, endMs, peakRms) }
    }

    private fun emitStatus(status: String?) {
        val currentListener = listener ?: return
        host.dispatcher.post { currentListener.onStatus(status) }
    }
}
