package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class VoiceCaptureSessionTest {
    /** Real clock plus an offset the test can advance to force decode cadences. */
    private class ShiftedPlatform(private val base: ProtocolPlatform) : ProtocolPlatform by base {
        var offsetMs = 0L
        override fun elapsedRealtimeMs(): Long = base.elapsedRealtimeMs() + offsetMs
    }

    private class Events : FaceclawVoiceControllerListener {
        val statuses = mutableListOf<String?>()
        val transcripts = mutableListOf<Pair<String?, Boolean>>()
        val pcmChunks = mutableListOf<ByteArray>()
        val frameMeta = mutableListOf<Pair<Int, Int>>()
        var speechEnds = 0
        var verified: Pair<Boolean, Float>? = null
        val stopped = mutableListOf<Int>()
        val stoppedLatch = Latch(1, testPlatform())
        override fun onStatus(status: String?) { statuses.add(status) }
        override fun onTranscript(text: String?, isFinal: Boolean) { transcripts.add(text to isFinal) }
        override fun onStopped(captureId: Int) { stopped.add(captureId); stoppedLatch.countDown() }
        override fun onPcm(pcm16le: ByteArray?) { pcmChunks.add(pcm16le!!) }
        override fun onFrameMeta(angleDegrees: Int, ssr: Int) { frameMeta.add(angleDegrees to ssr) }
        override fun onSpeechEnd() { speechEnds++ }
        override fun onSpeakerVerified(isWearer: Boolean, similarity: Float) { verified = isWearer to similarity }
    }

    /** Scripted phone mic: each entry is a chunk amplitude; after the script the read fails (-1). */
    private class ScriptedMic(private val amplitudes: List<Int>, private val onRead: () -> Unit = {}) : PcmAudioSource {
        var index = 0
        var closed = false
        override fun read(pcm: ShortArray): Int {
            onRead()
            if (index >= amplitudes.size) return -1
            val amplitude = amplitudes[index++]
            for (i in pcm.indices) pcm[i] = (if (i % 2 == 0) amplitude else -amplitude).toShort()
            return pcm.size
        }
        override fun close() { closed = true }
    }

    private class FakeTranscriber(private val text: (Int) -> String) : OfflineTranscriber {
        val calls = mutableListOf<Int>()
        var released = false
        override fun recognize(samples: FloatArray, count: Int): String { calls.add(count); return text(count) }
        override fun release() { released = true }
    }

    private class FakeHost(
        val platform: ProtocolPlatform,
        var mic: PcmAudioSource? = null,
        var transcriber: OfflineTranscriber? = null,
        var hasModel: Boolean = true,
        var embedding: FloatArray? = null,
        var g2Ready: Boolean = false,
    ) : VoiceCaptureHost {
        override val dispatcher = CallbackDispatcher { it() }
        var packetListener: FaceclawAudioPacketListener? = null
        var g2Stops = 0
        val recordings = mutableListOf<ByteArray>()
        override fun onSessionStarting() {}
        override fun isG2SessionReady(): Boolean = g2Ready
        override fun isG2AudioCaptureActive(): Boolean = packetListener != null
        override fun g2AudioSource(): PacketAudioSource? = if (!g2Ready) null else object : PacketAudioSource {
            override fun start(listener: FaceclawAudioPacketListener): Boolean { packetListener = listener; return true }
            override fun stop() { g2Stops++ }
            override fun isActive(): Boolean = packetListener != null
        }
        override fun createPacketDecoder(): AudioPacketDecoder = object : AudioPacketDecoder {
            override fun decodePacket(packet: ByteArray?, pcmOut: ShortArray?): Int {
                if (packet == null || packet.size != Lc3PacketFramer.PACKET_BYTES) return 0
                pcmOut!!.fill(packet[0].toShort())
                lastAngleDegrees = Lc3PacketFramer.readTrailerS16(packet, Lc3PacketFramer.ANGLE_OFFSET)
                lastSsr = Lc3PacketFramer.readTrailerS16(packet, Lc3PacketFramer.SSR_OFFSET)
                realPackets++
                return Lc3PacketFramer.SAMPLES_PER_PACKET
            }
            override var lastAngleDegrees = 0
            override var lastSsr = 0
            override var realPackets = 0L
            override val duplicatePackets = 0L
            override val missingPackets = 0L
            override val decodeErrors = 0L
            override fun close() {}
        }
        override fun openPhoneMic(): PcmAudioSource? = mic
        override fun hasTranscriberModel(kind: VoiceModelKind): Boolean = hasModel
        override fun loadTranscriber(kind: VoiceModelKind): OfflineTranscriber = transcriber ?: error("no transcriber")
        override fun speakerEmbedder(modelPath: String): SpeakerEmbedder = object : SpeakerEmbedder {
            override fun embed(pcm16le: ByteArray, sampleRate: Int): FloatArray? = embedding
            override fun release() {}
        }
        override fun recordingSink(): RecordingSink = RecordingSink { bytes, _ -> recordings.add(bytes) }
    }

    private val logs = mutableListOf<String>()

    private fun session(host: VoiceCaptureHost, platform: ProtocolPlatform, name: String) =
        VoiceCaptureSession(host, platform, name, { logs.add("I $it") }, { logs.add("W $it") }, { m, e -> logs.add("E $m ${e.message}") })

    private fun packet(value: Int, angle: Int, ssr: Int): ByteArray {
        val bytes = ByteArray(Lc3PacketFramer.PACKET_BYTES)
        bytes[0] = value.toByte()
        bytes[Lc3PacketFramer.SSR_OFFSET] = (ssr and 0xff).toByte()
        bytes[Lc3PacketFramer.SSR_OFFSET + 1] = (ssr shr 8).toByte()
        bytes[Lc3PacketFramer.ANGLE_OFFSET] = (angle and 0xff).toByte()
        bytes[Lc3PacketFramer.ANGLE_OFFSET + 1] = (angle shr 8).toByte()
        return bytes
    }

    @Test
    fun beamGateWrapsAroundAndClampsHalfWidth() {
        val session = session(FakeHost(testPlatform()), testPlatform(), "voice-test-beam")
        session.setBeamFilter(true, 170, 30)
        assertTrue(session.withinBeam(170))
        assertTrue(session.withinBeam(-170)) // 20 degrees away across the wrap
        assertFalse(session.withinBeam(120))
        session.setBeamFilter(true, 0, 1) // clamps to 5
        assertTrue(session.withinBeam(5))
        assertFalse(session.withinBeam(6))
    }

    @Test
    fun droppingQueueKeepsNewestAndCountsDrops() {
        val queue = DroppingPacketQueue<Int>(3, testPlatform())
        for (i in 1..5) queue.put(i)
        assertEquals(2L, queue.droppedCount)
        assertEquals(3, queue.take(10) { true })
        assertEquals(4, queue.take(10) { true })
        assertEquals(5, queue.take(10) { true })
        assertNull(queue.take(10, { true }))
        assertNull(queue.take(10, { false }))
    }

    @Test
    fun g2PacketsAreCountedGatedAndForwarded() {
        val platform = ShiftedPlatform(testPlatform())
        val host = FakeHost(platform, g2Ready = true)
        val events = Events()
        val session = session(host, platform, "voice-test-g2")
        session.setListener(events)
        session.setBeamFilter(true, 0, 30)
        session.start("cloud", 7)
        val deadline = platform.elapsedRealtimeMs() + 3000
        while (host.packetListener == null && platform.elapsedRealtimeMs() < deadline) sleepMs(5)
        val listener = host.packetListener!!
        listener.onAudioPacket(packet(1, 10, 5), "L", 1000)
        listener.onAudioPacket(packet(2, 90, 5), "L", 1050)  // outside the beam: meta only
        listener.onAudioPacket(packet(3, 0, 0), "R", 1200)   // wrong arm, late (150 ms gap), ssr 0 passes the gate
        listener.onAudioPacket(ByteArray(3), "L", 1230)      // bad length: dropped by the decoder
        val waitUntil = platform.elapsedRealtimeMs() + 3000
        while (events.pcmChunks.size < 2 && platform.elapsedRealtimeMs() < waitUntil) sleepMs(5)
        session.stop()
        assertTrue(events.stoppedLatch.await(3000))
        val stats = session.audioStats()
        assertEquals(4L, stats.queuedPackets)
        assertEquals(1L, stats.wrongArmPackets)
        assertEquals(1L, stats.latePackets)
        assertEquals(150L, stats.maxInterPacketMs)
        assertEquals(2, events.pcmChunks.size)
        assertEquals(Lc3PacketFramer.SAMPLES_PER_PACKET * 2, events.pcmChunks[0].size)
        assertEquals(listOf(10 to 5, 90 to 5, 0 to 0), events.frameMeta)
        assertEquals(listOf(7), events.stopped)
        assertTrue(host.g2Stops >= 1)
        assertTrue(events.statuses.contains("Listening (cloud)..."))
        assertTrue(events.transcripts.isEmpty())
        assertTrue(logs.any { it.startsWith("I G2 mic packets=4 decoded=3") && it.contains("wrongArm=1") }, logs.toString())
    }

    @Test
    fun startRefusesWithoutGlassesAndWhenAlreadyRunning() {
        val host = FakeHost(testPlatform(), g2Ready = false)
        val events = Events()
        val session = session(host, testPlatform(), "voice-test-refuse")
        session.setListener(events)
        session.start("onboard", 3)
        assertEquals<List<String?>>(listOf("Voice control needs an active G2 connection."), events.statuses)
        assertEquals(listOf(3), events.stopped)
        assertFalse(session.isCapturing())
    }

    @Test
    fun onboardTranscriptCommitsSegmentsAndFinalizesWithReplaceSemantics() {
        val platform = ShiftedPlatform(testPlatform())
        // 170 chunks of 800 samples = 8.5 s: one 8 s segment commit plus a tail.
        val mic = ScriptedMic(List(170) { 3000 }) { platform.offsetMs += 1000 }
        val transcriber = FakeTranscriber { "x" }
        val host = FakeHost(platform, mic = mic, transcriber = transcriber)
        val events = Events()
        val session = session(host, platform, "voice-test-onboard")
        session.setListener(events)
        session.setUsePhoneMic(true)
        session.setSaveRecordings(true)
        session.start("onboard", 1)
        assertTrue(events.stoppedLatch.await(10000))
        assertTrue(mic.closed)
        assertTrue(transcriber.released)
        assertEquals("Loading transcription model...", events.statuses[0])
        assertEquals("Listening...", events.statuses[1])
        val finals = events.transcripts.filter { it.second }
        assertEquals(1, finals.size)
        assertEquals("x x", finals.single().first)
        assertEquals("x" to false, events.transcripts.first())
        assertTrue(events.transcripts.any { it == ("x x" to false) })
        // Every segment handed to the model is at most 8 s and was peak-normalized.
        assertTrue(transcriber.calls.all { it in 1..VoiceCaptureSession.TRANSCRIPT_SEGMENT_MAX_SAMPLES })
        assertTrue(logs.any { it.startsWith("I Moonshine decode final=true") }, logs.toString())
        assertEquals(1, host.recordings.size)
        assertEquals(170 * 800 * 2, host.recordings[0].size)
        assertEquals(170, events.pcmChunks.size)
        assertEquals("x x", VoiceCaptureSession.joinTranscript("x", "x"))
        assertEquals("x, y", VoiceCaptureSession.joinTranscript("x", ", y"))
    }

    @Test
    fun endpointingFiresOnceAfterSpeechThenSilence() {
        val platform = ShiftedPlatform(testPlatform())
        val script = List(8) { 0 } + List(10) { 3000 } + List(24) { 0 }
        val host = FakeHost(platform, mic = ScriptedMic(script))
        val events = Events()
        val session = session(host, platform, "voice-test-endpoint")
        session.setListener(events)
        session.setUsePhoneMic(true)
        session.setEndpointing(true)
        session.start("cloud", 2)
        assertTrue(events.stoppedLatch.await(10000))
        assertEquals(1, events.speechEnds)
        assertNull(events.verified)
    }

    @Test
    fun speakerVerificationFailsOpenAndComparesEmbeddings() {
        fun run(embedding: FloatArray?, chunks: Int): Pair<Boolean, Float>? {
            val platform = ShiftedPlatform(testPlatform())
            val host = FakeHost(platform, mic = ScriptedMic(List(chunks) { 1000 }), embedding = embedding)
            val events = Events()
            val session = session(host, platform, "voice-test-verify")
            session.setListener(events)
            session.setUsePhoneMic(true)
            session.setSpeakerVerification("model", floatArrayOf(1f, 0f), 0.8f)
            session.start("cloud", 4)
            assertTrue(events.stoppedLatch.await(10000))
            return events.verified
        }
        assertEquals<Pair<Boolean, Float>?>(true to 0f, run(floatArrayOf(1f, 0f), 10)) // under 1 s: too short, fails open
        assertEquals<Pair<Boolean, Float>?>(true to 0f, run(null, 30))                 // no embedding: fails open
        assertEquals<Pair<Boolean, Float>?>(true to 0f, run(floatArrayOf(1f), 30))     // dimension mismatch: fails open
        assertEquals<Pair<Boolean, Float>?>(true to 1f, run(floatArrayOf(1f, 0f), 30))
        assertEquals<Pair<Boolean, Float>?>(false to 0f, run(floatArrayOf(0f, 1f), 30))
    }

    @Test
    fun missingModelReportsAndStops() {
        val host = FakeHost(testPlatform(), mic = ScriptedMic(emptyList()), hasModel = false)
        val events = Events()
        val session = session(host, testPlatform(), "voice-test-nomodel")
        session.setListener(events)
        session.setUsePhoneMic(true)
        session.start("onboard", 9)
        assertTrue(events.stoppedLatch.await(5000))
        assertEquals<List<String?>>(listOf("Voice model not downloaded (see Settings > Voice)."), events.statuses)
        assertEquals(listOf(9), events.stopped)
        assertEquals("1.50", formatFixed(1.5, 2))
        assertEquals("-0.333", formatFixed(-1.0 / 3, 3))
        assertEquals("0", formatFixed(0.4, 0))
    }
}
