package com.faceclaw.app

import kotlin.jvm.JvmField

/**
 * A small Matroska (EBML) muxer and demuxer for audio captures (.mka): PCM16 audio tracks that
 * each have their own sample rate and channel count, UTF-8 text tracks for timed metadata, and
 * file attachments. Every block carries its own timestamp, so tracks on independent clocks and
 * gaps in a track survive in the file. See notes/mic-recording-format.md for how captures use it.
 *
 * The writer produces files standard players open (VLC, mpv, ffmpeg): known-size clusters of
 * about a second each, cues and the segment size written when the recording finishes. A
 * recording cut short by a crash is still a valid live-style stream of everything up to its last
 * complete cluster, and the reader takes it as such.
 */
internal object MatroskaIds {
    const val EBML = 0x1A45DFA3
    const val EBML_VERSION = 0x4286
    const val EBML_READ_VERSION = 0x42F7
    const val EBML_MAX_ID_LENGTH = 0x42F2
    const val EBML_MAX_SIZE_LENGTH = 0x42F3
    const val DOC_TYPE = 0x4282
    const val DOC_TYPE_VERSION = 0x4287
    const val DOC_TYPE_READ_VERSION = 0x4285
    const val VOID = 0xEC
    const val SEGMENT = 0x18538067
    const val SEEK_HEAD = 0x114D9B74
    const val SEEK = 0x4DBB
    const val SEEK_ID = 0x53AB
    const val SEEK_POSITION = 0x53AC
    const val INFO = 0x1549A966
    const val TIMESTAMP_SCALE = 0x2AD7B1
    const val DURATION = 0x4489
    const val DATE_UTC = 0x4461
    const val TITLE = 0x7BA9
    const val MUXING_APP = 0x4D80
    const val WRITING_APP = 0x5741
    const val TRACKS = 0x1654AE6B
    const val TRACK_ENTRY = 0xAE
    const val TRACK_NUMBER = 0xD7
    const val TRACK_UID = 0x73C5
    const val TRACK_TYPE = 0x83
    const val FLAG_DEFAULT = 0x88
    const val FLAG_LACING = 0x9C
    const val NAME = 0x536E
    const val LANGUAGE = 0x22B59C
    const val CODEC_ID = 0x86
    const val AUDIO = 0xE1
    const val SAMPLING_FREQUENCY = 0xB5
    const val CHANNELS = 0x9F
    const val BIT_DEPTH = 0x6264
    const val ATTACHMENTS = 0x1941A469
    const val ATTACHED_FILE = 0x61A7
    const val FILE_NAME = 0x466E
    const val FILE_MIME_TYPE = 0x4660
    const val FILE_DATA = 0x465C
    const val FILE_UID = 0x46AE
    const val CLUSTER = 0x1F43B675
    const val TIMESTAMP = 0xE7
    const val SIMPLE_BLOCK = 0xA3
    const val BLOCK_GROUP = 0xA0
    const val BLOCK = 0xA1
    const val BLOCK_DURATION = 0x9B
    const val CUES = 0x1C53BB6B
    const val CUE_POINT = 0xBB
    const val CUE_TIME = 0xB3
    const val CUE_TRACK_POSITIONS = 0xB7
    const val CUE_TRACK = 0xF7
    const val CUE_CLUSTER_POSITION = 0xF1
}

/** Builds EBML elements into a byte buffer. */
internal class EbmlWriter(capacity: Int = 256) {
    private val sink = ByteSink(capacity)

    fun size(): Int = sink.size()

    fun bytes(): ByteArray = sink.toByteArray()

    /** An element ID, written as given: its length marker is part of the value. */
    fun id(id: Int) {
        if (id > 0xFFFFFF) sink.write(id ushr 24)
        if (id > 0xFFFF) sink.write(id ushr 16)
        if (id > 0xFF) sink.write(id ushr 8)
        sink.write(id)
    }

    /** A data size in [width] bytes, or in the fewest that hold it when [width] is 0. */
    fun dataSize(size: Long, width: Int = 0) {
        var bytes = width
        if (bytes == 0) {
            bytes = 1
            // The all-ones value of each width means "unknown size".
            while (bytes < 8 && size >= (1L shl (7 * bytes)) - 1) bytes++
        }
        val marked = size or (1L shl (7 * bytes))
        for (index in bytes - 1 downTo 0) sink.write((marked ushr (8 * index)).toInt())
    }

