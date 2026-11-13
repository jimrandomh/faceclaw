package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** A file held in memory: written through [SeekableOutput], read back through [input]. */
internal class MemoryFile : SeekableOutput {
    var bytes = ByteArray(0)
    var closed = false
    override val size: Long get() = bytes.size.toLong()

    override fun write(bytes: ByteArray, offset: Int, length: Int) {
        this.bytes += bytes.copyOfRange(offset, offset + length)
    }

    override fun writeAt(position: Long, bytes: ByteArray) {
        bytes.copyInto(this.bytes, position.toInt())
    }

    override fun close() {
        closed = true
    }

    /** The file as it stands, or its first [length] bytes. */
    fun input(length: Int = bytes.size): SeekableInput {
        val snapshot = bytes.copyOf(length)
        return object : SeekableInput {
            override val length = snapshot.size.toLong()

            override fun readAt(position: Long, buffer: ByteArray, offset: Int, length: Int): Int {
                val count = minOf(length.toLong(), maxOf(0L, snapshot.size - position)).toInt()
                snapshot.copyInto(buffer, offset, position.toInt(), position.toInt() + count)
                return count
            }

            override fun close() {}
        }
    }
}

private fun pcmBytes(frames: Int, channels: Int, value: Int): ByteArray =
    AudioSegmentation.pcm16ToLittleEndian(ShortArray(frames * channels) { value.toShort() }, 0, frames * channels)

private fun chunk(stream: Int, timeMs: Long, value: Int, channels: Int = 1, frames: Int = 800): MicChunk =
    MicChunk(stream, channels, 16000, ShortArray(frames * channels) { (value + it % channels).toShort() }, frames, timeMs)

private fun drain(reader: MicRecordingReader): List<MicChunk> {
    val out = ArrayList<MicChunk>()
    while (true) out.add(reader.next() ?: break)
    return out
}

class MatroskaTest {
    @Test
    fun roundTripsTracksBlocksAndAttachments() {
        val file = MemoryFile()
        val writer = MkaWriter(file, "session", 1_700_000_000_000, listOf(MkaAttachment("capture.json", "application/json", "{\"a\":1}".encodeToByteArray())))
        val temple = writer.addAudioTrack("left temple", 16000, 2, false)
        val text = writer.addTextTrack("frames")
        for (index in 0 until 30) {
            writer.writeText(text, index * 50L, 50, "{\"n\":$index}")
            writer.writeAudio(temple, index * 50L, pcmBytes(800, 2, index), 0, 3200)
        }
        // A track that first appears mid-file, and is the one players should pick.
        val mix = writer.addAudioTrack("mix", 16000, 1, true)
        for (index in 30 until 60) {
            writer.writeAudio(temple, index * 50L, pcmBytes(800, 2, index), 0, 3200)
            writer.writeAudio(mix, index * 50L, pcmBytes(800, 1, -index), 0, 1600)
        }
        assertEquals(3000L, writer.durationMs)
        writer.finish()
        assertTrue(file.closed)

        val reader = MkaReader(file.input())
        // Listed with the preferred audio track first, then the others, then text; numbers are as added.
        assertEquals(listOf("mix", "left temple", "frames"), reader.tracks.map { it.name })
        assertEquals(listOf(mix, temple, text), reader.tracks.map { it.number })
        val templeInfo = reader.track(temple)!!
        assertTrue(templeInfo.isPcm16)
        assertEquals(2, templeInfo.channels)
        assertEquals(16000, templeInfo.sampleRate)
        assertFalse(reader.track(text)!!.isPcm16)
        assertEquals("{\"a\":1}", reader.attachments.single().data.decodeToString())
        assertEquals("application/json", reader.attachments.single().mimeType)
        assertEquals(3000L, reader.durationMs)

        val blocks = ArrayList<MkaBlock>()
        while (true) blocks.add(reader.next() ?: break)
        assertEquals(30 + 60 + 30, blocks.size)
        assertEquals(text, blocks[0].track)
        assertEquals("{\"n\":0}", blocks[0].data.decodeToString())
        assertEquals(50L, blocks[0].durationMs)
        val templeBlocks = blocks.filter { it.track == temple }
        assertEquals((0 until 60).map { it * 50L }, templeBlocks.map { it.timeMs })
        assertEquals(pcmBytes(800, 2, 59).toList(), templeBlocks.last().data.toList())
        assertEquals(1500L, blocks.first { it.track == mix }.timeMs)

        reader.seekTo(2000)
        val afterSeek = ArrayList<MkaBlock>()
        while (true) afterSeek.add(reader.next() ?: break)
        assertEquals(2000L, afterSeek.first().timeMs)
        assertEquals(40, afterSeek.size)
        reader.seekTo(99_000)
        assertNull(reader.next())
    }

