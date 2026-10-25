package com.faceclaw.app

import android.util.Log
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile

/** Android streaming file adapter; the PCM/WAV format is shared Kotlin. */
class FaceclawWavRecorder
@Throws(IOException::class)
constructor(
    private val path: String,
    private val sampleRate: Int,
    private val channels: Int,
) {
    companion object {
        /**
         * Rewrite the header of a recording whose writer never finished (the process died
         * mid-recording, leaving the empty header written at start) to cover the PCM actually on
         * disk, trimming any partial sample frame. Returns the PCM byte count, or -1 when the
         * file doesn't exist.
         */
        @JvmStatic
        @Throws(IOException::class)
        fun repairHeader(path: String, sampleRate: Int, channels: Int): Long {
            val target = File(path)
            if (!target.exists()) return -1
            val headerBytes = BinaryEncoding.wavHeader(0, sampleRate, channels).size.toLong()
            val frameBytes = channels * 2L
            val pcmBytes = maxOf(0L, target.length() - headerBytes) / frameBytes * frameBytes
            RandomAccessFile(target, "rw").use {
                it.setLength(headerBytes + pcmBytes)
                it.seek(0)
                it.write(BinaryEncoding.wavHeader(minOf(pcmBytes, Int.MAX_VALUE.toLong()).toInt(), sampleRate, channels))
            }
            return pcmBytes
        }
    }

    private var file: RandomAccessFile?
    private var dataBytes = 0L

    init {
        val parent = File(path).parentFile
        if (parent != null && !parent.exists() && !parent.mkdirs())
            throw IOException("could not create $parent")
        file =
            RandomAccessFile(path, "rw").also {
                it.setLength(0)
                it.write(BinaryEncoding.wavHeader(0, sampleRate, channels))
            }
    }

    @Synchronized
    fun append(pcm16le: ByteArray?) {
        val current = file ?: return
        if (pcm16le == null || pcm16le.isEmpty()) return
        try {
            current.write(pcm16le)
            dataBytes += pcm16le.size
        } catch (e: IOException) {
            Log.w("FaceclawWavRecorder", "append failed", e)
        }
    }

    @Synchronized fun getDurationMs(): Long = dataBytes * 1000L / (sampleRate * channels * 2L)

    fun getPath(): String = path

    @Synchronized
    fun finish(): Long {
        val current = file ?: return dataBytes
        file = null
        try {
            current.use {
                it.seek(0)
                it.write(
                    BinaryEncoding.wavHeader(
                        minOf(dataBytes, Int.MAX_VALUE.toLong()).toInt(),
                        sampleRate,
                        channels,
                    )
                )
            }
        } catch (e: IOException) {
            Log.w("FaceclawWavRecorder", "finish failed", e)
        }
        return dataBytes
    }

    @Synchronized
    fun discard() {
        finish()
        File(path).delete()
    }
}