    fun uint(id: Int, value: Long) {
        var bytes = 1
        while (bytes < 8 && (value ushr (8 * bytes)) != 0L) bytes++
        id(id)
        dataSize(bytes.toLong())
        for (index in bytes - 1 downTo 0) sink.write((value ushr (8 * index)).toInt())
    }

    /** A fixed eight-byte integer (dates). */
    fun int64(id: Int, value: Long) {
        id(id)
        dataSize(8)
        for (index in 7 downTo 0) sink.write((value ushr (8 * index)).toInt())
    }

    fun float64(id: Int, value: Double) = int64(id, value.toRawBits())

    fun string(id: Int, text: String) {
        val bytes = text.encodeToByteArray()
        binary(id, bytes, 0, bytes.size)
    }

    fun binary(id: Int, bytes: ByteArray, offset: Int, length: Int) {
        id(id)
        dataSize(length.toLong())
        sink.write(bytes, offset, length)
    }

    fun raw(bytes: ByteArray) = sink.write(bytes)

    fun raw(value: Int) = sink.write(value)

    fun master(id: Int, build: EbmlWriter.() -> Unit) {
        val child = EbmlWriter()
        child.build()
        id(id)
        dataSize(child.size().toLong())
        sink.write(child.bytes())
    }

    companion object {
        /** [element] followed by a Void element filling the rest of [reserved] bytes, or null when it doesn't fit. */
        fun padded(element: ByteArray, reserved: Int): ByteArray? {
            val filler = reserved - element.size
            // A Void element is at least two bytes.
            if (filler < 0 || filler == 1) return null
            val out = element.copyOf(reserved)
            if (filler == 0) return out
            val at = element.size
            out[at] = MatroskaIds.VOID.toByte()
            if (filler < 9) {
                out[at + 1] = (0x80 or (filler - 2)).toByte()
            } else {
                val size = (filler - 9).toLong()
                out[at + 1] = 0x01
                for (index in 0 until 7) out[at + 2 + index] = (size ushr (8 * (6 - index))).toByte()
            }
            return out
        }
    }
}

class MkaAttachment(@JvmField val name: String, @JvmField val mimeType: String, @JvmField val data: ByteArray)

/**
 * Writes one Matroska audio file. Tracks can be added at any time before the first block that
 * uses them: the track list sits in a reserved region that is rewritten in place. Timestamps are
 * milliseconds from the start of the file. Not thread-safe.
 */