    @Test
    fun recordingCutShortIsReadableUpToItsLastCompleteBlock() {
        val file = MemoryFile()
        val writer = MkaWriter(file, null, 0, emptyList())
        val track = writer.addAudioTrack("mic", 16000, 1, true)
        // 2.5 s: clusters of a second each reach the file as they fill; the last half-second is still buffered.
        for (index in 0 until 50) writer.writeAudio(track, index * 50L, pcmBytes(800, 1, index), 0, 1600)
        val whole = MkaReader(file.input())
        assertEquals("mic", whole.tracks.single().name)
        var count = 0
        while (whole.next() != null) count++
        assertEquals(40, count)
        assertEquals(2000L, whole.durationMs)
        // A crash mid-write tears the last cluster: its complete blocks still read.
        val torn = MkaReader(file.input(file.bytes.size - 1000))
        count = 0
        while (torn.next() != null) count++
        assertEquals(39, count)
        assertEquals(1950L, torn.durationMs)
    }

    @Test
    fun rejectsOtherFiles() {
        val wav = MemoryFile()
        wav.write(BinaryEncoding.wavHeader(0, 16000, 1), 0, 44)
        assertFailsWith<IllegalArgumentException> { MkaReader(wav.input()) }
        assertFailsWith<IllegalArgumentException> { MkaReader(MemoryFile().input()) }
    }

    @Test
    fun paddedRegionsFillTheirReservedSpaceWithAVoidElement() {
        assertNull(EbmlWriter.padded(ByteArray(10), 9))
        assertNull(EbmlWriter.padded(ByteArray(10), 11))
        assertEquals(listOf(1, 2, 0xEC, 0x80), EbmlWriter.padded(byteArrayOf(1, 2), 4)!!.map { it.toInt() and 0xff })
        val long = EbmlWriter.padded(ByteArray(0), 300)!!
        assertEquals(300, long.size)
        // An eight-byte size field: 300 - 9 = 0x123.
        assertEquals(listOf(0xEC, 0x01, 0, 0, 0, 0, 0, 0x01, 0x23), long.take(9).map { it.toInt() and 0xff })
    }
}

class MicRecordingTest {
    private val warnings = mutableListOf<String>()

    private fun recorder(file: MemoryFile, config: String? = "{\"mics\":4}") =
        MicRecordingWriter(file, config, 1_700_000_000_000, testPlatform()) { warnings.add(it) }

