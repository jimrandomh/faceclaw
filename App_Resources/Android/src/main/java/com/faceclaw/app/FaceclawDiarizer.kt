package com.faceclaw.app

import android.os.Handler
import android.os.Looper
import android.util.Log

import com.k2fsa.sherpa.onnx.FastClusteringConfig
import com.k2fsa.sherpa.onnx.OfflineSpeakerDiarization
import com.k2fsa.sherpa.onnx.OfflineSpeakerDiarizationCallback
import com.k2fsa.sherpa.onnx.OfflineSpeakerDiarizationConfig
import com.k2fsa.sherpa.onnx.OfflineSpeakerDiarizationSegment
import com.k2fsa.sherpa.onnx.OfflineSpeakerSegmentationModelConfig
import com.k2fsa.sherpa.onnx.OfflineSpeakerSegmentationPyannoteModelConfig
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig

import org.json.JSONArray
import org.json.JSONObject

import java.io.DataInputStream
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.nio.ByteBuffer

/**
 * Offline re-diarization of a stored conversation recording (16-bit mono
 * WAV): pyannote segmentation plus the shared speaker-embedding model with
 * clustering, via sherpa-onnx. Runs on its own thread; results are handed to
 * TS as JSON turns for reconciliation against the transcript segments.
 */