class MkaWriter(
    private val output: SeekableOutput,
    title: String?,
    /** When the recording began (Unix epoch ms), for the file's date. */
    dateUtcMs: Long,
    attachments: List<MkaAttachment>,
) {
    companion object {
        const val CODEC_PCM = "A_PCM/INT/LIT"
        const val CODEC_TEXT = "S_TEXT/UTF8"
        const val TRACK_AUDIO = 2
        const val TRACK_SUBTITLE = 0x11
        const val APP_NAME = "Faceclaw"
        private const val SEEK_RESERVED = 128
        private const val TRACKS_RESERVED = 4096
        private const val CLUSTER_SPAN_MS = 1000L
        private const val CLUSTER_MAX_BYTES = 1 shl 20
        // Block timestamps are signed 16-bit offsets from their cluster's.
        private const val CLUSTER_MAX_BACKSTEP_MS = 30_000L
        private const val DURATION_PATCH_CLUSTERS = 5
        // Matroska dates count nanoseconds from 2001-01-01T00:00:00 UTC.
        private const val DATE_EPOCH_MS = 978_307_200_000L
    }

    private class Track(
        val number: Int,
        val type: Int,
        val name: String,
        val sampleRate: Int,
        val channels: Int,
        val preferred: Boolean,
    )

    private class Cue(val clusterPosition: Long, val timeMs: Long)

    private val tracks = ArrayList<Track>()
    private val cues = ArrayList<Cue>()
    private val segmentSizePosition: Long
    private val segmentStart: Long
    private val seekPosition: Long
    private val infoPosition: Long
    private val durationPosition: Long
    private val tracksPosition: Long
    private val attachmentsPosition: Long
    private var cluster: EbmlWriter? = null
    private var clusterBaseMs = 0L
    private var clustersSincePatch = 0
    private var finished = false
    private val hasAttachments = attachments.isNotEmpty()

    /** The end of the latest audio or text written, in ms from the start of the file. */
    var durationMs = 0L
        private set

    init {
        val head = EbmlWriter()
        head.master(MatroskaIds.EBML) {
            uint(MatroskaIds.EBML_VERSION, 1)
            uint(MatroskaIds.EBML_READ_VERSION, 1)
            uint(MatroskaIds.EBML_MAX_ID_LENGTH, 4)
            uint(MatroskaIds.EBML_MAX_SIZE_LENGTH, 8)
            string(MatroskaIds.DOC_TYPE, "matroska")
            uint(MatroskaIds.DOC_TYPE_VERSION, 4)
            uint(MatroskaIds.DOC_TYPE_READ_VERSION, 2)
        }
        head.id(MatroskaIds.SEGMENT)
        segmentSizePosition = head.size().toLong()
        // Unknown size (a live stream) until finish() knows it.
        head.raw(0x01)
        repeat(7) { head.raw(0xFF) }
        segmentStart = head.size().toLong()
        append(head.bytes())

        seekPosition = output.size
        infoPosition = seekPosition + SEEK_RESERVED
        val info = EbmlWriter()
        info.master(MatroskaIds.INFO) {
            uint(MatroskaIds.TIMESTAMP_SCALE, 1_000_000)
            string(MatroskaIds.MUXING_APP, APP_NAME)
            string(MatroskaIds.WRITING_APP, APP_NAME)
            int64(MatroskaIds.DATE_UTC, (dateUtcMs - DATE_EPOCH_MS) * 1_000_000)
            if (!title.isNullOrEmpty()) string(MatroskaIds.TITLE, title)
            // Last, so its eight bytes are the element's final ones.
            float64(MatroskaIds.DURATION, 0.0)
        }
        durationPosition = infoPosition + info.size() - 8
        tracksPosition = infoPosition + info.size()
        attachmentsPosition = tracksPosition + TRACKS_RESERVED

        append(seekHead(-1))
        append(info.bytes())
        append(EbmlWriter.padded(ByteArray(0), TRACKS_RESERVED)!!)
        if (attachments.isNotEmpty()) {
            val files = EbmlWriter()
            files.master(MatroskaIds.ATTACHMENTS) {
                attachments.forEachIndexed { index, file ->
                    master(MatroskaIds.ATTACHED_FILE) {
                        string(MatroskaIds.FILE_NAME, file.name)
                        string(MatroskaIds.FILE_MIME_TYPE, file.mimeType)
                        binary(MatroskaIds.FILE_DATA, file.data, 0, file.data.size)
                        uint(MatroskaIds.FILE_UID, index + 1L)
                    }
                }
            }
            append(files.bytes())
        }
    }

    private fun append(bytes: ByteArray) = output.write(bytes, 0, bytes.size)

    private fun seekHead(cuesPosition: Long): ByteArray {
        val head = EbmlWriter()
        head.master(MatroskaIds.SEEK_HEAD) {
            fun entry(id: Int, position: Long) = master(MatroskaIds.SEEK) {
                val idBytes = EbmlWriter()
                idBytes.id(id)
                binary(MatroskaIds.SEEK_ID, idBytes.bytes(), 0, idBytes.size())
                uint(MatroskaIds.SEEK_POSITION, position - segmentStart)
            }
            entry(MatroskaIds.INFO, infoPosition)
            entry(MatroskaIds.TRACKS, tracksPosition)
            if (hasAttachments) entry(MatroskaIds.ATTACHMENTS, attachmentsPosition)
            if (cuesPosition >= 0) entry(MatroskaIds.CUES, cuesPosition)
        }
        return EbmlWriter.padded(head.bytes(), SEEK_RESERVED) ?: error("seek head exceeds its reserved space")
    }

    /**
     * Adds a PCM16 little-endian audio track and returns its number, or -1 when the track list
     * is full. A [preferred] track is listed ahead of the others, and the first listed track is
     * the one players pick by default.
     */
    fun addAudioTrack(name: String, sampleRate: Int, channels: Int, preferred: Boolean): Int =
        addTrack(Track(tracks.size + 1, TRACK_AUDIO, name, sampleRate, channels, preferred))

    /** Adds a UTF-8 text track (one string per block) and returns its number, or -1 when the track list is full. */
    fun addTextTrack(name: String): Int = addTrack(Track(tracks.size + 1, TRACK_SUBTITLE, name, 0, 0, false))

    private fun addTrack(track: Track): Int {
        check(!finished) { "recording already finished" }
        // A block's track number is written in one byte.
        if (track.number > 126) return -1
        tracks.add(track)
        val region = EbmlWriter.padded(tracksElement(), TRACKS_RESERVED)
        if (region == null) {
            tracks.remove(track)
            return -1
        }
        output.writeAt(tracksPosition, region)
        return track.number
    }

    private fun listedTracks(): List<Track> =
        tracks.filter { it.type == TRACK_AUDIO && it.preferred } +
            tracks.filter { it.type == TRACK_AUDIO && !it.preferred } +
            tracks.filter { it.type != TRACK_AUDIO }

    private fun tracksElement(): ByteArray {
        val listed = listedTracks()
        val defaultTrack = listed.firstOrNull { it.type == TRACK_AUDIO }
        val out = EbmlWriter(1024)
        out.master(MatroskaIds.TRACKS) {
            for (track in listed) {
                master(MatroskaIds.TRACK_ENTRY) {
                    uint(MatroskaIds.TRACK_NUMBER, track.number.toLong())
                    uint(MatroskaIds.TRACK_UID, track.number.toLong())
                    uint(MatroskaIds.TRACK_TYPE, track.type.toLong())
                    uint(MatroskaIds.FLAG_DEFAULT, if (track === defaultTrack) 1 else 0)
                    uint(MatroskaIds.FLAG_LACING, 0)
                    string(MatroskaIds.NAME, track.name)
                    string(MatroskaIds.LANGUAGE, "und")
                    if (track.type == TRACK_AUDIO) {
                        string(MatroskaIds.CODEC_ID, CODEC_PCM)
                        master(MatroskaIds.AUDIO) {
                            float64(MatroskaIds.SAMPLING_FREQUENCY, track.sampleRate.toDouble())
                            uint(MatroskaIds.CHANNELS, track.channels.toLong())
                            uint(MatroskaIds.BIT_DEPTH, 16)
                        }
                    } else {
                        string(MatroskaIds.CODEC_ID, CODEC_TEXT)
                    }
                }
            }
        }
        return out.bytes()
    }

    private fun track(number: Int): Track = tracks.getOrNull(number - 1) ?: error("no track $number")

    /** Appends interleaved PCM16 little-endian samples to an audio track, starting at [timeMs]. */
    fun writeAudio(trackNumber: Int, timeMs: Long, pcm16le: ByteArray, offset: Int, length: Int) {
        val track = track(trackNumber)
        require(track.type == TRACK_AUDIO) { "track $trackNumber is not audio" }
        if (length <= 0) return
        val block = openCluster(timeMs)
        block.id(MatroskaIds.SIMPLE_BLOCK)
        block.dataSize(4L + length)
        blockHeader(block, trackNumber, timeMs, 0x80)
        block.raw(if (offset == 0 && length == pcm16le.size) pcm16le else pcm16le.copyOfRange(offset, offset + length))
        val frames = length / (2 * track.channels)
        noteEnd(timeMs + frames * 1000L / track.sampleRate)
    }

    /** Appends one string to a text track, shown from [timeMs] for [durationMs]. */
    fun writeText(trackNumber: Int, timeMs: Long, durationMs: Long, text: String) {
        require(track(trackNumber).type == TRACK_SUBTITLE) { "track $trackNumber is not text" }
        val bytes = text.encodeToByteArray()
        val block = openCluster(timeMs)
        block.master(MatroskaIds.BLOCK_GROUP) {
            id(MatroskaIds.BLOCK)
            dataSize(4L + bytes.size)
            blockHeader(this, trackNumber, timeMs, 0)
            raw(bytes)
            uint(MatroskaIds.BLOCK_DURATION, maxOf(1L, durationMs))
        }
        noteEnd(timeMs + maxOf(1L, durationMs))
    }

    private fun blockHeader(block: EbmlWriter, trackNumber: Int, timeMs: Long, flags: Int) {
        val relative = (maxOf(0L, timeMs) - clusterBaseMs).toInt()
        block.raw(0x80 or trackNumber)
        block.raw(relative shr 8)
        block.raw(relative)
        block.raw(flags)
    }

    private fun noteEnd(endMs: Long) {
        if (endMs > durationMs) durationMs = endMs
    }

    /** The cluster a block at [timeMs] goes in: the open one, or a new one once that is full or too far away in time. */
    private fun openCluster(timeMs: Long): EbmlWriter {
        check(!finished) { "recording already finished" }
        val time = maxOf(0L, timeMs)
        val open = cluster
        if (open != null) {
            val relative = time - clusterBaseMs
            if (relative < CLUSTER_SPAN_MS && relative > -CLUSTER_MAX_BACKSTEP_MS && open.size() < CLUSTER_MAX_BYTES) return open
            flushCluster()
        }
        clusterBaseMs = time
        return EbmlWriter(64 * 1024).also { cluster = it }
    }

    private fun flushCluster() {
        val body = cluster ?: return
        cluster = null
        if (body.size() == 0) return
        val timestamp = EbmlWriter(16)
        timestamp.uint(MatroskaIds.TIMESTAMP, clusterBaseMs)
        val header = EbmlWriter(32)
        header.id(MatroskaIds.CLUSTER)
        header.dataSize(timestamp.size().toLong() + body.size())
        header.raw(timestamp.bytes())
        cues.add(Cue(output.size - segmentStart, clusterBaseMs))
        append(header.bytes())
        append(body.bytes())
        if (++clustersSincePatch >= DURATION_PATCH_CLUSTERS) patchDuration()
    }

    private fun patchDuration() {
        clustersSincePatch = 0
        val value = durationMs.toDouble().toRawBits()
        output.writeAt(durationPosition, ByteArray(8) { (value ushr (8 * (7 - it))).toByte() })
    }

    /** Writes what is buffered, then the cues, duration and segment size, and closes the file. */
    fun finish() {
        if (finished) return
        try {
            flushCluster()
            finished = true
            val cuesPosition = output.size
            val cueTrack = listedTracks().firstOrNull()?.number ?: 1
            if (cues.isNotEmpty()) {
                val index = EbmlWriter(cues.size * 16 + 16)
                index.master(MatroskaIds.CUES) {
                    for (cue in cues) {
                        master(MatroskaIds.CUE_POINT) {
                            uint(MatroskaIds.CUE_TIME, cue.timeMs)
                            master(MatroskaIds.CUE_TRACK_POSITIONS) {
                                uint(MatroskaIds.CUE_TRACK, cueTrack.toLong())
                                uint(MatroskaIds.CUE_CLUSTER_POSITION, cue.clusterPosition)
                            }
                        }
                    }
                }
                append(index.bytes())
                output.writeAt(seekPosition, seekHead(cuesPosition))
            }
            patchDuration()
            val size = EbmlWriter(8)
            size.dataSize(output.size - segmentStart, 8)
            output.writeAt(segmentSizePosition, size.bytes())
        } finally {
            finished = true
            output.close()
        }
    }
}

