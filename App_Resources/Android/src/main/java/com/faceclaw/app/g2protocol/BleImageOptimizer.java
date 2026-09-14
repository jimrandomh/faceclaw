package com.faceclaw.app;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.zip.Deflater;
import android.util.Log;

public final class BleImageOptimizer {
    private BleImageOptimizer() {}
    private static final String TAG = "BleImageOptimizer";

    /**
     * Split an image into fragments (packets), taking advantage of the fact that each packet can declare
     * a logical size longer than its byte payload to get free trailing zero-padding.
     *
     * Each fragment's logical size stays within maxFragmentSize, while trailing zeros inside that span can
     * be omitted from the payload.
     */
    public static List<BleProtocol.ImageFragment> planImageFragments(byte[] bmp, int maxFragmentSize) {
        return planImageFragments(bmp, maxFragmentSize, false);
    }

    public static List<BleProtocol.ImageFragment> planImageFragments(
        byte[] bmp,
        int maxFragmentSize,
        boolean reserveFinalByte
    ) {
        if (bmp == null || bmp.length == 0) {
            return Collections.singletonList(new BleProtocol.ImageFragment(0, new byte[0], 0));
        }
        if (maxFragmentSize <= 0) {
            throw new IllegalArgumentException("maxFragmentSize must be positive");
        }

        final int bulkLength = reserveFinalByte ? bmp.length - 1 : bmp.length;
        final int fragmentCount = ((bulkLength + maxFragmentSize - 1) / maxFragmentSize)
                + (bulkLength < bmp.length ? 1 : 0);
        final List<BleProtocol.ImageFragment> fragments = new ArrayList<>(fragmentCount);
        for (int index = 0; index * maxFragmentSize < bulkLength; index++) {
            int start = index * maxFragmentSize;
            int end = Math.min(start + maxFragmentSize, bulkLength);
            fragments.add(buildFragment(index, bmp, start, end));
        }
        if (bulkLength < bmp.length) {
            fragments.add(new BleProtocol.ImageFragment(
                fragments.size(),
                Arrays.copyOfRange(bmp, bulkLength, bmp.length),
                bmp.length - bulkLength
            ));
        }
        Log.i(TAG, "planImageFragments: fragments=" + fragments.size() + ", bmp.length=" + bmp.length + ", maxFragmentSize=" + maxFragmentSize);
        return fragments;
    }

    private static BleProtocol.ImageFragment buildFragment(int index, byte[] bmp, int start, int end) {
        int dataEnd = end;
        while (dataEnd > start && bmp[dataEnd - 1] == 0) {
            dataEnd -= 1;
        }
        if (dataEnd == start) {
            return new BleProtocol.ImageFragment(index, new byte[0], end - start);
        }
        return new BleProtocol.ImageFragment(
            index,
            Arrays.copyOfRange(bmp, start, dataEnd),
            end - start
        );
    }

    public static final class TileImagePlan {
        final int tileIndex;
        final BleProtocol.ImageTileOptions tile;
        // Headerless packed 4bpp frame (top-down, stride ceil(width/2)), kept for
        // the displayed-tile dedup cache. Frames are immutable by convention:
        // producers always allocate a fresh buffer, so no defensive copy here.
        public final byte[] packed;
        public final int width;
        public final int height;
        final byte[] payload;  // bytes actually streamed: mode-6 zlib(rle(4bpp))
        final int sessionId;
        List<BleProtocol.ImageFragment> fragments = Collections.emptyList();

        TileImagePlan(int tileIndex, BleProtocol.ImageTileOptions tile, byte[] packed, int width, int height, int sessionId) {
            this.tileIndex = tileIndex;
            this.tile = tile;
            this.packed = packed == null ? new byte[0] : packed;
            this.width = width;
            this.height = height;
            this.payload = maybeCompress(this.packed, width, height);
            this.sessionId = sessionId;
        }

