package com.faceclaw.app

/**
 * Phone-side model of the CFW's flat 256 KiB texture cache (zlib_glue mode 18). The firmware holds
 * only bytes; every structural decision — where font tables and glyph images live, what is
 * resident, when to start over — is made here. Layout per font: a 96-entry uint32 offset table
 * (chars 32..127) whose entries are written lazily as each glyph is uploaded; glyph images are the
 * GlyphAtlas cached bytes ([w][h][4bpp RLE]).
 *
 * Allocation is a bump pointer with reset-on-full: the realistic working set (a few fonts' tables
 * plus ~hundreds of glyphs at tens of bytes each) is far below 256 KiB, so eviction sophistication
 * buys nothing. After a reset the firmware cache still holds stale bytes; that is safe because a
 * draw only ever references (font table entry, glyph image) pairs uploaded in the current
 * generation — stale table entries are never named in a mode-20 string.
 *
 * Upload entries accumulate as complete [offset u32][len u16][data] records and drain into one or
 * more standalone mode-18 payloads, each independently valid, enqueued ahead of the image message
 * that references them (the transport is FIFO, so no ack round-trip is needed before use).
 *
 * Not thread-safe by itself: the communicator calls it under its own lock.
 */
class TextureCacheState {
    companion object {
        const val CACHE_SIZE: Int = 262144

        private val FONT_TABLE_BYTES: Int = (96 * 4)
    }

    private var allocEnd: Int = 0

    private val fontTableOffsets: MutableMap<Int, Int> = HashMap()

    private val glyphOffsets: MutableMap<Long, Int> = HashMap()

    private val imageOffsets: MutableMap<Int, Int> = HashMap()

    private val pendingEntries: MutableList<ByteArray> = ArrayList()

    private var pendingBytes: Int = 0

    private var generation: Int = 0

    /**
     * Forget everything: the on-glasses cache is gone (session teardown, lease loss) or no longer
     * trustworthy (upload timeout), or we ran out of space. Glyphs and images re-upload lazily on
     * next use.
     */
    fun reset(): Unit {
        allocEnd = 0
        fontTableOffsets.clear()
        glyphOffsets.clear()
        imageOffsets.clear()
        pendingEntries.clear()
        pendingBytes = 0
        generation++
    }

    /** Bumped by every reset; lets a planner detect a mid-plan reset. */
    fun generation(): Int {
        return generation
    }

    /**
     * Bytes currently allocated out of CACHE_SIZE, for logging/tuning (a sudden drop in the frame
     * log means a reset-on-full re-upload cycle — the signal that the 256 KiB budget is being
     * outgrown).
     */
    fun usedBytes(): Int {
        return allocEnd
    }

    /**
     * The font's 96-entry table offset in the cache, or -1 when it exists but this glyph can't fit.
     */
    fun fontTableOffset(fontId: Int): Int {
        var existing: Int? = fontTableOffsets.get(fontId)
        return (if ((existing == null)) -1 else existing)
    }

    /**
     * Ensure a glyph image (and its font table slot) is resident, queuing the mode-18 upload
     * entries for anything newly placed. Returns the glyph's image offset, or -1 when the cache is
     * full (caller resets and retries) or the encoding is outside the mode-20 table (32..127).
     */
    fun ensureGlyph(fontId: Int, encoding: Int, glyph: GlyphAtlas.Glyph?): Int {
        if ((((glyph == null) || (encoding < 32)) || (encoding > 127))) {
            return -1
        }
        var key: Long = (((fontId).toLong() shl 32) or (encoding.toLong() and 0xffffffffL))
        var existing: Int? = glyphOffsets.get(key)
        if ((existing != null)) {
            return existing
        }
        var table: Int? = fontTableOffsets.get(fontId)
        var need: Int = (glyph.cachedBytes.size + (if ((table == null)) FONT_TABLE_BYTES else 0))
        if (((allocEnd + need) > CACHE_SIZE)) {
            return -1
        }
        if ((table == null)) {
            table = allocEnd
            allocEnd += FONT_TABLE_BYTES
            fontTableOffsets.put(fontId, table)
        }
        var offset: Int = allocEnd
        allocEnd += glyph.cachedBytes.size
        glyphOffsets.put(key, offset)
        addEntry(offset, glyph.cachedBytes)
        addEntry(
            (table + (4 * (encoding - 32))),
            byteArrayOf(
                (offset).toByte(),
                ((offset shr 8)).toByte(),
                ((offset shr 16)).toByte(),
                ((offset shr 24)).toByte(),
            ),
        )
        return offset
    }

    /**
     * Ensure an ImageAtlas entry is resident (mode-19 draws reference it by raw cache offset; no
     * table involved). Returns the image offset, or -1 when the cache is full (caller resets and
     * retries).
     */
    fun ensureImage(imageId: Int, image: ImageAtlas.Entry?): Int {
        if ((image == null)) {
            return -1
        }
        var existing: Int? = imageOffsets.get(imageId)
        if ((existing != null)) {
            return existing
        }
        if (((allocEnd + image.cachedBytes.size) > CACHE_SIZE)) {
            return -1
        }
        var offset: Int = allocEnd
        allocEnd += image.cachedBytes.size
        imageOffsets.put(imageId, offset)
        addEntry(offset, image.cachedBytes)
        return offset
    }

    private fun addEntry(offset: Int, data: ByteArray): Unit {
        var entry: ByteArray = ByteArray((6 + data.size))
        entry[0] = ((offset and 0xff)).toByte()
        entry[1] = (((offset shr 8) and 0xff)).toByte()
        entry[2] = (((offset shr 16) and 0xff)).toByte()
        entry[3] = (((offset shr 24) and 0xff)).toByte()
        entry[4] = ((data.size and 0xff)).toByte()
        entry[5] = (((data.size shr 8) and 0xff)).toByte()
        data.copyInto(entry, 6, 0, 0 + data.size)
        pendingEntries.add(entry)
        pendingBytes += entry.size
    }

    fun hasPendingUploads(): Boolean {
        return !pendingEntries.isEmpty()
    }

    /** Total queued upload bytes (entry framing included), for logging. */
    fun pendingUploadBytes(): Int {
        return pendingBytes
    }

    /**
     * Drain the queued entries into complete mode-18 payloads ([18][entries]), each at most
     * maxPayloadBytes so a payload fits one BLE image message without fragmentation. A single entry
     * larger than the cap still gets its own payload (the transport can fragment it).
     */
    fun drainUploadPayloads(maxPayloadBytes: Int): MutableList<ByteArray> {
        var payloads: MutableList<ByteArray> = ArrayList()
        var current: ByteSink? = null
        for (entry in pendingEntries) {
            if (((current != null) && ((current.size() + entry.size) > maxPayloadBytes))) {
                payloads.add(current.toByteArray())
                current = null
            }
            if ((current == null)) {
                current = ByteSink(minOf(maxPayloadBytes, (4 + entry.size)))
                current.write(18)
            }
            current.write(entry, 0, entry.size)
        }
        if ((current != null)) {
            payloads.add(current.toByteArray())
        }
        pendingEntries.clear()
        pendingBytes = 0
        return payloads
    }
}