class MkaTrackInfo(
    @JvmField val number: Int,
    /** [MkaWriter.TRACK_AUDIO], [MkaWriter.TRACK_SUBTITLE] or another Matroska track type. */
    @JvmField val type: Int,
    @JvmField val codecId: String,
    @JvmField val name: String,
    @JvmField val sampleRate: Int,
    @JvmField val channels: Int,
    @JvmField val bitDepth: Int,
) {
    val isPcm16: Boolean get() = type == MkaWriter.TRACK_AUDIO && codecId == MkaWriter.CODEC_PCM && bitDepth == 16
}

class MkaBlock(
    @JvmField val track: Int,
    @JvmField val timeMs: Long,
    @JvmField val data: ByteArray,
    /** From the block's group, or -1 when the file doesn't say (audio blocks). */
    @JvmField val durationMs: Long,
)

/**
 * Reads the blocks of a Matroska file in file order, a cluster at a time. Handles what
 * [MkaWriter] and ffmpeg write for PCM audio: known-size clusters, unlaced blocks. Throws
 * IllegalArgumentException for anything that is not such a file.
 */
class MkaReader(private val input: SeekableInput) {
    private class ClusterRef(val position: Long, val size: Int, val rawTime: Long)

    private val clusters = ArrayList<ClusterRef>()
    private val trackList = ArrayList<MkaTrackInfo>()
    private val attachmentList = ArrayList<MkaAttachment>()
    private var timestampScale = 1_000_000L
    private var infoDurationMs = 0L
    private var nextCluster = 0
    private var blocks: List<MkaBlock> = emptyList()
    private var blockIndex = 0
    private var skipBeforeMs = 0L