        /**
         * Plan with an explicit wire payload (e.g. a mode-3 incremental update).
         * packed must still be the FULL new frame: it feeds the displayed-frame
         * dedup cache, which after an applied incremental equals the full frame.
         */
        TileImagePlan(int tileIndex, BleProtocol.ImageTileOptions tile, byte[] packed, int width, int height, int sessionId, byte[] payloadOverride) {
            this.tileIndex = tileIndex;
            this.tile = tile;
            this.packed = packed == null ? new byte[0] : packed;
            this.width = width;
            this.height = height;
            this.payload = payloadOverride;
            this.sessionId = sessionId;
        }
    }

    /**
     * Build a mode-3 bounding-box incremental payload, or null when a full
     * update should be sent instead (frames not comparable, or the changed
     * region spans the whole screen). Wire format:
     *   [3][left/4][top/2][width/4][height/2][fid_lo][fid_hi][zlib(rle(headerless 4bpp region))]
     * The region is top-down rows of the NEW frame, stride width/2 bytes. The
     * box is aligned so left/width are multiples of 4 pixels and top/height
     * multiples of 2 rows, letting each coordinate fit one byte and avoiding
     * 4bpp byte-boundary corner cases. Identical frames yield null too; the
     * caller's dedup check should normally catch that first.
     *
     * frameId is a little-endian uint16 the CFW uses to detect reordered,
     * skipped or duplicated deltas (its diagnostic overlay); the caller advances
     * it by 1 per emitted delta so consecutive deltas are consecutive.
     */
    /**
     * A mode-3 incremental payload plus diagnostics about how tightly the
     * bounding box fit the actual change. {@code changedBytes} is how many
     * packed bytes actually differ; {@code boxBytes} is how many the box sends.
     * A large box with few changed bytes / multiple clusters means distant
     * small edits were merged into one oversized box (which can spill past the
     * fragment size into an extra serialized BLE message).
     */
    public static final class IncrementalPlan {
        public final byte[] payload;
        public final int changedBytes;
        public final int boxBytes;
        public final int clusterCount;

        IncrementalPlan(byte[] payload, int changedBytes, int boxBytes, int clusterCount) {
            this.payload = payload;
            this.changedBytes = changedBytes;
            this.boxBytes = boxBytes;
            this.clusterCount = clusterCount;
        }
    }

    public static IncrementalPlan buildIncrementalImagePayload(byte[] previous, byte[] next, int width, int height, int frameId) {
        int stride = (width + 1) >> 1;
        if (width <= 0 || height <= 0 || previous == null || next == null
                || previous.length != stride * height || next.length != stride * height) {
            return null;
        }

        // Full diff scan in packed-byte coordinates (1 byte = 2 pixels): the
        // changed bounding box plus diagnostics (total changed bytes, and how
        // many disjoint horizontal column-clusters the change splits into).
        int minByteX = stride;
        int maxByteX = -1;
        int minY = height;
        int maxY = -1;
        int changedBytes = 0;
        boolean[] columnChanged = new boolean[stride];
        for (int y = 0; y < height; y++) {
            int rowOffset = y * stride;
            for (int x = 0; x < stride; x++) {
                if (previous[rowOffset + x] != next[rowOffset + x]) {
                    changedBytes++;
                    columnChanged[x] = true;
                    if (x < minByteX) minByteX = x;
                    if (x > maxByteX) maxByteX = x;
                    if (y < minY) minY = y;
                    maxY = y;
                }
            }
        }
        if (maxY < 0) {
            return null; // identical
        }
        int clusterCount = 0;
        boolean inCluster = false;
        for (int x = minByteX; x <= maxByteX; x++) {
            if (columnChanged[x]) {
                if (!inCluster) clusterCount++;
                inCluster = true;
            } else {
                inCluster = false;
            }
        }

        // Pixel-space box, aligned: left/width to multiples of 4, top/height to
        // multiples of 2, clamped to the frame.
        int left = (minByteX * 2) & ~3;
        int rightExclusive = Math.min(width, (((maxByteX + 1) * 2) + 3) & ~3);
        int top = minY & ~1;
        int bottomExclusive = Math.min(height, (maxY + 2) & ~1);
        int boxWidth = rightExclusive - left;
        int boxHeight = bottomExclusive - top;
        if (boxWidth >= width && boxHeight >= height) {
            return null; // whole screen changed; full update is strictly better
        }

        byte[] out = encodeMode3Rect(next, stride, left, top, boxWidth, boxHeight, frameId);
        return new IncrementalPlan(out, changedBytes, (boxWidth >> 1) * boxHeight, clusterCount);
    }

