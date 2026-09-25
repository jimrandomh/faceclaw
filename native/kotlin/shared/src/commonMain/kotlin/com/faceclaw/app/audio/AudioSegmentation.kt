package com.faceclaw.app

import kotlin.jvm.JvmStatic
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Sample-level helpers shared by the push-to-talk voice controller and the caption engine
 * (previously two private copies each). All PCM is 16 kHz mono S16LE unless stated.
 */
object AudioSegmentation {
    /**
     * Where to end a decode segment: the center of the quietest [windowSamples]-long window
     * within the last [searchSamples] of `samples[offset until offset + length]`, so the cut
     * lands between words rather than splitting one. Returns [length] when the region is
     * too short to search.
     */
    @JvmStatic
    fun quietestCutPoint(samples: FloatArray, length: Int, searchSamples: Int, windowSamples: Int): Int =
        quietestCutPoint(length, searchSamples, windowSamples) { samples[it].toDouble() }

    @JvmStatic
    fun quietestCutPoint(samples: ShortArray, offset: Int, length: Int, searchSamples: Int, windowSamples: Int): Int =
        quietestCutPoint(length, searchSamples, windowSamples) { samples[offset + it].toDouble() }

    private inline fun quietestCutPoint(length: Int, searchSamples: Int, windowSamples: Int, sample: (Int) -> Double): Int {
        val searchStart = maxOf(0, length - searchSamples)
        val win = windowSamples
        if (length - searchStart <= win) return length
        var sum = 0.0
        for (i in searchStart until searchStart + win) {
            val s = sample(i)
            sum += s * s
        }
        var best = sum
        var bestStart = searchStart
        var start = searchStart + 1
        while (start + win <= length) {
            val dropped = sample(start - 1)
            val added = sample(start + win - 1)
            sum += added * added - dropped * dropped
            if (sum < best) {
                best = sum
                bestStart = start
            }
            start++
        }
        return bestStart + win / 2
    }

    @JvmStatic
    fun peakAmplitude(samples: FloatArray): Float = peakAmplitude(samples, samples.size)

    @JvmStatic
    fun peakAmplitude(samples: FloatArray, count: Int): Float {
        var peak = 0f
        for (i in 0 until count) {
            val a = abs(samples[i])
            if (a > peak) peak = a
        }
        return peak
    }

    /**
     * Scales [samples] in place so the peak reaches [targetPeak], with the gain capped at
     * [maxGain]; audio already at or above the target is left untouched.
     */
    @JvmStatic
    fun normalizePeak(samples: FloatArray, targetPeak: Float, maxGain: Float) {
        val peak = peakAmplitude(samples)
        if (peak <= 0f) return
        val gain = min(targetPeak / peak, maxGain)
        if (gain <= 1f) return
        for (i in samples.indices) samples[i] *= gain
    }

    /** S16 samples to [-1, 1] floats. */
    @JvmStatic
    fun pcm16ToFloat(samples: ShortArray, offset: Int, count: Int): FloatArray {
        val out = FloatArray(count)
        for (i in 0 until count) out[i] = samples[offset + i] / 32768.0f
        return out
    }

    /** S16LE bytes to [-1, 1] floats (an odd trailing byte is ignored). */
    @JvmStatic
    fun pcm16leToFloat(bytes: ByteArray, offset: Int, byteCount: Int): FloatArray {
        val count = byteCount / 2
        val out = FloatArray(count)
        for (i in 0 until count) {
            val base = offset + i * 2
            out[i] = pcm16le(bytes[base], bytes[base + 1]) / 32768.0f
        }
        return out
    }

    @JvmStatic
    fun pcm16leToFloat(bytes: ByteArray): FloatArray = pcm16leToFloat(bytes, 0, bytes.size)

    /** One little-endian S16 sample from its two bytes. */
    @JvmStatic
    fun pcm16le(low: Byte, high: Byte): Short = ((low.toInt() and 0xff) or (high.toInt() shl 8)).toShort()

    /** S16 samples to S16LE bytes. */
    @JvmStatic
    fun pcm16ToLittleEndian(samples: ShortArray, offset: Int, count: Int): ByteArray {
        val le = ByteArray(count * 2)
        for (i in 0 until count) {
            val s = samples[offset + i].toInt()
            le[i * 2] = (s and 0xff).toByte()
            le[i * 2 + 1] = ((s shr 8) and 0xff).toByte()
        }
        return le
    }

    /** Root-mean-square of `samples[offset until offset + count]` in S16 units. */
    @JvmStatic
    fun rms(samples: ShortArray, offset: Int, count: Int): Double {
        var sumSquares = 0.0
        for (i in 0 until count) {
            val s = samples[offset + i].toDouble()
            sumSquares += s * s
        }
        return sqrt(sumSquares / maxOf(1, count))
    }
}