    val tracks: List<MkaTrackInfo> get() = trackList
    val attachments: List<MkaAttachment> get() = attachmentList

    /** The end of the last audio or text in the file, in ms. */
    val durationMs: Long

    init {
        scan()
        var end = infoDurationMs
        if (clusters.isNotEmpty()) {
            for (block in readCluster(clusters.last())) end = maxOf(end, block.timeMs + blockSpanMs(block))
        }
        durationMs = end
    }

    fun track(number: Int): MkaTrackInfo? = trackList.firstOrNull { it.number == number }

    /** Continue from the first block at or after [timeMs]. */
    fun seekTo(timeMs: Long) {
        val index = clusters.indexOfLast { toMs(it.rawTime) <= timeMs }
        nextCluster = maxOf(0, index)
        blocks = emptyList()
        blockIndex = 0
        skipBeforeMs = timeMs
    }

    /** The next block, or null at the end of the file. */
    fun next(): MkaBlock? {
        while (true) {
            while (blockIndex >= blocks.size) {
                if (nextCluster >= clusters.size) return null
                blocks = readCluster(clusters[nextCluster++])
                blockIndex = 0
            }
            val block = blocks[blockIndex++]
            if (block.timeMs >= skipBeforeMs) return block
        }
    }

    fun close() = input.close()