    /**
     * The aligned changed bounding box between two same-size packed frames, or
     * null when they are identical: pixel-space {left, top, width, height} with
     * left/width multiples of 4 and top/height multiples of 2 (mode-3 header
     * quantization). Exposed so the texture-cache planner can reuse the exact
     * rect geometry the single-bbox path would send.
     */
    public static int[] computeChangedBox(byte[] previous, byte[] next, int width, int height) {
        int stride = (width + 1) >> 1;
        if (width <= 0 || height <= 0 || previous == null || next == null
                || previous.length != stride * height || next.length != stride * height) {
            return null;
        }
        int minByteX = stride;
        int maxByteX = -1;
        int minY = height;
        int maxY = -1;
        for (int y = 0; y < height; y++) {
            int rowOffset = y * stride;
            for (int x = 0; x < stride; x++) {
                if (previous[rowOffset + x] != next[rowOffset + x]) {
                    if (x < minByteX) minByteX = x;
                    if (x > maxByteX) maxByteX = x;
                    if (y < minY) minY = y;
                    maxY = y;
                }
            }
        }
        if (maxY < 0) {
            return null;
        }
        int left = (minByteX * 2) & ~3;
        int rightExclusive = Math.min(width, (((maxByteX + 1) * 2) + 3) & ~3);
        int top = minY & ~1;
        int bottomExclusive = Math.min(height, (maxY + 2) & ~1);
        return new int[]{left, top, rightExclusive - left, bottomExclusive - top};
    }

    /**
     * The multi-rect split of the changed region (see computeSplitRects), or null
     * when it is one region / too fragmented / the frames aren't comparable.
     * Exposed for the texture-cache planner.
     */
    public static List<int[]> computeChangedRects(byte[] previous, byte[] next, int width, int height, int maxRects) {
        int stride = (width + 1) >> 1;
        if (width <= 0 || height <= 0 || previous == null || next == null
                || previous.length != stride * height || next.length != stride * height) {
            return null;
        }
        List<int[]> rects = computeSplitRects(previous, next, stride, width, height, maxRects);
        return (rects == null || rects.size() < 2) ? null : rects;
    }

    /**
     * Encode one CFW mode-3 rectangle delta:
     *   [3][left/4][top/2][width/4][height/2][fid_lo][fid_hi][zlib(rle(box pixels))]
     * left/width must be multiples of 4 (=> left>>1, width>>1 are whole bytes), top/
     * height multiples of 2. The box pixels are top-down rows of `next` (4bpp packed,
     * width>>1 bytes/row), run-length encoded before deflate. Shared by the single-bbox
     * path, each rect of a mode-8 multi-rect batch, and the texture-cache planner.
     */
    static byte[] encodeMode3Rect(byte[] next, int stride, int left, int top,
            int boxWidth, int boxHeight, int fid) {
        int regionStride = boxWidth >> 1;
        byte[] region = new byte[regionStride * boxHeight];
        for (int y = 0; y < boxHeight; y++) {
            System.arraycopy(next, (top + y) * stride + (left >> 1), region, y * regionStride, regionStride);
        }
        byte[] compressed = deflate(rleEncode(region));
        byte[] out = new byte[7 + compressed.length];
        out[0] = 3;
        out[1] = (byte) (left / 4);
        out[2] = (byte) (top / 2);
        out[3] = (byte) (boxWidth / 4);
        out[4] = (byte) (boxHeight / 2);
        out[5] = (byte) (fid & 0xff);          // fid_lo
        out[6] = (byte) ((fid >> 8) & 0xff);   // fid_hi
        System.arraycopy(compressed, 0, out, 7, compressed.length);
        return out;
    }

