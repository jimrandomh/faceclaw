package com.faceclaw.app

import kotlin.math.max
import kotlin.math.sqrt

/** Ends a hands-free utterance using the 16 kHz sample clock, not BLE arrival timing.
 * Shared by Android's voice controller and iOS's native audio queue.
 */
class VoiceEndpointDetector {
    private var totalSamples = 0L
    private var noiseAccum = 0.0
    private var noisePackets = 0
    private var threshold = 0.0
    private var speechStarted = false
    private var silenceSamples = 0L
    private var fired = false

    fun reset() {
        totalSamples = 0
        noiseAccum = 0.0
        noisePackets = 0
        threshold = 0.0
        speechStarted = false
        silenceSamples = 0
        fired = false
    }

    fun accept(pcm: ShortArray, count: Int): Boolean {
        if (fired || count <= 0) return false
        require(count <= pcm.size)
        var squares = 0.0
        for (i in 0 until count) {
            val sample = pcm[i].toDouble()
            squares += sample * sample
        }
        return acceptLevel(sqrt(squares / count), count)
    }

    /** RMS in PCM16 units. Allows native decoders to reuse their existing level calculation. */
    fun acceptLevel(rms: Double, sampleCount: Int): Boolean {
        if (fired || sampleCount <= 0) return false
        totalSamples += sampleCount
        val elapsedMs = totalSamples * 1000 / 16000
        if (elapsedMs <= 300) {
            noiseAccum += rms
            noisePackets++
            return false
        }
        if (threshold == 0.0) threshold = max(if (noisePackets > 0) noiseAccum / noisePackets else 0.0, 220.0)
        if (!speechStarted) {
            if (rms >= threshold * 3.0) {
                speechStarted = true
                silenceSamples = 0
            } else if (elapsedMs >= 6000) {
                fired = true
            }
            return fired
        }
        if (rms < threshold * 1.8) {
            silenceSamples += sampleCount
            if (silenceSamples * 1000 / 16000 >= 900) fired = true
        } else silenceSamples = 0
        if (elapsedMs >= 30000) fired = true
        return fired
    }
}