    private fun toMs(raw: Long): Long = raw * timestampScale / 1_000_000L

    private fun blockSpanMs(block: MkaBlock): Long {
        if (block.durationMs >= 0) return block.durationMs
        val track = track(block.track) ?: return 0
        if (!track.isPcm16 || track.channels <= 0 || track.sampleRate <= 0) return 0
        return block.data.size / (2L * track.channels) * 1000L / track.sampleRate
    }

    /** An element header at [at] in [bytes]: its ID, payload size (-1 unknown) and header length; null when cut off. */
    private class Header(val id: Int, val size: Long, val length: Int)

    private fun header(bytes: ByteArray, at: Int, end: Int): Header? {
        if (at >= end) return null
        val first = bytes[at].toInt() and 0xff
        val idLength = first.countLeadingZeroBits() - 24 + 1
        if (idLength > 4 || at + idLength >= end) return null
        var id = 0
        for (index in 0 until idLength) id = (id shl 8) or (bytes[at + index].toInt() and 0xff)
        val sizeAt = at + idLength
        val sizeFirst = bytes[sizeAt].toInt() and 0xff
        val sizeLength = sizeFirst.countLeadingZeroBits() - 24 + 1
        if (sizeLength > 8 || sizeAt + sizeLength > end) return null
        var size = (sizeFirst and (0xff shr sizeLength)).toLong()
        var allOnes = size == (0xff shr sizeLength).toLong()
        for (index in 1 until sizeLength) {
            val byte = bytes[sizeAt + index].toInt() and 0xff
            if (byte != 0xff) allOnes = false
            size = (size shl 8) or byte.toLong()
        }
        return Header(id, if (allOnes) -1 else size, idLength + sizeLength)
    }

    private fun readAt(position: Long, length: Int): ByteArray {
        val buffer = ByteArray(length)
        val read = input.readAt(position, buffer, 0, length)
        return if (read == length) buffer else buffer.copyOf(maxOf(0, read))
    }

    private fun uint(bytes: ByteArray, at: Int, size: Int): Long {
        var value = 0L
        for (index in 0 until size) value = (value shl 8) or (bytes[at + index].toLong() and 0xff)
        return value
    }