    @Test
    fun recordsEveryStreamWithItsMetadataAndReplaysTheSources() {
        val file = MemoryFile()
        val writer = recorder(file)
        for (index in 0 until 4) {
            val left = chunk(MicStream.LEFT, 5000 + index * 50L, 100 + index, channels = 2)
            left.sequence = 7 + index
            left.deviceTickMs = 900_000 + index * 50L
            left.hasDirection = true
            left.angleDegrees = -12
            left.ssr = 40
            left.truncated = index == 3
            writer.write(left)
            val feed = SingleTempleMixer().mix(left)!!
            writer.write(feed)
            val right = chunk(MicStream.RIGHT, 5010 + index * 50L, 200 + index, channels = 2)
            right.sequence = 3 + index
            right.deviceTickMs = 40_000 + index * 50L
            writer.write(right)
        }
        // The capture went back to the mixed stream part-way through.
        writer.event("{\"event\":\"capture\",\"mics\":1}")
        val mono = chunk(MicStream.MONO, 5200, 55)
        mono.hasDirection = true
        mono.angleDegrees = 30
        mono.ssr = 9
        writer.write(mono)
        assertEquals(250L, writer.finish())
        assertFalse(writer.failed)
        assertTrue(warnings.isEmpty(), warnings.toString())

        val mka = MkaReader(file.input())
        // What a player picks by default is a mixed track.
        assertEquals(listOf("mix", "mic", "left temple", "right temple", "frames"), mka.tracks.map { it.name })

        val reader = MicRecordingReader(file.input())
        assertEquals("{\"mics\":4}", reader.configJson)
        assertEquals("mic + left temple 2ch + right temple 2ch", reader.description)
        assertEquals(250L, reader.durationMs)
        val chunks = drain(reader)
        // The mix is derived again on a replay, so only the sources come back.
        assertEquals(4, chunks.count { it.stream == MicStream.LEFT })
        assertEquals(4, chunks.count { it.stream == MicStream.RIGHT })
        assertEquals(1, chunks.count { it.stream == MicStream.MONO })
        val left = chunks.filter { it.stream == MicStream.LEFT }
        assertEquals(listOf(0L, 50L, 100L, 150L), left.map { it.timeMs })
        assertEquals(listOf(7, 8, 9, 10), left.map { it.sequence })
        assertEquals(900_050L, left[1].deviceTickMs)
        assertEquals(2, left[0].channels)
        assertEquals(listOf<Short>(100, 101, 100, 101), left[0].pcm.take(4))
        assertTrue(left.all { it.hasDirection && it.angleDegrees == -12 && it.ssr == 40 })
        assertEquals(listOf(false, false, false, true), left.map { it.truncated })
        val right = chunks.filter { it.stream == MicStream.RIGHT }
        assertEquals(listOf(10L, 60L, 110L, 160L), right.map { it.timeMs })
        assertFalse(right[0].hasDirection)
        val replayedMono = chunks.single { it.stream == MicStream.MONO }
        assertEquals(200L, replayedMono.timeMs)
        assertEquals(30, replayedMono.angleDegrees)
        assertEquals(800, replayedMono.frames)

        reader.seekTo(100)
        assertEquals(100L, reader.next()!!.timeMs)
    }

    @Test
    fun chunksHeldUpInDeliveryLandWhereTheyWereCaptured() {
        val file = MemoryFile()
        val writer = recorder(file, null)
        // A temple's ticks say when each chunk was captured. The first ten arrive as captured;
        // the link then stalls for a second and delivers the next twenty at once.
        for (index in 0 until 30) {
            val arrival = if (index < 10) 1000 + index * 50L else maxOf(2500L, 1000 + index * 50L)
            val chunk = chunk(MicStream.LEFT, arrival, index)
            chunk.deviceTickMs = 77_000 + index * 50L
            writer.write(chunk)
        }
        // Two chunks were lost on the way (their ticks are skipped): a gap, not a splice.
        val late = chunk(MicStream.LEFT, 2650, 99)
        late.deviceTickMs = 77_000 + 32 * 50L
        writer.write(late)
        writer.finish()
        val times = drain(MicRecordingReader(file.input())).map { it.timeMs }
        assertEquals((0 until 30).map { it * 50L } + 1600L, times)
        assertNull(MicRecordingReader(file.input()).configJson)
    }

    @Test
    fun aSourceWithoutAClockIsPlacedBySampleCount() {
        val file = MemoryFile()
        val writer = recorder(file)
        for (index in 0 until 10) {
            // Arrivals jitter around the capture cadence; the stream's samples are contiguous.
            val jitter = if (index % 3 == 1) 30L else 0L
            writer.write(chunk(MicStream.MONO, 400 + index * 50L + jitter, index))
        }
        // The decoder reported one packet missing before this chunk.
        val afterLoss = chunk(MicStream.MONO, 400 + 11 * 50L, 11)
        afterLoss.lostFramesBefore = 800
        writer.write(afterLoss)
        // A capture that resumes much later is placed by its arrival, not spliced on.
        writer.write(chunk(MicStream.MONO, 60_000, 12))
        writer.finish()
        val chunks = drain(MicRecordingReader(file.input()))
        assertEquals((0 until 10).map { it * 50L } + 550L + 59_600L, chunks.map { it.timeMs })
        assertEquals(800, chunks[10].lostFramesBefore)
    }

