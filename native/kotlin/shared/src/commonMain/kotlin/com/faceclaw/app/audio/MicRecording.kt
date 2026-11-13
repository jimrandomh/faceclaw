package com.faceclaw.app

import kotlin.concurrent.Volatile
import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic
import kotlin.math.abs

/** Which microphones a chunk of capture audio came from. */
object MicStream {
    /** One mixed channel: the glasses' stock stream, or the phone's own microphone. */
    const val MONO = 0
    /** A temple's own microphones, on that temple's clock (channel 0 front, channel 1 rear). */
    const val LEFT = 1
    const val RIGHT = 2
    /** The mono feed derived from the temples for speech recognition: recorded, never replayed. */
    const val MIX = 3
    const val COUNT = 4

    /** The stream's name in frame metadata. */
    @JvmStatic
    fun key(stream: Int): String = when (stream) {
        MONO -> "mic"
        LEFT -> "left"
        RIGHT -> "right"
        else -> "mix"
    }

    /** The name of the stream's audio tracks in a recording. */
    @JvmStatic
    fun trackName(stream: Int): String = when (stream) {
        MONO -> "mic"
        LEFT -> "left temple"
        RIGHT -> "right temple"
        else -> "mix"
    }

    /** The stream a recording's track or metadata names, or -1. */
    @JvmStatic
    fun named(name: String): Int = (0 until COUNT).firstOrNull { trackName(it) == name || key(it) == name } ?: -1
}

/**
 * One chunk of microphone audio as a capture source delivered it (about 50 ms), before any
 * processing. Live captures, recordings and replays all trade in these.
 */
class MicChunk(
    @JvmField val stream: Int,
    @JvmField val channels: Int,
    @JvmField val sampleRate: Int,
    /** Interleaved PCM16; the first [frames] sample frames are the chunk. */
    @JvmField val pcm: ShortArray,
    @JvmField val frames: Int,
    /** When the chunk arrived: the phone's monotonic clock for a live capture, the offset into the file for a replay. */
    @JvmField val timeMs: Long,
) {
    /** Whether the source reported a direction of arrival with the chunk. */
    @JvmField var hasDirection = false
    @JvmField var angleDegrees = 0
    @JvmField var ssr = 0
    /** The source's packet counter, or -1 when it has none. */
    @JvmField var sequence = -1
    /** The source's own clock when it captured the chunk (unsigned 32-bit ms), or -1 when it has none. */
    @JvmField var deviceTickMs = -1L
    /** Whose clock [deviceTickMs] is on: the stream the samples were captured by. */
    @JvmField var clockStream = stream
    /** The source cut the chunk short of what it captured. */
    @JvmField var truncated = false
    /** Sample frames known to be missing between the previous chunk of this stream and this one. */
    @JvmField var lostFramesBefore = 0

    val durationMs: Long get() = frames * 1000L / sampleRate
}

/**
 * Derives the mono feed speech recognition hears from the temples' chunks. This is the seam for
 * array processing (beamforming, noise cancellation): replays feed it the recorded chunks with
 * the times they first arrived at, so an implementation that decides from the chunks alone
 * behaves the same on a replay as it did live.
 */
interface MicArrayMixer {
    /** The mono chunk [chunk] contributes to the feed, or null when it contributes nothing. */
    fun mix(chunk: MicChunk): MicChunk?

    fun reset()
}

/**
 * The feed is one temple at a time, its microphones averaged (the firmware's own stock downmix).
 * The temples sample on independent clocks, so their audio is never summed. The left temple
 * feeds whenever it is streaming; the right one stands in while it is not.
 */
class SingleTempleMixer : MicArrayMixer {
    companion object {
        /** A temple that has delivered nothing for this long no longer counts as streaming. */
        const val SILENT_MS = 300L
    }

    private var leftAtMs = Long.MIN_VALUE

    override fun reset() {
        leftAtMs = Long.MIN_VALUE
    }

