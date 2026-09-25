package com.faceclaw.app

import kotlin.jvm.JvmStatic
import kotlin.math.sqrt

/** Voice-print (speaker embedding) vector math shared by extraction, verification and storage. */
object VoicePrint {
    /** L2-normalizes [v] in place and returns it; a null or zero vector is returned unchanged. */
    @JvmStatic
    fun l2Normalize(v: FloatArray?): FloatArray? {
        if (v == null) return null
        var sum = 0.0
        for (x in v) sum += x.toDouble() * x
        val norm = sqrt(sum)
        if (norm <= 0) return v
        for (i in v.indices) v[i] = (v[i] / norm).toFloat()
        return v
    }

    /** Dot product; on L2-normalized vectors this is the cosine similarity. */
    @JvmStatic
    fun dot(a: FloatArray, b: FloatArray): Double {
        require(a.size == b.size) { "embedding sizes differ: ${a.size} vs ${b.size}" }
        var sum = 0.0
        for (i in a.indices) sum += a[i].toDouble() * b[i]
        return sum
    }

    /** Utterances shorter than this (~0.5 s of S16 mono at [sampleRate]) produce unreliable prints. */
    @JvmStatic
    fun isLongEnoughToEmbed(pcm16leBytes: Int, sampleRate: Int): Boolean = pcm16leBytes >= sampleRate
}

/** Persistence-side voice-print math: float32-LE blobs and centroid updates. */
object SpeakerEmbeddings {
    /** Decodes a float32-LE blob; null for a null, empty or misaligned blob. */
    @JvmStatic
    fun blobToFloats(blob: ByteArray?): FloatArray? {
        if (blob == null || blob.size < 4 || blob.size % 4 != 0) return null
        val out = FloatArray(blob.size / 4)
        for (i in out.indices) {
            val base = i * 4
            val bits = (blob[base].toInt() and 0xff) or
                ((blob[base + 1].toInt() and 0xff) shl 8) or
                ((blob[base + 2].toInt() and 0xff) shl 16) or
                ((blob[base + 3].toInt() and 0xff) shl 24)
            out[i] = Float.fromBits(bits)
        }
        return out
    }

    @JvmStatic
    fun floatsToBlob(values: FloatArray): ByteArray {
        val out = ByteArray(values.size * 4)
        for (i in values.indices) {
            val bits = values[i].toRawBits()
            val base = i * 4
            out[base] = (bits and 0xff).toByte()
            out[base + 1] = ((bits shr 8) and 0xff).toByte()
            out[base + 2] = ((bits shr 16) and 0xff).toByte()
            out[base + 3] = ((bits shr 24) and 0xff).toByte()
        }
        return out
    }

    class Centroid(val embedding: FloatArray, val count: Int)

    /**
     * Running-mean update of a speaker's centroid with one new print, with the existing
     * weight capped at [maxCount] so a long session cannot drown the enrolled voice. A
     * missing or differently sized current centroid is replaced by [update] (count 1).
     */
    @JvmStatic
    fun runningMean(current: FloatArray?, currentCount: Int, update: FloatArray, maxCount: Int): Centroid {
        if (current == null || current.size != update.size) return Centroid(update, 1)
        val effective = minOf(currentCount, maxOf(1, maxCount))
        val merged = FloatArray(current.size)
        for (i in merged.indices) merged[i] = (current[i] * effective + update[i]) / (effective + 1)
        VoicePrint.l2Normalize(merged)
        return Centroid(merged, currentCount + 1)
    }

    /**
     * Blends two centroids weighted by their sample counts when both exist with the same
     * size; otherwise keeps [into], falling back to [from] when [into] is missing. Null when
     * neither exists.
     */
    @JvmStatic
    fun blend(from: FloatArray?, fromCount: Int, into: FloatArray?, intoCount: Int): FloatArray? {
        if (from != null && into != null && from.size == into.size) {
            val blended = FloatArray(into.size)
            val total = maxOf(1, fromCount + intoCount)
            for (i in blended.indices) blended[i] = (into[i] * intoCount + from[i] * fromCount) / total
            VoicePrint.l2Normalize(blended)
            return blended
        }
        return into ?: from
    }

    /** When merging speakers, the target keeps its conversation insights; it adopts the source's only when it has none. */
    @JvmStatic
    fun shouldAdoptInsights(targetHasInsights: Boolean, sourceHasInsights: Boolean): Boolean =
        !targetHasInsights && sourceHasInsights
}