    private fun float(bytes: ByteArray, at: Int, size: Int): Double = when (size) {
        4 -> Float.fromBits(uint(bytes, at, 4).toInt()).toDouble()
        8 -> Double.fromBits(uint(bytes, at, 8))
        else -> 0.0
    }

    /** Calls [visit] with the ID, payload offset and payload size of each complete child element. */
    private inline fun children(bytes: ByteArray, start: Int, end: Int, visit: (id: Int, at: Int, size: Int) -> Unit) {
        var at = start
        while (true) {
            val child = header(bytes, at, end) ?: return
            val payload = at + child.length
            if (child.size < 0 || child.size > end - payload) return
            visit(child.id, payload, child.size.toInt())
            at = payload + child.size.toInt()
        }
    }

    private fun scan() {
        val length = input.length
        val start = readAt(0, 64)
        val ebml = header(start, 0, start.size)
        require(ebml != null && ebml.id == MatroskaIds.EBML && ebml.size >= 0) { "not a Matroska file" }
        var position = ebml.length + ebml.size
        val segment = readAt(position, 12).let { header(it, 0, it.size) }
        require(segment != null && segment.id == MatroskaIds.SEGMENT) { "not a Matroska file" }
        position += segment.length
        val end = if (segment.size < 0) length else minOf(length, position + segment.size)
        while (position < end) {
            val head = readAt(position, 12)
            val element = header(head, 0, head.size) ?: break
            val payload = position + element.length
            if (element.id == MatroskaIds.CLUSTER) {
                require(element.size >= 0) { "unsupported Matroska file (clusters of unknown size)" }
                // A recording cut short ends in a partial cluster; its complete blocks still count.
                val available = minOf(element.size, end - payload)
                require(available <= Int.MAX_VALUE) { "unsupported Matroska file (oversized cluster)" }
                clusters.add(ClusterRef(payload, available.toInt(), clusterTime(payload, available.toInt())))
            } else if (element.size < 0) {
                break
            } else if (element.size <= end - payload && element.size <= 64L * 1024 * 1024) {
                when (element.id) {
                    MatroskaIds.INFO -> parseInfo(readAt(payload, element.size.toInt()))
                    MatroskaIds.TRACKS -> parseTracks(readAt(payload, element.size.toInt()))
                    MatroskaIds.ATTACHMENTS -> parseAttachments(readAt(payload, element.size.toInt()))
                }
            }
            if (element.size < 0) break
            position = payload + element.size
        }
    }

    private fun clusterTime(position: Long, size: Int): Long {
        val head = readAt(position, minOf(size, 16))
        val first = header(head, 0, head.size)
        if (first != null && first.id == MatroskaIds.TIMESTAMP && first.size in 0..8 && first.length + first.size <= head.size) {
            return uint(head, first.length, first.size.toInt())
        }
        val whole = readAt(position, size)
        var time = 0L
        children(whole, 0, whole.size) { id, at, length -> if (id == MatroskaIds.TIMESTAMP) time = uint(whole, at, length) }
        return time
    }

    private fun parseInfo(bytes: ByteArray) {
        var duration = 0.0
        children(bytes, 0, bytes.size) { id, at, size ->
            when (id) {
                MatroskaIds.TIMESTAMP_SCALE -> timestampScale = maxOf(1L, uint(bytes, at, size))
                MatroskaIds.DURATION -> duration = float(bytes, at, size)
            }
        }
        infoDurationMs = (duration * timestampScale / 1_000_000.0).toLong()
    }

