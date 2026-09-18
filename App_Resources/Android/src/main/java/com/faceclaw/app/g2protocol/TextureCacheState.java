package com.faceclaw.app;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Phone-side model of the CFW's flat 256 KiB texture cache (zlib_glue mode 18).
 * The firmware holds only bytes; every structural decision — where font
 * tables and glyph images live, what is resident, when to start over — is
 * made here. Layout per font: a 96-entry uint32 offset table (chars 32..127)
 * whose entries are written lazily as each glyph is uploaded; glyph images
 * are the GlyphAtlas cached bytes ([w][h][4bpp RLE]).
 *
 * Allocation is a bump pointer with reset-on-full: the realistic working set
 * (a few fonts' tables plus ~hundreds of glyphs at tens of bytes each) is far
 * below 256 KiB, so eviction sophistication buys nothing. After a reset the
 * firmware cache still holds stale bytes; that is safe because a draw only
 * ever references (font table entry, glyph image) pairs uploaded in the
 * current generation — stale table entries are never named in a mode-20
 * string.
 *
 * Upload entries accumulate as complete [offset u32][len u16][data] records
 * and drain into one or more standalone mode-18 payloads, each independently
 * valid, enqueued ahead of the image message that references them (the
 * transport is FIFO, so no ack round-trip is needed before use).
 *
 * Not thread-safe by itself: the communicator calls it under its own lock.
 */
public final class TextureCacheState {
    public static final int CACHE_SIZE = 262144;
    private static final int FONT_TABLE_BYTES = 96 * 4;

    private int allocEnd = 0;
    private final Map<Integer, Integer> fontTableOffsets = new HashMap<>();
    private final Map<Long, Integer> glyphOffsets = new HashMap<>();
    private final Map<Integer, Integer> imageOffsets = new HashMap<>();
    private final List<byte[]> pendingEntries = new ArrayList<>();
    private int pendingBytes = 0;
    private int generation = 0;

    /**
     * Forget everything: the on-glasses cache is gone (session teardown, lease
     * loss) or no longer trustworthy (upload timeout), or we ran out of space.
     * Glyphs and images re-upload lazily on next use.
     */
    public void reset() {
        allocEnd = 0;
        fontTableOffsets.clear();
        glyphOffsets.clear();
        imageOffsets.clear();
        pendingEntries.clear();
        pendingBytes = 0;
        generation++;
    }

    /** Bumped by every reset; lets a planner detect a mid-plan reset. */
    public int generation() {
        return generation;
    }

    /**
     * Bytes currently allocated out of CACHE_SIZE, for logging/tuning (a
     * sudden drop in the frame log means a reset-on-full re-upload cycle —
     * the signal that the 256 KiB budget is being outgrown).
     */
    public int usedBytes() {
        return allocEnd;
    }

    /** The font's 96-entry table offset in the cache, or -1 when it exists but this glyph can't fit. */
    public int fontTableOffset(int fontId) {
        Integer existing = fontTableOffsets.get(fontId);
        return existing == null ? -1 : existing;
    }

    /**
     * Ensure a glyph image (and its font table slot) is resident, queuing the
     * mode-18 upload entries for anything newly placed. Returns the glyph's
     * image offset, or -1 when the cache is full (caller resets and retries)
     * or the encoding is outside the mode-20 table (32..127).
     */
    public int ensureGlyph(int fontId, int encoding, GlyphAtlas.Glyph glyph) {
        if (glyph == null || encoding < 32 || encoding > 127) return -1;
        long key = ((long) fontId << 32) | (encoding & 0xffffffffL);
        Integer existing = glyphOffsets.get(key);
        if (existing != null) return existing;

        Integer table = fontTableOffsets.get(fontId);
        int need = glyph.cachedBytes.length + (table == null ? FONT_TABLE_BYTES : 0);
        if (allocEnd + need > CACHE_SIZE) return -1;

        if (table == null) {
            table = allocEnd;
            allocEnd += FONT_TABLE_BYTES;
            fontTableOffsets.put(fontId, table);
            // No upload for the table itself: entries are written per glyph,
            // and only uploaded entries are ever referenced by a draw.
        }
        int offset = allocEnd;
        allocEnd += glyph.cachedBytes.length;
        glyphOffsets.put(key, offset);

        addEntry(offset, glyph.cachedBytes);
        addEntry(table + 4 * (encoding - 32),
                new byte[]{(byte) offset, (byte) (offset >> 8),
                           (byte) (offset >> 16), (byte) (offset >> 24)});
        return offset;
    }

    /**
     * Ensure an ImageAtlas entry is resident (mode-19 draws reference it by
     * raw cache offset; no table involved). Returns the image offset, or -1
     * when the cache is full (caller resets and retries).
     */
    public int ensureImage(int imageId, ImageAtlas.Entry image) {
        if (image == null) return -1;
        Integer existing = imageOffsets.get(imageId);
        if (existing != null) return existing;
        if (allocEnd + image.cachedBytes.length > CACHE_SIZE) return -1;
        int offset = allocEnd;
        allocEnd += image.cachedBytes.length;
        imageOffsets.put(imageId, offset);
        addEntry(offset, image.cachedBytes);
        return offset;
    }

    private void addEntry(int offset, byte[] data) {
        byte[] entry = new byte[6 + data.length];
        entry[0] = (byte) (offset & 0xff);
        entry[1] = (byte) ((offset >> 8) & 0xff);
        entry[2] = (byte) ((offset >> 16) & 0xff);
        entry[3] = (byte) ((offset >> 24) & 0xff);
        entry[4] = (byte) (data.length & 0xff);
        entry[5] = (byte) ((data.length >> 8) & 0xff);
        System.arraycopy(data, 0, entry, 6, data.length);
        pendingEntries.add(entry);
        pendingBytes += entry.length;
    }

    public boolean hasPendingUploads() {
        return !pendingEntries.isEmpty();
    }

    /** Total queued upload bytes (entry framing included), for logging. */
    public int pendingUploadBytes() {
        return pendingBytes;
    }

    /**
     * Drain the queued entries into complete mode-18 payloads ([18][entries]),
     * each at most maxPayloadBytes so a payload fits one BLE image message
     * without fragmentation. A single entry larger than the cap still gets its
     * own payload (the transport can fragment it).
     */
    public List<byte[]> drainUploadPayloads(int maxPayloadBytes) {
        List<byte[]> payloads = new ArrayList<>();
        ByteArrayOutputStream current = null;
        for (byte[] entry : pendingEntries) {
            if (current != null && current.size() + entry.length > maxPayloadBytes) {
                payloads.add(current.toByteArray());
                current = null;
            }
            if (current == null) {
                current = new ByteArrayOutputStream(Math.min(maxPayloadBytes, 4 + entry.length));
                current.write(18);
            }
            current.write(entry, 0, entry.length);
        }
        if (current != null) {
            payloads.add(current.toByteArray());
        }
        pendingEntries.clear();
        pendingBytes = 0;
        return payloads;
    }
}
