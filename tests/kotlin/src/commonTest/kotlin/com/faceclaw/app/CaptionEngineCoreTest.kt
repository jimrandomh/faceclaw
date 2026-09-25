package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CaptionEngineCoreTest {
    private class Sink : CaptionSegmentSink {
        val starts = mutableListOf<Long>()
        val utterances = mutableListOf<List<Any>>()
        override fun onSpeechStart(startMs: Long) { starts.add(startMs) }
        override fun onUtterance(samples: ShortArray, length: Int, startMs: Long, endMs: Long, peakRms: Double) {
            utterances.add(listOf(length, startMs, endMs, samples[0].toInt()))
        }
    }

    private fun chunk(amplitude: Int, samples: Int = 800): ShortArray =
        ShortArray(samples) { if (it % 2 == 0) amplitude.toShort() else (-amplitude).toShort() }

    @Test
    fun segmenterUsesPreRollOnsetReleaseAndSilence() {
        val sink = Sink()
        val segmenter = CaptionSegmenter(sink)
        repeat(10) { segmenter.processChunk(chunk(100), 800) } // 500 ms idle, noise floor ~100 -> threshold 220
        repeat(10) { segmenter.processChunk(chunk(3000), 800) } // 500 ms speech
        assertEquals(listOf(100L), sink.starts) // 500 ms - 400 ms pre-roll
        repeat(15) { segmenter.processChunk(chunk(100), 800) } // 750 ms < 800 ms silence: still open
        assertTrue(sink.utterances.isEmpty())
        segmenter.processChunk(chunk(100), 800) // 800 ms of silence closes it
        assertEquals(1, sink.utterances.size)
        val (length, startMs, endMs, first) = sink.utterances[0]
        assertEquals(100L, startMs)
        assertEquals(6400 + 10 * 800 + 16 * 800, length) // pre-roll + speech + trailing silence
        assertEquals(startMs as Long + (length as Int) * 1000L / 16000, endMs)
        assertEquals(100, first) // the pre-roll audio leads the utterance
        assertTrue(segmenter.isInUtterance.not())
    }

    @Test
    fun segmenterDropsTooShortUtterancesAndCapsLength() {
        val sink = Sink()
        val segmenter = CaptionSegmenter(sink)
        segmenter.silenceMs = 100 // clamps to 200
        segmenter.processChunk(chunk(10), 800) // seeds the noise floor; becomes the 50 ms pre-roll
        segmenter.processChunk(chunk(3000), 800) // onset
        repeat(4) { segmenter.processChunk(chunk(0), 800) } // 200 ms silence
        assertEquals(1, sink.starts.size)
        assertTrue(sink.utterances.isEmpty()) // 300 ms < 350 ms minimum
        repeat(400) { segmenter.processChunk(chunk(3000), 800) } // 20 s of speech: capped at 15 s
        assertEquals(1, sink.utterances.size)
        assertEquals(16000 * 15, sink.utterances[0][0])
        segmenter.flush()
        assertEquals(2, sink.utterances.size) // the remainder is flushed on stop
    }

    @Test
    fun utteranceDecoderSplitsLongAudioAndEmbedsTenSeconds() {
        val calls = mutableListOf<Int>()
        val transcriber = object : OfflineTranscriber {
            override fun recognize(samples: FloatArray, count: Int): String { calls.add(count); return if (calls.size == 2) ", b" else "a" }
            override fun release() {}
        }
        var embedded = 0
        val embedder = object : SpeakerEmbedder {
            override fun embed(pcm16le: ByteArray, sampleRate: Int): FloatArray? { embedded = pcm16le.size; return floatArrayOf(1f) }
            override fun release() {}
        }
        val decoder = UtteranceDecoder(transcriber, embedder)
        val utterance = ShortArray(16000 * 12) { if (it % 2 == 0) 2000 else -2000 }
        assertEquals("a, b", decoder.recognize(utterance, utterance.size))
        assertEquals(2, calls.size)
        assertTrue(calls[0] <= UtteranceDecoder.DECODE_SEGMENT_MAX_SAMPLES)
        assertEquals(utterance.size, calls.sum())
        assertNotNull(decoder.embed(utterance, utterance.size))
        assertEquals(16000 * 10 * 2, embedded)
        assertEquals("", UtteranceDecoder(null, null).recognize(utterance, utterance.size))
        assertNull(UtteranceDecoder(null, null).embed(utterance, utterance.size))
    }

    @Test
    fun captionSessionRunsQueueThroughSegmenterAndDecoder() {
        val startLatch = Latch(1, testPlatform())
        val utteranceLatch = Latch(1, testPlatform())
        val events = mutableListOf<String>()
        val listener = object : FaceclawCaptionEngineListener {
            override fun onUtterance(text: String?, embedding: FloatArray?, startMs: Long, endMs: Long, peakRms: Double) {
                events.add("utterance:$text:${embedding?.size}:$startMs"); utteranceLatch.countDown()
            }
            override fun onSpeechStart(startMs: Long) { events.add("start:$startMs"); startLatch.countDown() }
            override fun onStatus(status: String?) { events.add("status:$status") }
        }
        val host = object : CaptionHost {
            override val dispatcher = CallbackDispatcher { it() }
            override fun loadTranscriber(modelDir: String): OfflineTranscriber? = if (modelDir == "models") object : OfflineTranscriber {
                override fun recognize(samples: FloatArray, count: Int): String = "hi"
                override fun release() {}
            } else null
            override fun loadEmbedder(modelPath: String): SpeakerEmbedder? = object : SpeakerEmbedder {
                override fun embed(pcm16le: ByteArray, sampleRate: Int): FloatArray? = floatArrayOf(0.5f, 0.5f)
                override fun release() {}
            }
        }
        val session = CaptionSession(host, testPlatform(), "caption-test") { m, e -> error("$m: $e") }
        session.setListener(listener)
        session.setAsrModelDir("models")
        session.setSpeakerModelPath("speaker")
        session.setSilenceMs(300)
        session.acceptPcm(ByteArray(1600)) // ignored before start
        session.start()
        val loud = AudioSegmentation.pcm16ToLittleEndian(chunk(3000), 0, 800)
        val quiet = AudioSegmentation.pcm16ToLittleEndian(chunk(0), 0, 800)
        val idle = AudioSegmentation.pcm16ToLittleEndian(chunk(10), 0, 800)
        repeat(2) { session.acceptPcm(idle) } // seeds the noise floor and fills 100 ms of pre-roll
        repeat(10) { session.acceptPcm(loud) }
        assertTrue(startLatch.await(5000))
        repeat(8) { session.acceptPcm(quiet) }
        assertTrue(utteranceLatch.await(5000))
        session.stop()
        session.stop() // idempotent
        assertEquals("status:Loading caption model...", events[0])
        assertEquals("status:Captions listening...", events[1])
        assertEquals("start:0", events[2])
        assertEquals("utterance:hi:2:0", events[3])
    }
}