    override fun mix(chunk: MicChunk): MicChunk? {
        if (chunk.stream == MicStream.LEFT) {
            leftAtMs = chunk.timeMs
        } else if (chunk.stream != MicStream.RIGHT || (leftAtMs != Long.MIN_VALUE && chunk.timeMs - leftAtMs < SILENT_MS)) {
            return null
        }
        val channels = chunk.channels
        val mono = ShortArray(chunk.frames)
        for (frame in 0 until chunk.frames) {
            var sum = 0
            for (channel in 0 until channels) sum += chunk.pcm[frame * channels + channel]
            mono[frame] = (sum / channels).toShort()
        }
        val out = MicChunk(MicStream.MIX, 1, chunk.sampleRate, mono, chunk.frames, chunk.timeMs)
        out.hasDirection = chunk.hasDirection
        out.angleDegrees = chunk.angleDegrees
        out.ssr = chunk.ssr
        out.deviceTickMs = chunk.deviceTickMs
        out.clockStream = chunk.stream
        out.truncated = chunk.truncated
        return out
    }
}

/**
 * Records a capture's chunks to a Matroska audio file (.mka), one PCM16 track per stream and
 * layout as each first appears, plus a "frames" text track with one JSON object per chunk that
 * has metadata, written just ahead of the chunk's audio. Format: notes/mic-recording-format.md.
 *
 * Block timestamps are capture times, not arrival times. A stream's own clock (a temple's tick,
 * or the count of samples from a source without one) says how far apart its chunks were
 * captured; the least-delayed recent arrival places that clock on the file's timeline. So a
 * chunk held up over Bluetooth still lands where it was captured, and lost audio leaves a gap.
 *
 * Safe to share between the capture thread and whoever finishes the recording.
 */
