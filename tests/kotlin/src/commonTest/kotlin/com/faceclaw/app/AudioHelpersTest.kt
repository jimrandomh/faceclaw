package com.faceclaw.app

import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AudioHelpersTest {
    @Test
    fun cutPointLandsInQuietestWindowForFloatsAndShorts() {
        // 1000 loud samples with a silent gap at 700..760; search the last 500 with a 40 window.
        val floats = FloatArray(1000) { if (it in 700 until 760) 0f else 0.5f }
        val cut = AudioSegmentation.quietestCutPoint(floats, floats.size, 500, 40)
        assertTrue(cut in 700..760, "cut=$cut")
        val shorts = ShortArray(1100) { if (it - 100 in 700 until 760) 0 else 16000 }
        assertEquals(cut, AudioSegmentation.quietestCutPoint(shorts, 100, 1000, 500, 40))
        // Too short to search: returns the length unchanged.
        assertEquals(30, AudioSegmentation.quietestCutPoint(FloatArray(30) { 0.1f }, 30, 500, 40))
    }

    @Test
    fun normalizePeakScalesUpButNeverDown() {
        val quiet = floatArrayOf(0.01f, -0.02f, 0.005f)
        AudioSegmentation.normalizePeak(quiet, 0.9f, 30f)
        assertTrue(abs(quiet[1] + 0.6f) < 1e-6f, "capped at maxGain 30: ${quiet[1]}")
        val loud = floatArrayOf(0.95f, -0.5f)
        AudioSegmentation.normalizePeak(loud, 0.9f, 30f)
        assertEquals(0.95f, loud[0])
        val silent = FloatArray(4)
        AudioSegmentation.normalizePeak(silent, 0.9f, 30f)
        assertEquals(0f, AudioSegmentation.peakAmplitude(silent))
    }

    @Test
    fun pcmConversionsRoundTrip() {
        val samples = shortArrayOf(0, 1, -1, 32767, -32768, 256)
        val le = AudioSegmentation.pcm16ToLittleEndian(samples, 0, samples.size)
        assertEquals(listOf(0, 0, 1, 0, 0xff, 0xff, 0xff, 0x7f, 0, 0x80, 0, 1), le.map { it.toInt() and 0xff })
        val floats = AudioSegmentation.pcm16leToFloat(le)
        assertEquals(AudioSegmentation.pcm16ToFloat(samples, 0, samples.size).toList(), floats.toList())
        assertEquals(32767 / 32768.0f, floats[3])
        assertEquals(-1f, floats[4])
        assertEquals(2.0, AudioSegmentation.rms(shortArrayOf(2, -2, 2, -2), 0, 4))
    }

    @Test
    fun voicePrintMathAndBlobCodec() {
        val v = floatArrayOf(3f, 4f)
        VoicePrint.l2Normalize(v)
        assertEquals(listOf(0.6f, 0.8f), v.toList())
        assertTrue(abs(VoicePrint.dot(v, v) - 1.0) < 1e-6)
        assertNull(VoicePrint.l2Normalize(null))
        assertTrue(VoicePrint.isLongEnoughToEmbed(16000, 16000))
        assertTrue(!VoicePrint.isLongEnoughToEmbed(15999, 16000))

        val blob = SpeakerEmbeddings.floatsToBlob(floatArrayOf(1.5f, -2f))
        assertEquals(listOf(0, 0, 0xc0, 0x3f, 0, 0, 0, 0xc0), blob.map { it.toInt() and 0xff })
        assertEquals(listOf(1.5f, -2f), SpeakerEmbeddings.blobToFloats(blob)!!.toList())
        assertNull(SpeakerEmbeddings.blobToFloats(byteArrayOf(1, 2, 3)))
        assertNull(SpeakerEmbeddings.blobToFloats(null))
    }

    @Test
    fun centroidUpdatesAndBlends() {
        val first = SpeakerEmbeddings.runningMean(null, 0, floatArrayOf(1f, 0f), 5)
        assertEquals(1, first.count)
        assertEquals(listOf(1f, 0f), first.embedding.toList())
        val second = SpeakerEmbeddings.runningMean(first.embedding, first.count, floatArrayOf(0f, 1f), 5)
        assertEquals(2, second.count)
        assertTrue(abs(second.embedding[0] - second.embedding[1]) < 1e-6f)
        assertTrue(abs(VoicePrint.dot(second.embedding, second.embedding) - 1.0) < 1e-6)
        // The cap limits the existing weight: count 100 capped at 1 behaves like an equal blend.
        val capped = SpeakerEmbeddings.runningMean(floatArrayOf(1f, 0f), 100, floatArrayOf(0f, 1f), 1)
        assertTrue(abs(capped.embedding[0] - capped.embedding[1]) < 1e-6f)
        assertEquals(101, capped.count)
        // Mismatched sizes restart the centroid.
        assertEquals(1, SpeakerEmbeddings.runningMean(floatArrayOf(1f), 4, floatArrayOf(0f, 1f), 5).count)

        val blended = SpeakerEmbeddings.blend(floatArrayOf(1f, 0f), 1, floatArrayOf(0f, 1f), 3)
        assertNotNull(blended)
        assertTrue(blended[1] > blended[0])
        assertEquals(listOf(0f, 1f), SpeakerEmbeddings.blend(null, 0, floatArrayOf(0f, 1f), 3)!!.toList())
        assertEquals(listOf(1f, 0f), SpeakerEmbeddings.blend(floatArrayOf(1f, 0f), 2, null, 0)!!.toList())
        assertNull(SpeakerEmbeddings.blend(null, 0, null, 0))
        assertTrue(SpeakerEmbeddings.shouldAdoptInsights(targetHasInsights = false, sourceHasInsights = true))
        assertTrue(!SpeakerEmbeddings.shouldAdoptInsights(targetHasInsights = true, sourceHasInsights = true))
    }

    private fun wav(dataSize: Int, extraChunk: Boolean = false, channels: Int = 1, bits: Int = 16, format: Int = 1): ByteArray {
        val out = ByteSink()
        fun u16(v: Int) { out.write(v); out.write(v ushr 8) }
        fun u32(v: Int) { u16(v); u16(v ushr 16) }
        out.write("RIFF".encodeToByteArray()); u32(0); out.write("WAVE".encodeToByteArray())
        if (extraChunk) { out.write("LIST".encodeToByteArray()); u32(4); u32(0) }
        out.write("fmt ".encodeToByteArray()); u32(18)
        u16(format); u16(channels); u32(16000); u32(16000 * channels * 2); u16(channels * 2); u16(bits); u16(0)
        out.write("data".encodeToByteArray()); u32(dataSize)
        return out.toByteArray()
    }

    @Test
    fun wavHeaderParsesChunksAndRecoversZeroSize() {
        val header = wav(4000)
        val info = WavPcmReader.parseHeader(header, header.size + 4000L)
        assertEquals(16000, info.sampleRate)
        assertEquals(1, info.channels)
        assertEquals(16, info.bitsPerSample)
        assertEquals(header.size.toLong(), info.dataOffset)
        assertEquals(4000L, info.dataBytes)

        val withList = wav(100, extraChunk = true)
        assertEquals(withList.size.toLong(), WavPcmReader.parseHeader(withList, withList.size + 100L).dataOffset)

        val unpatched = wav(0)
        assertEquals(1234L, WavPcmReader.parseHeader(unpatched, unpatched.size + 1234L).dataBytes)

        assertFailsWith<IllegalArgumentException> { WavPcmReader.parseHeader("RIFX".encodeToByteArray() + ByteArray(20), 24) }
        assertFailsWith<IllegalArgumentException> { WavPcmReader.parseHeader(wav(10, bits = 8), 100) }
        assertFailsWith<IllegalArgumentException> { WavPcmReader.parseHeader(wav(10, format = 3), 100) }
        assertFailsWith<IllegalArgumentException> { WavPcmReader.parseHeader(wav(10).copyOf(20), 100) }
        // The shared header matches the shared writer.
        val written = BinaryEncoding.wavHeader(640, 16000, 1)
        val parsed = WavPcmReader.parseHeader(written, 44 + 640L)
        assertEquals(44L, parsed.dataOffset)
        assertEquals(640L, parsed.dataBytes)
    }
}
