package com.faceclaw.app

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.util.Log

import java.io.File
import java.io.FileInputStream
import java.io.IOException

/**
 * Transcodes a 16-bit PCM WAV conversation recording into AAC-LC in an M4A
 * container, cutting speech recordings to roughly a tenth of their WAV size.
 * Runs on its own thread; the source WAV is deleted on success when requested.
 */
class FaceclawAudioTranscoder(
    private val wavPath: String?,
    private val outputPath: String?,
    bitrateBps: Int,
    private val deleteSourceOnSuccess: Boolean,
    private val listener: Listener?
) {
    companion object {
        private const val TAG = "FaceclawTranscode"
        private const val CODEC_TIMEOUT_US: Long = 10_000

        /** Shared RIFF walk over the file's first bytes: locates fmt and data chunks, 16-bit PCM only. */
        @JvmStatic
        @Throws(IOException::class)
        private fun readWavHeader(path: String?): WavPcmReader.WavInfo {
            val file = File(path)
            val fileLength = file.length()
            FileInputStream(file).use { `in` ->
                val prefix = ByteArray(Math.min(fileLength, WavPcmReader.HEADER_PREFIX_BYTES.toLong()).toInt())
                var filled = 0
                while (filled < prefix.size) {
                    val read = `in`.read(prefix, filled, prefix.size - filled)
                    if (read <= 0) break
                    filled += read
                }
                try {
                    return WavPcmReader.parseHeader(if (filled == prefix.size) prefix else prefix.copyOf(filled), fileLength)
                } catch (e: IllegalArgumentException) {
                    throw IOException(e.message ?: "not a WAV file")
                }
            }
        }
    }

    interface Listener {
        fun onDone(outputPath: String?, outputBytes: Long)

        fun onError(message: String?)
    }

    private val bitrateBps: Int = if (bitrateBps > 0) bitrateBps else 32_000

    fun start() {
        val thread = Thread(Runnable { run() }, "FaceclawTranscode")
        thread.priority = Thread.MIN_PRIORITY
        thread.start()
    }

    private fun run() {
        try {
            transcode()
            val size = File(outputPath).length()
            if (deleteSourceOnSuccess) {
                File(wavPath).delete()
            }
            if (listener != null) {
                listener.onDone(outputPath, size)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "transcode failed for $wavPath", t)
            File(outputPath).delete()
            if (listener != null) {
                listener.onError(if (t.message == null) t.toString() else t.message)
            }
        }
    }

    @Throws(IOException::class)
    private fun transcode() {
        val wav = readWavHeader(wavPath)
        val format = MediaFormat.createAudioFormat(
            MediaFormat.MIMETYPE_AUDIO_AAC, wav.sampleRate, wav.channels)
        format.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
        format.setInteger(MediaFormat.KEY_BIT_RATE, bitrateBps)
        format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16 * 1024)

        val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
        var muxer: MediaMuxer? = null
        var input: FileInputStream? = null
        try {
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()
            muxer = MediaMuxer(outputPath!!, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            input = FileInputStream(wavPath)
            var skipped: Long = 0
            while (skipped < wav.dataOffset) {
                val step = input.skip(wav.dataOffset - skipped)
                if (step <= 0) {
                    throw IOException("could not seek past WAV header")
                }
                skipped += step
            }

            val info = MediaCodec.BufferInfo()
            val chunk = ByteArray(8192)
            var track = -1
            var muxerStarted = false
            var inputDone = false
            var outputDone = false
            var remaining = wav.dataBytes
            var presentationUs: Long = 0
            val bytesPerSecond = wav.sampleRate.toLong() * wav.channels * 2

            while (!outputDone) {
                if (!inputDone) {
                    val inIndex = codec.dequeueInputBuffer(CODEC_TIMEOUT_US)
                    if (inIndex >= 0) {
                        val inBuf = codec.getInputBuffer(inIndex)!!
                        val wanted = Math.min(chunk.size.toLong(), Math.min(remaining, inBuf.capacity().toLong())).toInt()
                        val read = if (wanted > 0) input.read(chunk, 0, wanted) else -1
                        if (read <= 0) {
                            codec.queueInputBuffer(inIndex, 0, 0, presentationUs,
                                MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            inputDone = true
                        } else {
                            inBuf.clear()
                            inBuf.put(chunk, 0, read)
                            codec.queueInputBuffer(inIndex, 0, read, presentationUs, 0)
                            remaining -= read.toLong()
                            presentationUs += read * 1_000_000L / bytesPerSecond
                        }
                    }
                }
                val outIndex = codec.dequeueOutputBuffer(info, CODEC_TIMEOUT_US)
                if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    track = muxer.addTrack(codec.outputFormat)
                    muxer.start()
                    muxerStarted = true
                } else if (outIndex >= 0) {
                    if (info.size > 0 && (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                        if (!muxerStarted) {
                            throw IOException("encoder produced data before format")
                        }
                        val outBuf = codec.getOutputBuffer(outIndex)!!
                        outBuf.position(info.offset)
                        outBuf.limit(info.offset + info.size)
                        muxer.writeSampleData(track, outBuf, info)
                    }
                    codec.releaseOutputBuffer(outIndex, false)
                    if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                        outputDone = true
                    }
                }
            }
        } finally {
            if (input != null) {
                try {
                    input.close()
                } catch (ignored: IOException) {
                }
            }
            try {
                codec.stop()
            } catch (ignored: Throwable) {
            }
            codec.release()
            if (muxer != null) {
                try {
                    muxer.stop()
                } catch (ignored: Throwable) {
                }
                muxer.release()
            }
        }
    }
}