    /** A full repaint in independently decodable commands below the uint16 record limit. */
    static List<byte[]> encodeFullFrameBands(byte[] packed, int width, int height, int firstFid) {
        if (width <= 0 || width > 640 || (width & 3) != 0 || height <= 0 || height > 480
                || (height & 1) != 0 || packed.length != width * height / 2) {
            throw new IllegalArgumentException("unsupported custom framebuffer dimensions");
        }
        List<byte[]> commands = new ArrayList<>();
        int fid = firstFid;
        for (int top = 0; top < height; top += 64) {
            commands.add(encodeMode3Rect(packed, width / 2, 0, top, width,
                    Math.min(64, height - top), fid));
            fid = fid >= 0xfffe ? 1 : fid + 1;
        }
        return commands;
    }

    /**
     * A CFW mode-8 multi-segment payload (`[8][count]` then per-rect
     * `[len16][mode-3 submsg]`) carrying several tight rectangle deltas instead of
     * one bounding box, plus diagnostics. Each rect is applied to the firmware
     * shadow with the panel push deferred, then presented once. Used when the change
     * splits into regions whose bounding box wastes bytes (distant edits, or a sparse
     * box); the caller falls back to the single-rect path when this returns null or
     * isn't smaller.
     */
    public static final class MultiRectPlan {
        public final byte[] payload;
        public final int rectCount;
        public final int coveredBytes;   // sum of rect region bytes, pre-compression
        public final int nextFid;        // fid to resume from (rectCount consumed)

        MultiRectPlan(byte[] payload, int rectCount, int coveredBytes, int nextFid) {
            this.payload = payload;
            this.rectCount = rectCount;
            this.coveredBytes = coveredBytes;
            this.nextFid = nextFid;
        }
    }

    // Break-even tuning for the rect splitter. Splitting adds ~15 fixed bytes per
    // rect (seglen + mode-3 header + fid + zlib framing) and loses cross-rect
    // dictionary sharing, so only split across gaps big enough to pay for that.
    // Gaps are in the changed-mask's native units: whole 4bpp bytes (2px) for
    // columns, rows for the vertical bands. Kept above the 4px/2px box alignment so
    // aligned rects never overlap.
    private static final int MULTI_RECT_V_GAP_ROWS = 4;
    private static final int MULTI_RECT_H_GAP_BYTES = 6;

    /**
     * Build a mode-8 multi-rect payload for the change between two same-size 4bpp
     * frames, assigning consecutive frame ids starting at fidStart (each rect needs a
     * distinct fid — the CFW skips duplicate fids). Returns null when the change is a
     * single region (use the single-rect path), when it fragments past maxRects, or
     * when the frames aren't comparable.
     */
    public static MultiRectPlan buildMultiRectImagePayload(byte[] previous, byte[] next, int width, int height, int fidStart, int maxRects) {
        int stride = (width + 1) >> 1;
        if (width <= 0 || height <= 0 || previous == null || next == null
                || previous.length != stride * height || next.length != stride * height) {
            return null;
        }

        List<int[]> rects = computeSplitRects(previous, next, stride, width, height, maxRects);
        if (rects == null || rects.size() < 2) {
            return null; // single region (or too fragmented): caller uses the bbox path
        }

        List<byte[]> subs = new ArrayList<>(rects.size());
        int coveredBytes = 0;
        int fid = fidStart;
        int total = 2; // [8][count]
        for (int[] r : rects) {
            byte[] sub = encodeMode3Rect(next, stride, r[0], r[1], r[2], r[3], fid);
            subs.add(sub);
            coveredBytes += (r[2] >> 1) * r[3];
            total += 2 + sub.length; // len16 + submsg
            fid = (fid >= 0xfffe) ? 1 : fid + 1;
        }

        byte[] out = new byte[total];
        out[0] = 8;
        out[1] = (byte) rects.size();
        int pos = 2;
        for (byte[] sub : subs) {
            out[pos] = (byte) (sub.length & 0xff);
            out[pos + 1] = (byte) ((sub.length >> 8) & 0xff);
            pos += 2;
            System.arraycopy(sub, 0, out, pos, sub.length);
            pos += sub.length;
        }
        return new MultiRectPlan(out, rects.size(), coveredBytes, fid);
    }