class MicRecordingWriter(
    output: SeekableOutput,
    /** A JSON document describing the capture, stored as the file's "capture.json" attachment. */
    configJson: String?,
    /** When the recording began (Unix epoch ms). */
    startedAtMs: Long,
    platform: ProtocolPlatform = protocolPlatform(),
    private val logWarn: (String) -> Unit = { PlatformLog.w("FaceclawMicRecording", it) },
) {
    companion object {
        const val CONFIG_ATTACHMENT = "capture.json"
        const val META_TRACK = "frames"
        /** How far a chunk's arrival may sit from where its stream's clock puts it before the clock is re-placed. */
        const val DISCONTINUITY_MS = 5000L
        private const val WINDOW_BUCKETS = 8
        private const val BUCKET_MS = 1000L
    }

    /**
     * Places one track's chunks on the file's timeline. `source` time is the stream's own clock
     * since this clock was anchored; the offset from it to arrival time is taken as the least
     * seen over the last few seconds, which is the least-delayed delivery.
     */
    private class TrackClock(val number: Int, val sampleRate: Int) {
        private var anchored = false
        private var clockStream = -1
        private var tickBase = -1L
        private var lastTick = -1L
        private var frames = 0L
        private val minima = LongArray(WINDOW_BUCKETS)
        private var bucket = 0
        private var bucketStartMs = 0L
        var endMs = Long.MIN_VALUE
            private set

        fun reset() {
            anchored = false
        }

        private fun offset(): Long = minima.min()

        fun stamp(chunk: MicChunk): Long {
            val arrival = chunk.timeMs
            val ticked = chunk.deviceTickMs >= 0
            if (anchored) {
                // Another clock (the feed moved to the other temple), or this one restarted.
                if (chunk.clockStream != clockStream || ticked != (tickBase >= 0)) anchored = false
                else if (ticked && (chunk.deviceTickMs - lastTick).toInt() < 0) anchored = false
            }
            var anchorNow = !anchored
            var source = 0L
            if (anchored) {
                frames += chunk.lostFramesBefore
                source = sourceTime(chunk)
                if (abs(arrival - source - offset()) > DISCONTINUITY_MS) anchorNow = true
            }
            if (anchorNow) {
                anchored = true
                clockStream = chunk.clockStream
                tickBase = if (ticked) chunk.deviceTickMs else -1L
                frames = 0
                minima.fill(Long.MAX_VALUE)
                bucket = 0
                bucketStartMs = arrival
                source = 0
            }
            if (arrival - bucketStartMs >= BUCKET_MS) {
                bucket = (bucket + 1) % WINDOW_BUCKETS
                minima[bucket] = Long.MAX_VALUE
                bucketStartMs = arrival
            }
            if (arrival - source < minima[bucket]) minima[bucket] = arrival - source
            // Never before the end of the track's previous block.
            val time = maxOf(source + offset(), endMs)
            frames += chunk.frames
            lastTick = chunk.deviceTickMs
            endMs = time + chunk.durationMs
            return time
        }

        private fun sourceTime(chunk: MicChunk): Long =
            if (tickBase >= 0) (chunk.deviceTickMs - tickBase) and 0xffffffffL else frames * 1000L / sampleRate
    }

    private val lock = platform.createLock()
    private val writer: MkaWriter
    private val clocks = HashMap<Long, TrackClock>()
    private var metaTrack = 0
    private var originMs = Long.MIN_VALUE
    private var lastTimeMs = 0L
    private var closed = false

    /** The recording stopped early: the file could not be written. */
    @Volatile
    var failed = false
        private set

    init {
        val attachments = if (configJson.isNullOrEmpty()) emptyList()
        else listOf(MkaAttachment(CONFIG_ATTACHMENT, "application/json", configJson.encodeToByteArray()))
        writer = MkaWriter(output, null, startedAtMs, attachments)
    }

    /** Length of the recording so far, in ms. */
    val durationMs: Long get() = lock.withLock { writer.durationMs }

    /** Appends [chunk] to its stream's track, adding the track on its first chunk. */
    fun write(chunk: MicChunk) {
        if (chunk.frames <= 0) return
        lock.withLock {
            if (closed) return
            try {
                val clock = clockFor(chunk) ?: return
                if (originMs == Long.MIN_VALUE) originMs = chunk.timeMs
                val time = clock.stamp(chunk) - originMs
                val meta = metadata(chunk)
                if (meta != null && metaTrack > 0) writer.writeText(metaTrack, time, maxOf(1L, chunk.durationMs), meta)
                val bytes = AudioSegmentation.pcm16ToLittleEndian(chunk.pcm, 0, chunk.frames * chunk.channels)
                writer.writeAudio(clock.number, time, bytes, 0, bytes.size)
                lastTimeMs = maxOf(lastTimeMs, time)
            } catch (error: Throwable) {
                fail(error)
            }
        }
    }

    /**
     * Records a JSON object as an event at the recording's current position (a capture starting
     * over with another configuration, say), and has every stream's clock placed afresh by its
     * next chunk: what follows an event is not continuous with what came before.
     */
    fun event(json: String) {
        lock.withLock {
            if (closed) return
            try {
                for (clock in clocks.values) clock.reset()
                if (ensureMetaTrack()) writer.writeText(metaTrack, maxOf(lastTimeMs, writer.durationMs), 1, json)
            } catch (error: Throwable) {
                fail(error)
            }
        }
    }

    /** Completes the file. Returns the recording's length in ms. */
    fun finish(): Long {
        lock.withLock {
            if (!closed) {
                closed = true
                try {
                    writer.finish()
                } catch (error: Throwable) {
                    failed = true
                    logWarn("finishing the recording failed: ${error.message}")
                }
            }
            return writer.durationMs
        }
    }

    private fun fail(error: Throwable) {
        failed = true
        closed = true
        logWarn("recording stopped: ${error.message}")
        try {
            writer.finish()
        } catch (ignored: Throwable) {
            // The file is whatever made it to disk.
        }
    }

    private fun ensureMetaTrack(): Boolean {
        if (metaTrack == 0) metaTrack = writer.addTextTrack(META_TRACK)
        return metaTrack > 0
    }

    private fun clockFor(chunk: MicChunk): TrackClock? {
        val key = (chunk.stream.toLong() shl 48) or (chunk.channels.toLong() shl 32) or chunk.sampleRate.toLong()
        clocks[key]?.let { return it }
        // The frames track goes in with the first audio track, so it is there for that track's first chunk.
        ensureMetaTrack()
        // The mixed streams are what a player should pick; a temple's raw pair is for analysis.
        val preferred = chunk.stream == MicStream.MONO || chunk.stream == MicStream.MIX
        val number = writer.addAudioTrack(MicStream.trackName(chunk.stream), chunk.sampleRate, chunk.channels, preferred)
        if (number <= 0) {
            logWarn("recording has no room for another track; dropping ${MicStream.trackName(chunk.stream)} audio")
            return null
        }
        return TrackClock(number, chunk.sampleRate).also { clocks[key] = it }
    }

    /** The chunk's frame-metadata JSON, or null when it has nothing to say beyond its audio. */
    private fun metadata(chunk: MicChunk): String? {
        if (chunk.stream == MicStream.MIX) return null
        if (!chunk.hasDirection && chunk.sequence < 0 && chunk.deviceTickMs < 0 && !chunk.truncated && chunk.lostFramesBefore == 0) return null
        val text = StringBuilder(96)
        text.append("{\"s\":\"").append(MicStream.key(chunk.stream)).append("\",\"rx\":").append(chunk.timeMs - originMs)
        if (chunk.sequence >= 0) text.append(",\"seq\":").append(chunk.sequence)
        if (chunk.deviceTickMs >= 0) text.append(",\"tick\":").append(chunk.deviceTickMs)
        if (chunk.hasDirection) text.append(",\"angle\":").append(chunk.angleDegrees).append(",\"ssr\":").append(chunk.ssr)
        if (chunk.truncated) text.append(",\"trunc\":true")
        if (chunk.lostFramesBefore > 0) text.append(",\"lost\":").append(chunk.lostFramesBefore)
        return text.append('}').toString()
    }
}