class FaceclawDiarizer(
    private val segmentationModelPath: String?,
    private val embeddingModelPath: String?,
    private val wavPath: String?,
    private val numClusters: Int,
    threshold: Float,
    private val listener: Listener
) {
    companion object {
        private const val TAG = "FaceclawDiarizer"

        /**
         * Decode a compressed recording (M4A/AAC from the transcode sweep) into
         * [-1, 1] floats via MediaExtractor + MediaCodec. Recordings are written
         * as 16 kHz mono, so no resampling is needed.
         */
        @JvmStatic
        @Throws(IOException::class)
        private fun decodeCompressedMono(path: String?): FloatArray {
            val extractor = android.media.MediaExtractor()
            var codec: android.media.MediaCodec? = null
            val pcm = java.io.ByteArrayOutputStream()
            try {
                extractor.setDataSource(path!!)
                var trackIndex = -1
                var format: android.media.MediaFormat? = null
                for (i in 0 until extractor.trackCount) {
                    val candidate = extractor.getTrackFormat(i)
                    val mime = candidate.getString(android.media.MediaFormat.KEY_MIME)
                    if (mime != null && mime.startsWith("audio/")) {
                        trackIndex = i
                        format = candidate
                        break
                    }
                }
                if (trackIndex < 0 || format == null) {
                    throw IOException("no audio track in $path")
                }
                extractor.selectTrack(trackIndex)
                codec = android.media.MediaCodec.createDecoderByType(
                    format.getString(android.media.MediaFormat.KEY_MIME)!!)
                codec.configure(format, null, null, 0)
                codec.start()
                val info = android.media.MediaCodec.BufferInfo()
                var inputDone = false
                var outputDone = false
                while (!outputDone) {
                    if (!inputDone) {
                        val inIndex = codec.dequeueInputBuffer(10_000)
                        if (inIndex >= 0) {
                            val inBuf = codec.getInputBuffer(inIndex)!!
                            val size = extractor.readSampleData(inBuf, 0)
                            if (size < 0) {
                                codec.queueInputBuffer(inIndex, 0, 0, 0,
                                    android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                                inputDone = true
                            } else {
                                codec.queueInputBuffer(inIndex, 0, size, extractor.sampleTime, 0)
                                extractor.advance()
                            }
                        }
                    }
                    val outIndex = codec.dequeueOutputBuffer(info, 10_000)
                    if (outIndex >= 0) {
                        val outBuf = codec.getOutputBuffer(outIndex)!!
                        val chunk = ByteArray(info.size)
                        outBuf.position(info.offset)
                        outBuf.get(chunk)
                        pcm.write(chunk)
                        codec.releaseOutputBuffer(outIndex, false)
                        if ((info.flags and android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                            outputDone = true
                        }
                    }
                }
            } finally {
                extractor.release()
                if (codec != null) {
                    try {
                        codec.stop()
                    } catch (ignored: Throwable) {
                    }
                    codec.release()
                }
            }
            val bytes = pcm.toByteArray()
            val count = bytes.size / 2
            val samples = FloatArray(count)
            for (i in 0 until count) {
                samples[i] = ((bytes[i * 2].toInt() and 0xff) or (bytes[i * 2 + 1].toInt() shl 8)).toShort() / 32768.0f
            }
            return samples
        }

        /** Load a 16-bit mono PCM WAV into [-1, 1] floats. */
        @JvmStatic
        @Throws(IOException::class)
        private fun readWavMono16(path: String?): FloatArray {
            val file = File(path)
            val fileLength = file.length()
            DataInputStream(FileInputStream(file)).use { `in` ->
                // Shared RIFF walk (handles extra chunks and unpatched data sizes); the
                // stream is then positioned at the first PCM sample.
                val prefix = ByteArray(Math.min(fileLength, WavPcmReader.HEADER_PREFIX_BYTES.toLong()).toInt())
                `in`.readFully(prefix)
                val info = try {
                    WavPcmReader.parseHeader(prefix, fileLength)
                } catch (e: IllegalArgumentException) {
                    throw IOException(e.message ?: "not a WAV file")
                }
                if (info.channels != 1) {
                    throw IOException("only 16-bit mono WAV is supported")
                }
                val dataBytes = info.dataBytes
                val count = Math.min(dataBytes / 2, Int.MAX_VALUE.toLong()).toInt()
                val samples = FloatArray(count)
                val chunk = ByteArray(65536)
                var sampleIndex = 0
                var carried = 0
                var carriedByte: Byte = 0
                var read = 0
                // The prefix already holds the start of the PCM data; consume it first.
                val prefixData = prefix.size - info.dataOffset.toInt()
                if (prefixData > 0) {
                    val pairs = prefixData / 2
                    var i = 0
                    while (i < pairs && sampleIndex < count) {
                        val base = info.dataOffset.toInt() + i * 2
                        samples[sampleIndex++] = AudioSegmentation.pcm16le(prefix[base], prefix[base + 1]) / 32768.0f
                        i++
                    }
                    if ((prefixData and 1) == 1) {
                        carried = 1
                        carriedByte = prefix[prefix.size - 1]
                    }
                }
                while (sampleIndex < count && `in`.read(chunk).also { read = it } > 0) {
                    var offset = 0
                    if (carried == 1) {
                        samples[sampleIndex++] =
                            ((carriedByte.toInt() and 0xff) or (chunk[0].toInt() shl 8)).toShort() / 32768.0f
                        offset = 1
                        carried = 0
                    }
                    val pairs = (read - offset) / 2
                    var i = 0
                    while (i < pairs && sampleIndex < count) {
                        val base = offset + i * 2
                        samples[sampleIndex++] =
                            ((chunk[base].toInt() and 0xff) or (chunk[base + 1].toInt() shl 8)).toShort() / 32768.0f
                        i++
                    }
                    if (((read - offset) and 1) == 1) {
                        carried = 1
                        carriedByte = chunk[read - 1]
                    }
                }
                return samples
            }
        }
    }

    interface Listener {
        /** progress in [0, 1]. */
        fun onProgress(progress: Double)

        /** turns: [{startMs, endMs, cluster}], sorted by start time. */
        fun onDone(turnsJson: String?)

        fun onError(message: String?)
    }

    private val threshold: Float = if (threshold <= 0) 0.5f else threshold
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile
    private var cancelled = false

    fun start() {
        val thread = Thread(Runnable { run() }, "FaceclawDiarizer")
        thread.priority = Thread.MIN_PRIORITY
        thread.start()
    }

    fun cancel() {
        cancelled = true
    }

    private fun run() {
        var diarization: OfflineSpeakerDiarization? = null
        try {
            val samples = if (wavPath!!.endsWith(".wav"))
                readWavMono16(wavPath)
            else
                decodeCompressedMono(wavPath)
            val config = OfflineSpeakerDiarizationConfig.builder()
                .setSegmentation(OfflineSpeakerSegmentationModelConfig.builder()
                    .setPyannote(OfflineSpeakerSegmentationPyannoteModelConfig.builder()
                        .setModel(segmentationModelPath)
                        .build())
                    .setNumThreads(1)
                    .build())
                .setEmbedding(SpeakerEmbeddingExtractorConfig.builder()
                    .setModel(embeddingModelPath)
                    .setNumThreads(1)
                    .build())
                .setClustering(FastClusteringConfig.builder()
                    .setNumClusters(if (numClusters > 0) numClusters else -1)
                    .setThreshold(threshold)
                    .build())
                .setMinDurationOn(0.3f)
                .setMinDurationOff(0.5f)
                .build()
            diarization = OfflineSpeakerDiarization(config)
            val segments: Array<OfflineSpeakerDiarizationSegment>? = diarization.processWithCallback(
                samples,
                OfflineSpeakerDiarizationCallback { numProcessedChunks, numTotalChunks, _ ->
                    emitProgress(if (numTotalChunks <= 0) 0.0
                        else numProcessedChunks.toDouble() / numTotalChunks)
                    if (cancelled) 1 else 0
                })
            val turns = JSONArray()
            if (segments != null) {
                for (segment in segments) {
                    val turn = JSONObject()
                    turn.put("startMs", Math.round(segment.start * 1000))
                    turn.put("endMs", Math.round(segment.end * 1000))
                    turn.put("cluster", segment.speaker)
                    turns.put(turn)
                }
            }
            val result = turns.toString()
            mainHandler.post { listener.onDone(result) }
        } catch (t: Throwable) {
            Log.w(TAG, "diarization failed for $wavPath", t)
            val message = if (t.message == null) t.toString() else t.message
            mainHandler.post { listener.onError(message) }
        } finally {
            if (diarization != null) {
                diarization.release()
            }
        }
    }

    private fun emitProgress(progress: Double) {
        mainHandler.post { listener.onProgress(Math.max(0.0, Math.min(1.0, progress))) }
    }
}