    /**
     * Split the changed region between two packed 4bpp frames into a small set of
     * aligned rectangles that together cover every changed pixel: maximal vertical
     * bands of changed rows (merging gaps < V_GAP), each split into horizontal column
     * clusters (merging gaps < H_GAP), with each cluster's rows tightened to where it
     * actually changes. Rects are pixel-space {left,top,width,height}, left/width
     * aligned to 4px and top/height to 2px. Returns null if there's no change or the
     * split exceeds maxRects (caller falls back to a single bounding box).
     */
    private static List<int[]> computeSplitRects(byte[] previous, byte[] next, int stride, int width, int height, int maxRects) {
        boolean[] rowChanged = new boolean[height];
        boolean anyChange = false;
        for (int y = 0; y < height; y++) {
            int off = y * stride;
            for (int x = 0; x < stride; x++) {
                if (previous[off + x] != next[off + x]) {
                    rowChanged[y] = true;
                    anyChange = true;
                    break;
                }
            }
        }
        if (!anyChange) {
            return null;
        }

        List<int[]> rects = new ArrayList<>();
        boolean[] col = new boolean[stride];
        int y = 0;
        while (y < height) {
            if (!rowChanged[y]) { y++; continue; }
            // Extend a vertical band across changed rows, hopping unchanged gaps < V_GAP.
            int bandTop = y;
            int bandBot = y;
            int cur = y + 1;
            while (cur < height) {
                if (rowChanged[cur]) { bandBot = cur; cur++; continue; }
                int g = cur;
                while (g < height && !rowChanged[g]) g++;
                if (g < height && (g - cur) < MULTI_RECT_V_GAP_ROWS) { cur = g; } else break;
            }

            // Columns changed anywhere in the band.
            Arrays.fill(col, false);
            for (int yy = bandTop; yy <= bandBot; yy++) {
                if (!rowChanged[yy]) continue;
                int off = yy * stride;
                for (int x = 0; x < stride; x++) {
                    if (previous[off + x] != next[off + x]) col[x] = true;
                }
            }

            // Split the band into horizontal clusters, hopping column gaps < H_GAP.
            int x = 0;
            while (x < stride) {
                if (!col[x]) { x++; continue; }
                int cL = x;
                int cR = x;
                int cx = x + 1;
                while (cx < stride) {
                    if (col[cx]) { cR = cx; cx++; continue; }
                    int g = cx;
                    while (g < stride && !col[g]) g++;
                    if (g < stride && (g - cx) < MULTI_RECT_H_GAP_BYTES) { cx = g; } else break;
                }

                // Tighten this cluster's rows to those that change within [cL,cR].
                int tTop = height;
                int tBot = -1;
                for (int yy = bandTop; yy <= bandBot; yy++) {
                    if (!rowChanged[yy]) continue;
                    int off = yy * stride;
                    for (int xx = cL; xx <= cR; xx++) {
                        if (previous[off + xx] != next[off + xx]) {
                            if (yy < tTop) tTop = yy;
                            tBot = yy;
                            break;
                        }
                    }
                }
                if (tBot >= 0) {
                    int left = (cL * 2) & ~3;
                    int rightExclusive = Math.min(width, (((cR + 1) * 2) + 3) & ~3);
                    int top = tTop & ~1;
                    int bottomExclusive = Math.min(height, (tBot + 2) & ~1);
                    rects.add(new int[]{left, top, rightExclusive - left, bottomExclusive - top});
                    if (rects.size() > maxRects) {
                        return null; // too fragmented: a single bounding box is simpler
                    }
                }
                x = cR + 1;
            }
            y = bandBot + 1;
        }
        return rects;
    }

