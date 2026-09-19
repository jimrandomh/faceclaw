package com.faceclaw.app

import kotlin.math.roundToInt

/**
 * Spectral suppression for PCM from glasses microphones: 16 ms sqrt-Hann frames at 50% overlap,
 * asymmetric noise-floor tracking and a smoothed Wiener gain. Android capture-session effects live
 * in AndroidNoiseEffects. This processor has no platform dependencies and must be owned by a single
 * audio worker.
 */
class FaceclawNoiseSuppressor {
    companion object {
        private const val FFT_SIZE: Int = 256

        private val HOP: Int = (FFT_SIZE / 2)

        private val OVERSUBTRACTION: Float = 1.6f

        /** About -16 dB of residual: keeps the noise bed natural instead of gated. */
        private val GAIN_FLOOR: Float = 0.15f

        private val GAIN_SMOOTHING: Float = 0.6f

        /** Frames of pure noise-floor learning after start/reset (~100 ms). */
        private const val NOISE_WARMUP_FRAMES: Int = 12

        /** In-place iterative radix-2 FFT (inverse includes the 1/N scale). */
        private fun fft(re: FloatArray, im: FloatArray, inverse: Boolean): Unit {
            var n: Int = re.size
            run {
                var i: Int = 1
                var j: Int = 0
                while ((i < n)) {
                    var bit: Int = (n shr 1)
                    run {
                        while (((j and bit) != 0)) {
                            j = (j xor bit)
                            bit = (bit shr 1)
                        }
                    }
                    j = (j xor bit)
                    if ((i < j)) {
                        var t: Float = re[i]
                        re[i] = re[j]
                        re[j] = t
                        t = im[i]
                        im[i] = im[j]
                        im[j] = t
                    }
                    i++
                }
            }
            run {
                var len: Int = 2
                while ((len <= n)) {
                    var ang: Double = (((2 * kotlin.math.PI) / len) * (if (inverse) 1 else -1))
                    var wRe: Float = (kotlin.math.cos(ang)).toFloat()
                    var wIm: Float = (kotlin.math.sin(ang)).toFloat()
                    run {
                        var i: Int = 0
                        while ((i < n)) {
                            var curRe: Float = 1f
                            var curIm: Float = 0f
                            run {
                                var k: Int = 0
                                while ((k < (len / 2))) {
                                    var a: Int = (i + k)
                                    var b: Int = (a + (len / 2))
                                    var xr: Float = ((re[b] * curRe) - (im[b] * curIm))
                                    var xi: Float = ((re[b] * curIm) + (im[b] * curRe))
                                    re[b] = (re[a] - xr)
                                    im[b] = (im[a] - xi)
                                    re[a] += xr
                                    im[a] += xi
                                    var nextRe: Float = ((curRe * wRe) - (curIm * wIm))
                                    curIm = ((curRe * wIm) + (curIm * wRe))
                                    curRe = nextRe
                                    k++
                                }
                            }
                            i += len
                        }
                    }
                    len = (len shl 1)
                }
            }
            if (inverse) {
                run {
                    var i: Int = 0
                    while ((i < n)) {
                        re[i] /= n
                        im[i] /= n
                        i++
                    }
                }
            }
        }
    }

    private val sampleRate: Int

    private val window: FloatArray = FloatArray(FFT_SIZE)

    private val history: FloatArray = FloatArray(FFT_SIZE)

    private val overlap: FloatArray = FloatArray(HOP)

    private val noise: FloatArray = FloatArray(((FFT_SIZE / 2) + 1))

    private val gain: FloatArray = FloatArray(((FFT_SIZE / 2) + 1))

    private val re: FloatArray = FloatArray(FFT_SIZE)

    private val im: FloatArray = FloatArray(FFT_SIZE)

    private val pending: ShortArray = ShortArray(HOP)

    private var pendingCount: Int = 0

    private var warmupFrames: Int = 0

    constructor(sampleRate: Int) {
        this.sampleRate = sampleRate
        run {
            var i: Int = 0
            while ((i < FFT_SIZE)) {
                window[i] = (kotlin.math.sin(((kotlin.math.PI * (i + 0.5)) / FFT_SIZE))).toFloat()
                i++
            }
        }
        reset()
    }

    fun getSampleRate(): Int {
        return sampleRate
    }