/**
 * Reads a recording back as the chunks its capture delivered: the "mic" track as [MicStream.MONO]
 * chunks and the temple tracks as [MicStream.LEFT] / [MicStream.RIGHT] ones, each with the
 * metadata its frame carried. The "mix" track is skipped: a replay derives the feed again. A
 * Matroska file from elsewhere plays its first PCM16 track as the mono microphone.
 *
 * Throws IllegalArgumentException when the file has no audio a replay can use.
 */
class MicRecordingReader(input: SeekableInput) {
    companion object {
        const val SAMPLE_RATE = 16000
        /** Blocks longer than this many frames are handed out in pieces, like a live capture's chunks. */
        const val MAX_CHUNK_FRAMES = SAMPLE_RATE / 20
    }

    private class Meta(val timeMs: Long, val fields: Map<String, Any?>)

    private val reader = MkaReader(input)
    private val streams = HashMap<Int, Int>()
    private var metaTrack = -1
    private val pendingMeta = arrayOfNulls<Meta>(MicStream.COUNT)
    private val queued = ArrayDeque<MicChunk>()

    val durationMs: Long get() = reader.durationMs

    /** The capture's "capture.json" attachment, or null. */
    val configJson: String? =
        reader.attachments.firstOrNull { it.name == MicRecordingWriter.CONFIG_ATTACHMENT }?.data?.decodeToString()

    /** What the replay plays, for a status line: "left temple 2ch + right temple 2ch". */
    val description: String