    /**
     * RLE- then zlib-compress headerless 4bpp pixels for CFW load_image_z mode 6.
     * Wire format: [6][zlib(rle(4bpp pixels))]. Always use mode 6: the logical
     * image can be larger than its EvenHub carrier, so a raw BMP fallback would
     * carry dimensions the legacy container loader cannot accept.
     */
    static byte[] maybeCompress(byte[] packed, int width, int height) {
        if (packed == null || packed.length == 0) {
            return packed;
        }
        byte[] z = deflate(rleEncode(packed));
        byte[] out = new byte[z.length + 1];
        out[0] = 6;
        System.arraycopy(z, 0, out, 1, z.length);
        return out;
    }

    /**
     * Run-length encode packed 4bpp pixels for CFW modes 3 and 6, whose payload is
     * zlib(rle(pixels)) rather than zlib(pixels). Runs are over the pixel NIBBLES of
     * {@code pix} in wire order (high nibble = left pixel), including the pad nibble
     * that ends each row at odd widths — i.e. {@code pix} read as 2*length nibbles.
     * One token is:
     * <pre>
     *   [cnt4|color4]                 cnt 1..15
     *   [0|color4][cnt8]              cnt 1..255
     *   [0|color4][0][cntLo][cntHi]   cnt 1..65535, little-endian
     * </pre>
     * with the low nibble always the color; runs longer than 65535 split across
     * tokens. Worst case (every nibble its own run) is exactly one byte per nibble,
     * which is what the buffer is sized for.
     */
    static byte[] rleEncode(byte[] pix) {
        int n = pix.length * 2;
        byte[] out = new byte[n];
        int o = 0;
        int i = 0;
        while (i < n) {
            int v = nibbleAt(pix, i);
            int j = i + 1;
            while (j < n && nibbleAt(pix, j) == v) j++;
            int run = j - i;
            while (run > 0) {
                int c = Math.min(run, 0xffff);
                if (c <= 15) {
                    out[o++] = (byte) ((c << 4) | v);
                } else if (c <= 255) {
                    out[o++] = (byte) v;        // high nibble 0 = escape to an 8-bit count
                    out[o++] = (byte) c;
                } else {
                    out[o++] = (byte) v;
                    out[o++] = 0;               // 8-bit count 0 = escape to a 16-bit count
                    out[o++] = (byte) (c & 0xff);
                    out[o++] = (byte) (c >> 8);
                }
                run -= c;
            }
            i = j;
        }
        return Arrays.copyOf(out, o);
    }

    private static int nibbleAt(byte[] pix, int i) {
        int b = pix[i >> 1] & 0xff;
        return (i & 1) != 0 ? (b & 0x0f) : (b >> 4);
    }

    // Level 6: BEST_COMPRESSION cost 18-109ms per frame on the BLE worker,
    // but BEST_SPEED inflated typical payloads from ~2.7KB past the 3800-byte
    // fragment boundary, adding a whole extra ack round trip (~350ms). The
    // default level keeps payloads under one fragment at about half the CPU.
    // One long-lived Deflater per thread: constructing one allocates and
    // initializes a native zlib stream, which is measurable at per-frame rates.
    private static final ThreadLocal<Deflater> DEFLATER =
        new ThreadLocal<Deflater>() {
            @Override protected Deflater initialValue() {
                return new Deflater(Deflater.DEFAULT_COMPRESSION);
            }
        };

    private static byte[] deflate(byte[] data) {
        Deflater deflater = DEFLATER.get();
        try {
            deflater.setInput(data);
            deflater.finish();
            ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(64, data.length / 3));
            byte[] buf = new byte[4096];
            while (!deflater.finished()) {
                out.write(buf, 0, deflater.deflate(buf));
            }
            return out.toByteArray();
        } finally {
            deflater.reset();
        }
    }

    public static final class ImageUpdateStats {
        final int paintMs;
        final int tileCount;
        final int frameId;
        long firstWriteStartedAtMs;

        ImageUpdateStats(int paintMs, int tileCount, int frameId) {
            this.paintMs = Math.max(0, paintMs);
            this.tileCount = tileCount;
            this.frameId = frameId;
        }
    }
}