    private fun parseTracks(bytes: ByteArray) {
        trackList.clear()
        children(bytes, 0, bytes.size) { id, at, size ->
            if (id == MatroskaIds.TRACK_ENTRY) {
                var number = 0
                var type = 0
                var codec = ""
                var name = ""
                var rate = 8000.0
                var channels = 1
                var depth = 0
                children(bytes, at, at + size) { field, fieldAt, fieldSize ->
                    when (field) {
                        MatroskaIds.TRACK_NUMBER -> number = uint(bytes, fieldAt, fieldSize).toInt()
                        MatroskaIds.TRACK_TYPE -> type = uint(bytes, fieldAt, fieldSize).toInt()
                        MatroskaIds.CODEC_ID -> codec = bytes.decodeToString(fieldAt, fieldAt + fieldSize).trimEnd('\u0000')
                        MatroskaIds.NAME -> name = bytes.decodeToString(fieldAt, fieldAt + fieldSize).trimEnd('\u0000')
                        MatroskaIds.AUDIO -> children(bytes, fieldAt, fieldAt + fieldSize) { audio, audioAt, audioSize ->
                            when (audio) {
                                MatroskaIds.SAMPLING_FREQUENCY -> rate = float(bytes, audioAt, audioSize)
                                MatroskaIds.CHANNELS -> channels = uint(bytes, audioAt, audioSize).toInt()
                                MatroskaIds.BIT_DEPTH -> depth = uint(bytes, audioAt, audioSize).toInt()
                            }
                        }
                    }
                }
                val audio = type == MkaWriter.TRACK_AUDIO
                trackList.add(
                    MkaTrackInfo(number, type, codec, name, if (audio) rate.toInt() else 0, if (audio) channels else 0, if (audio) depth else 0),
                )
            }
        }
    }

    private fun parseAttachments(bytes: ByteArray) {
        children(bytes, 0, bytes.size) { id, at, size ->
            if (id == MatroskaIds.ATTACHED_FILE) {
                var name = ""
                var mime = ""
                var data = ByteArray(0)
                children(bytes, at, at + size) { field, fieldAt, fieldSize ->
                    when (field) {
                        MatroskaIds.FILE_NAME -> name = bytes.decodeToString(fieldAt, fieldAt + fieldSize)
                        MatroskaIds.FILE_MIME_TYPE -> mime = bytes.decodeToString(fieldAt, fieldAt + fieldSize)
                        MatroskaIds.FILE_DATA -> data = bytes.copyOfRange(fieldAt, fieldAt + fieldSize)
                    }
                }
                attachmentList.add(MkaAttachment(name, mime, data))
            }
        }
    }

    private fun readCluster(cluster: ClusterRef): List<MkaBlock> {
        val bytes = readAt(cluster.position, cluster.size)
        val out = ArrayList<MkaBlock>()
        var clusterRaw = cluster.rawTime
        children(bytes, 0, bytes.size) { id, at, size ->
            when (id) {
                MatroskaIds.TIMESTAMP -> clusterRaw = uint(bytes, at, size)
                MatroskaIds.SIMPLE_BLOCK -> block(bytes, at, size, clusterRaw, -1)?.let { out.add(it) }
                MatroskaIds.BLOCK_GROUP -> {
                    var blockAt = -1
                    var blockSize = 0
                    var duration = -1L
                    children(bytes, at, at + size) { field, fieldAt, fieldSize ->
                        when (field) {
                            MatroskaIds.BLOCK -> {
                                blockAt = fieldAt
                                blockSize = fieldSize
                            }
                            MatroskaIds.BLOCK_DURATION -> duration = toMs(uint(bytes, fieldAt, fieldSize))
                        }
                    }
                    if (blockAt >= 0) block(bytes, blockAt, blockSize, clusterRaw, duration)?.let { out.add(it) }
                }
            }
        }
        return out
    }

    /** A block's payload: track number, 16-bit timestamp offset, flags, then the frame. Laced blocks are skipped. */
    private fun block(bytes: ByteArray, at: Int, size: Int, clusterRaw: Long, durationMs: Long): MkaBlock? {
        if (size < 4) return null
        val first = bytes[at].toInt() and 0xff
        val trackLength = first.countLeadingZeroBits() - 24 + 1
        if (trackLength > 2 || size < trackLength + 3) return null
        var track = first and (0xff shr trackLength)
        if (trackLength == 2) track = (track shl 8) or (bytes[at + 1].toInt() and 0xff)
        val head = at + trackLength
        val relative = ((bytes[head].toInt() shl 8) or (bytes[head + 1].toInt() and 0xff)).toShort().toLong()
        val flags = bytes[head + 2].toInt() and 0xff
        if (flags and 0x06 != 0) return null
        return MkaBlock(track, toMs(clusterRaw + relative), bytes.copyOfRange(head + 3, at + size), durationMs)
    }
}