    @Test
    fun aForeignFilePlaysItsFirstTrackAsTheMicrophone() {
        val file = MemoryFile()
        val mka = MkaWriter(file, null, 0, emptyList())
        val track = mka.addAudioTrack("Stereo", 16000, 2, false)
        // One long block of stereo frames [100, 300].
        val samples = ShortArray(2000 * 2) { if (it % 2 == 0) 100 else 300 }
        mka.writeAudio(track, 0, AudioSegmentation.pcm16ToLittleEndian(samples, 0, samples.size), 0, samples.size * 2)
        mka.finish()
        val reader = MicRecordingReader(file.input())
        assertEquals("mic 2ch", reader.description)
        val chunks = drain(reader)
        assertEquals(listOf(800, 800, 400), chunks.map { it.frames })
        assertEquals(listOf(0L, 50L, 100L), chunks.map { it.timeMs })
        assertTrue(chunks.all { it.stream == MicStream.MONO && it.channels == 1 && it.pcm.all { sample -> sample == 200.toShort() } })

        val fast = MemoryFile()
        val other = MkaWriter(fast, null, 0, emptyList())
        other.writeAudio(other.addAudioTrack("mic", 48000, 1, true), 0, pcmBytes(480, 1, 1), 0, 960)
        other.finish()
        val error = assertFailsWith<IllegalArgumentException> { MicRecordingReader(fast.input()) }
        assertTrue(error.message!!.contains("48000 Hz"), error.message)
    }

    @Test
    fun theFeedFollowsTheLeftTempleAndFallsBackToTheRight() {
        val mixer = SingleTempleMixer()
        // Until the left temple is heard from, the right one feeds.
        assertNotNull(mixer.mix(chunk(MicStream.RIGHT, 0, 10, channels = 2)))
        val left = chunk(MicStream.LEFT, 20, 100, channels = 2)
        left.deviceTickMs = 5
        val feed = mixer.mix(left)!!
        assertEquals(MicStream.MIX, feed.stream)
        assertEquals(1, feed.channels)
        assertEquals(800, feed.frames)
        // Channels [100, 101] average to 100.
        assertTrue(feed.pcm.all { it == 100.toShort() })
        assertEquals(MicStream.LEFT, feed.clockStream)
        assertEquals(5L, feed.deviceTickMs)
        assertNull(mixer.mix(chunk(MicStream.RIGHT, 60, 10)))
        assertNull(mixer.mix(chunk(MicStream.RIGHT, 300, 10)))
        // The left temple went quiet: the right stands in until it is back.
        assertNotNull(mixer.mix(chunk(MicStream.RIGHT, 320, 10)))
        assertNotNull(mixer.mix(chunk(MicStream.LEFT, 330, 100)))
        assertNull(mixer.mix(chunk(MicStream.RIGHT, 340, 10)))
        assertNull(mixer.mix(chunk(MicStream.MONO, 350, 10)))
    }

    @Test
    fun decodesTheTemplesStreamFrames() {
        val frame = micStreamFrame(sequence = 0x1234, tick = 0x89ABCDEFL, channels = 2, samples = shortArrayOf(1, -2, 3, -4), angle = -45, ssr = 300, truncated = true)
        val decoded = MicArrayProtocol.decodeFrame(frame)!!
        assertEquals(0x1234, decoded.sequence)
        assertEquals(0x89ABCDEFL, decoded.deviceTickMs)
        assertEquals(2, decoded.channels)
        assertEquals(16000, decoded.sampleRate)
        assertEquals(-45, decoded.angleDegrees)
        assertEquals(300, decoded.ssr)
        assertTrue(decoded.truncated)
        assertEquals(listOf<Short>(1, -2, 3, -4), MicArrayProtocol.pcm16(frame, decoded)!!.toList())
        assertNull(MicArrayProtocol.decodeFrame(ByteArray(205)))
        // A payload length beyond the packet is cut to what arrived.
        val short = frame.copyOf(frame.size - 4)
        assertEquals(listOf<Short>(1, -2), MicArrayProtocol.pcm16(short, MicArrayProtocol.decodeFrame(short)!!)!!.toList())
        assertEquals(listOf(0x4d, 0x43, 1, 4), MicArrayProtocol.control(MicArrayProtocol.OP_RENEW).map { it.toInt() })
        assertTrue(MicArrayProtocol.isConfigure(CONFIGURE_RECORD))
        assertFalse(MicArrayProtocol.isConfigure(MicArrayProtocol.control(MicArrayProtocol.OP_STOP)))
    }
}