    init {
        try {
            val audio = reader.tracks.filter { it.isPcm16 && it.channels in 1..8 }
            for (track in audio) {
                val stream = MicStream.named(track.name)
                if (stream == MicStream.MONO || stream == MicStream.LEFT || stream == MicStream.RIGHT) streams[track.number] = stream
            }
            if (streams.isEmpty()) {
                // Not one of ours: its first usable track stands in for the microphone.
                val first = audio.firstOrNull { MicStream.named(it.name) != MicStream.MIX } ?: audio.firstOrNull()
                require(first != null) { "no 16-bit PCM audio track" }
                streams[first.number] = MicStream.MONO
            }
            for (number in streams.keys) {
                val rate = reader.track(number)!!.sampleRate
                require(rate == SAMPLE_RATE) { "unsupported sample rate ($rate Hz; replay needs ${SAMPLE_RATE / 1000} kHz)" }
            }
            metaTrack = reader.tracks.firstOrNull {
                it.type == MkaWriter.TRACK_SUBTITLE && it.name == MicRecordingWriter.META_TRACK
            }?.number ?: -1
            description = streams.entries.sortedBy { it.value }.joinToString(" + ") { (number, stream) ->
                val channels = reader.track(number)!!.channels
                MicStream.trackName(stream) + if (channels > 1 || stream != MicStream.MONO) " ${channels}ch" else ""
            }
        } catch (error: Throwable) {
            reader.close()
            throw error
        }
    }

    /** Continue from the first chunk at or after [timeMs]. */
    fun seekTo(timeMs: Long) {
        queued.clear()
        pendingMeta.fill(null)
        reader.seekTo(timeMs)
    }

    /** The next chunk in file order, or null at the end. */
    fun next(): MicChunk? {
        while (queued.isEmpty()) {
            val block = reader.next() ?: return null
            if (block.track == metaTrack) {
                noteMeta(block)
                continue
            }
            val stream = streams[block.track] ?: continue
            val track = reader.track(block.track) ?: continue
            queueChunks(block, stream, track)
        }
        return queued.removeFirst()
    }

    fun close() = reader.close()

    private fun noteMeta(block: MkaBlock) {
        try {
            val fields = Json.parseObject(block.data.decodeToString())
            val stream = MicStream.named(fields["s"].asString() ?: return)
            if (stream >= 0) pendingMeta[stream] = Meta(block.timeMs, fields)
        } catch (ignored: Throwable) {
            // An event or a frame we can't read: the audio plays without it.
        }
    }

    private fun queueChunks(block: MkaBlock, stream: Int, track: MkaTrackInfo) {
        val sourceChannels = track.channels
        val totalFrames = block.data.size / (2 * sourceChannels)
        if (totalFrames <= 0) return
        // The mixed microphone is one channel however a foreign file stored it.
        val channels = if (stream == MicStream.MONO) 1 else sourceChannels
        val meta = pendingMeta[stream]?.takeIf { it.timeMs == block.timeMs }
        pendingMeta[stream] = null
        var start = 0
        while (start < totalFrames) {
            val frames = minOf(MAX_CHUNK_FRAMES, totalFrames - start)
            val pcm = ShortArray(frames * channels)
            for (frame in 0 until frames) {
                val at = (start + frame) * sourceChannels * 2
                if (channels == sourceChannels) {
                    for (channel in 0 until channels) {
                        pcm[frame * channels + channel] = AudioSegmentation.pcm16le(block.data[at + channel * 2], block.data[at + channel * 2 + 1])
                    }
                } else {
                    var sum = 0
                    for (channel in 0 until sourceChannels) sum += AudioSegmentation.pcm16le(block.data[at + channel * 2], block.data[at + channel * 2 + 1])
                    pcm[frame] = (sum / sourceChannels).toShort()
                }
            }
            val chunk = MicChunk(stream, channels, track.sampleRate, pcm, frames, block.timeMs + start * 1000L / track.sampleRate)
            if (meta != null && start == 0) applyMeta(chunk, meta.fields)
            queued.addLast(chunk)
            start += frames
        }
    }

    private fun applyMeta(chunk: MicChunk, fields: Map<String, Any?>) {
        chunk.sequence = fields["seq"].asInt() ?: -1
        chunk.deviceTickMs = fields["tick"].asLong() ?: -1L
        val angle = fields["angle"].asInt()
        if (angle != null) {
            chunk.hasDirection = true
            chunk.angleDegrees = angle
            chunk.ssr = fields["ssr"].asInt() ?: 0
        }
        chunk.truncated = fields["trunc"].asBoolean() ?: false
        chunk.lostFramesBefore = fields["lost"].asInt() ?: 0
    }
}