    /** Forget the learned noise floor (e.g. after the suppressor was toggled off). */
    fun reset(): Unit {
        history.fill(0f)
        overlap.fill(0f)
        noise.fill(0f)
        gain.fill(1f)
        pendingCount = 0
        warmupFrames = 0
    }

    /**
     * Suppress noise in 16-bit little-endian mono PCM. Streaming: input not filling a whole 8 ms
     * hop is carried into the next call, so the output may be up to one hop shorter than the input
     * (and longer on a later call); total latency is one hop.
     */
    fun process(pcm16le: ByteArray?): ByteArray? {
        if (((pcm16le == null) || (pcm16le.size < 2))) {
            return pcm16le
        }
        var sampleCount: Int = (pcm16le.size / 2)
        var hops: Int = ((pendingCount + sampleCount) / HOP)
        var out: ByteArray = ByteArray(((hops * HOP) * 2))
        var outPos: Int = 0
        var inPos: Int = 0
        while ((inPos < sampleCount)) {
            var take: Int = minOf((HOP - pendingCount), (sampleCount - inPos))
            run {
                var i: Int = 0
                while ((i < take)) {
                    var lo: Int = (pcm16le[((inPos + i) * 2)] and 0xff)
                    var hi: Int = pcm16le[(((inPos + i) * 2) + 1)].toInt()
                    pending[(pendingCount + i)] = (((hi shl 8) or lo)).toShort()
                    i++
                }
            }
            pendingCount += take
            inPos += take
            if ((pendingCount == HOP)) {
                outPos = processHop(out, outPos)
                pendingCount = 0
            }
        }
        return out
    }

    private fun processHop(out: ByteArray, outPos: Int): Int {
        var outPos = outPos
        history.copyInto(history, 0, HOP, HOP + (FFT_SIZE - HOP))
        run {
            var i: Int = 0
            while ((i < HOP)) {
                history[((FFT_SIZE - HOP) + i)] = (pending[i] / 32768f)
                i++
            }
        }
        run {
            var i: Int = 0
            while ((i < FFT_SIZE)) {
                re[i] = (history[i] * window[i])
                im[i] = 0f
                i++
            }
        }
        fft(re, im, false)
        var warming: Boolean = (warmupFrames < NOISE_WARMUP_FRAMES)
        if (warming) {
            warmupFrames++
        }
        run {
            var b: Int = 0
            while ((b <= (FFT_SIZE / 2))) {
                var power: Float = ((re[b] * re[b]) + (im[b] * im[b]))
                if (warming) {
                    noise[b] =
                        (if ((warmupFrames == 1)) power
                        else (noise[b] + ((power - noise[b]) / warmupFrames)))
                } else {
                    if ((power < noise[b])) {
                        noise[b] += ((power - noise[b]) * 0.2f)
                    } else {
                        noise[b] = minOf(power, ((noise[b] * 1.006f) + 1e-10f))
                    }
                }
                var clean: Float = (power - (OVERSUBTRACTION * noise[b]))
                var g: Float = (if ((clean > 0f)) (clean / power) else 0f)
                if ((g < GAIN_FLOOR)) {
                    g = GAIN_FLOOR
                }
                g = ((GAIN_SMOOTHING * gain[b]) + ((1f - GAIN_SMOOTHING) * g))
                gain[b] = g
                re[b] *= g
                im[b] *= g
                if (((b > 0) && (b < (FFT_SIZE / 2)))) {
                    re[(FFT_SIZE - b)] *= g
                    im[(FFT_SIZE - b)] *= g
                }
                b++
            }
        }
        fft(re, im, true)
        run {
            var i: Int = 0
            while ((i < HOP)) {
                var value: Float = ((overlap[i] + (re[i] * window[i])) * 32767f)
                var sample: Int = value.roundToInt()
                if ((sample > 32767)) {
                    sample = 32767
                }
                if ((sample < -32768)) {
                    sample = -32768
                }
                out[(outPos + (i * 2))] = ((sample and 0xff)).toByte()
                out[((outPos + (i * 2)) + 1)] = (((sample shr 8) and 0xff)).toByte()
                i++
            }
        }
        run {
            var i: Int = 0
            while ((i < HOP)) {
                overlap[i] = (re[(HOP + i)] * window[(HOP + i)])
                i++
            }
        }
        return (outPos + (HOP * 2))
    }
}