/** A mic_control CONFIGURE record: codec front end, both mics, raw PCM16 at 16 kHz, hardware armed. */
internal val CONFIGURE_RECORD = byteArrayOf(0x4d, 0x43, 1, 1, 0, 3, 1, 0, 160.toByte(), 0, 0, 0, 2)

/** An 'SM' stream frame as a temple sends it. */
internal fun micStreamFrame(
    sequence: Int,
    tick: Long,
    channels: Int,
    samples: ShortArray,
    angle: Int = 0,
    ssr: Int = 0,
    truncated: Boolean = false,
): ByteArray {
    val payload = AudioSegmentation.pcm16ToLittleEndian(samples, 0, samples.size)
    val header = ByteArray(MicArrayProtocol.HEADER_BYTES)
    fun le16(at: Int, value: Int) {
        header[at] = value.toByte()
        header[at + 1] = (value shr 8).toByte()
    }
    header[0] = 'S'.code.toByte()
    header[1] = 'M'.code.toByte()
    header[2] = 1
    header[3] = (if (truncated) 0x82 else 0x02).toByte()
    le16(4, sequence)
    le16(6, (tick and 0xffff).toInt())
    le16(8, ((tick shr 16) and 0xffff).toInt())
    header[10] = channels.toByte()
    le16(11, 160)
    header[13] = 0
    header[14] = 1
    le16(15, angle)
    le16(17, ssr)
    le16(19, payload.size)
    return header + payload
}

class VoiceCaptureSourcesTest {
    private class Events : FaceclawVoiceControllerListener {
        val statuses = mutableListOf<String?>()
        val transcripts = mutableListOf<Pair<String?, Boolean>>()
        val pcmChunks = mutableListOf<ByteArray>()
        val replay = mutableListOf<Pair<String?, Long>>()
        val stoppedLatch = Latch(1, testPlatform())
        override fun onStatus(status: String?) { statuses.add(status) }
        override fun onTranscript(text: String?, isFinal: Boolean) { transcripts.add(text to isFinal) }
        override fun onStopped(captureId: Int) { stoppedLatch.countDown() }
        override fun onPcm(pcm16le: ByteArray?) { pcmChunks.add(pcm16le!!) }
        override fun onFrameMeta(angleDegrees: Int, ssr: Int) {}
        override fun onSpeechEnd() {}
        override fun onSpeakerVerified(isWearer: Boolean, similarity: Float) {}
        override fun onReplay(event: String?, positionMs: Long, durationMs: Long) { replay.add(event to positionMs) }
    }

    private class FakeLink : MicArrayLink {
        var listener: FaceclawAudioPacketListener? = null
        val controls = mutableListOf<String>()
        override fun startForwarding(listener: FaceclawAudioPacketListener): Boolean { this.listener = listener; return true }
        override fun stopForwarding() { listener = null }
        override fun isForwarding(): Boolean = listener != null
        override fun sendControl(record: ByteArray, label: String, rightTemple: Boolean, leftTemple: Boolean): Boolean {
            controls.add(label + ":" + record[3] + (if (leftTemple) "L" else "") + (if (rightTemple) "R" else ""))
            return true
        }
    }

    private class FakeHost(val link: FakeLink? = null, val recording: MemoryFile? = null) : VoiceCaptureHost {
        override val dispatcher = CallbackDispatcher { it() }
        override fun onSessionStarting() {}
        override fun isG2SessionReady(): Boolean = link != null
        override fun isG2AudioCaptureActive(): Boolean = link?.isForwarding() == true
        override fun g2AudioSource(): PacketAudioSource? = null
        override fun createPacketDecoder(): AudioPacketDecoder = error("no stock stream in these tests")
        override fun openPhoneMic(): PcmAudioSource? = null
        override fun hasTranscriberModel(kind: VoiceModelKind): Boolean = true
        override fun loadTranscriber(kind: VoiceModelKind): OfflineTranscriber = object : OfflineTranscriber {
            override fun recognize(samples: FloatArray, count: Int): String = "x"
            override fun release() {}
        }
        override fun speakerEmbedder(modelPath: String): SpeakerEmbedder = error("no verification in these tests")
        override fun micArrayLink(): MicArrayLink? = link
        override fun openRecording(path: String): SeekableInput = if (path == "missing") error("no such file") else recording!!.input()
    }

    private val logs = mutableListOf<String>()

    private fun session(host: VoiceCaptureHost, name: String) =
        VoiceCaptureSession(host, testPlatform(), name, { logs.add("I $it") }, { logs.add("W $it") }, { m, e -> logs.add("E $m ${e.message}") })

    private fun waitFor(timeoutMs: Long, condition: () -> Boolean): Boolean {
        val deadline = testPlatform().elapsedRealtimeMs() + timeoutMs
        while (!condition()) {
            if (testPlatform().elapsedRealtimeMs() > deadline) return false
            sleepMs(5)
        }
        return true
    }

    private fun monoRecording(chunks: Int): MemoryFile {
        val file = MemoryFile()
        val writer = MicRecordingWriter(file, null, 0, testPlatform())
        for (index in 0 until chunks) writer.write(chunk(MicStream.MONO, index * 50L, 1000 + index))
        writer.finish()
        return file
    }

    @Test
    fun micArrayCaptureArmsTheTemplesRecordsThemAndTranscribesTheFeed() {
        val link = FakeLink()
        val host = FakeHost(link)
        val events = Events()
        val session = session(host, "voice-test-array")
        val file = MemoryFile()
        val recorder = MicRecordingWriter(file, "{}", 0, testPlatform())
        session.setListener(events)
        session.setMicArray(CONFIGURE_RECORD)
        session.setRecorder(recorder)
        session.start("cloud", 1)
        assertTrue(waitFor(3000) { link.controls.isNotEmpty() })
        assertTrue(session.isCapturing())
        val listener = link.listener!!
        for (index in 0 until 5) {
            val left = ShortArray(1600) { if (it % 2 == 0) 100 else 300 }
            listener.onAudioPacket(micStreamFrame(index, 1000 + index * 50L, 2, left, angle = 20, ssr = 7), "L", 500 + index * 50L)
            listener.onAudioPacket(micStreamFrame(index, 9000 + index * 50L, 2, ShortArray(1600) { 50 }), "R", 505 + index * 50L)
        }
        // A stock-format packet from before arming took effect is not audio.
        listener.onAudioPacket(ByteArray(205), "L", 760)
        assertTrue(waitFor(3000) { events.pcmChunks.size >= 5 })
        session.stop()
        assertTrue(events.stoppedLatch.await(3000))
        assertEquals(listOf("configure:1LR"), link.controls.take(1))
        assertEquals("stop:3LR", link.controls.last())
        assertFalse(link.isForwarding())
        assertFalse(session.isCapturing())
        // The feed is the left temple's microphones averaged.
        assertEquals(5, events.pcmChunks.size)
        assertEquals(1600, events.pcmChunks[0].size)
        assertTrue(AudioSegmentation.pcm16leToFloat(events.pcmChunks[0]).all { it == 200 / 32768f })
        assertTrue(events.statuses.contains("Listening (cloud)..."))

        recorder.finish()
        assertEquals(listOf("mix", "left temple", "right temple", "frames"), MkaReader(file.input()).tracks.map { it.name })
        val recorded = drain(MicRecordingReader(file.input()))
        assertEquals(5, recorded.count { it.stream == MicStream.LEFT })
        assertEquals(5, recorded.count { it.stream == MicStream.RIGHT })
        val left = recorded.first { it.stream == MicStream.LEFT }
        assertEquals(2, left.channels)
        assertEquals(1000L, left.deviceTickMs)
        assertEquals(20, left.angleDegrees)
    }

    @Test
    fun micArrayCaptureNeedsGlassesThatHaveTheChannel() {
        val events = Events()
        val session = session(FakeHost(), "voice-test-array-none")
        session.setListener(events)
        session.setMicArray(CONFIGURE_RECORD)
        session.start("cloud", 1)
        assertEquals<List<String?>>(listOf("Voice control needs an active G2 connection."), events.statuses)
        // A record that is not a CONFIGURE leaves the capture on the mixed stream.
        val mixed = Events()
        session.setListener(mixed)
        session.setMicArray(MicArrayProtocol.control(MicArrayProtocol.OP_STOP))
        session.setUsePhoneMic(true)
        session.start("cloud", 2)
        assertTrue(mixed.stoppedLatch.await(3000))
        assertEquals<List<String?>>(listOf("Could not start the phone microphone."), mixed.statuses)
    }

    @Test
    fun replayPlaysARecordingThroughThePipelineInRealTime() {
        val host = FakeHost(recording = monoRecording(30))
        val events = Events()
        val session = session(host, "voice-test-replay")
        session.setListener(events)
        // A replay is never recorded again.
        val copy = MemoryFile()
        val recorder = MicRecordingWriter(copy, null, 0, testPlatform())
        session.setRecorder(recorder)
        session.setReplay("recording.mka", 1000)
        val startedAt = testPlatform().elapsedRealtimeMs()
        session.start("onboard", 5)
        assertTrue(events.stoppedLatch.await(5000))
        val elapsed = testPlatform().elapsedRealtimeMs() - startedAt
        // Half a second of audio, paced as it was captured.
        assertTrue(elapsed >= 400, "replay took $elapsed ms")
        assertEquals(10, events.pcmChunks.size)
        assertEquals(1020.toShort(), AudioSegmentation.pcm16le(events.pcmChunks[0][0], events.pcmChunks[0][1]))
        assertEquals("start" to 1000L, events.replay.first())
        assertEquals("end" to 1500L, events.replay.last())
        assertEquals(VoiceCaptureSession.REPLAY_FINISHED_STATUS, events.statuses.last())
        assertEquals("x" to true, events.transcripts.last())
        assertFalse(session.isCapturing())
        recorder.finish()
        assertTrue(MkaReader(copy.input()).tracks.isEmpty())
    }

    @Test
    fun replayJumpsAndPauses() {
        val host = FakeHost(recording = monoRecording(200))
        val events = Events()
        val session = session(host, "voice-test-replay-seek")
        session.setListener(events)
        session.setReplay("recording.mka", 0)
        session.start("onboard", 6)
        assertTrue(waitFor(3000) { events.pcmChunks.size >= 2 })
        session.setReplayPaused(true)
        sleepMs(100)
        val heldAt = events.pcmChunks.size
        sleepMs(200)
        assertEquals(heldAt, events.pcmChunks.size)
        assertTrue(session.isCapturing())
        // Jump to the last quarter-second while paused, then go on.
        session.seekReplay(9750)
        session.setReplayPaused(false)
        assertTrue(events.stoppedLatch.await(5000))
        assertTrue(events.replay.contains("seek" to 9750L), events.replay.toString())
        assertEquals("end" to 10_000L, events.replay.last())
        assertEquals(heldAt + 5, events.pcmChunks.size)
        // What played before the jump ended as its own utterance.
        assertEquals(2, events.transcripts.count { it.second })
        val last = events.pcmChunks.last()
        assertEquals(1199.toShort(), AudioSegmentation.pcm16le(last[0], last[1]))
    }

    @Test
    fun replayOfAnUnreadableFileReportsAndStops() {
        val events = Events()
        val session = session(FakeHost(), "voice-test-replay-missing")
        session.setListener(events)
        session.setReplay("missing", 0)
        session.start("cloud", 7)
        assertTrue(events.stoppedLatch.await(3000))
        assertEquals<List<String?>>(listOf("Could not open the recording: no such file"), events.statuses)
        assertEquals(listOf<Pair<String?, Long>>("error" to 0L), events.replay)
    }
}
