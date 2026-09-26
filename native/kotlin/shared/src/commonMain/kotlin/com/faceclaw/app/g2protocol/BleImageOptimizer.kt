package com.faceclaw.app

import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic

class BleImageOptimizer {
    companion object {
        private const val TAG: String = "BleImageOptimizer"

        /**
         * Split an image into fragments (packets), taking advantage of the fact that each packet
         * can declare a logical size longer than its byte payload to get free trailing
         * zero-padding.
         *
         * Each fragment's logical size stays within maxFragmentSize, while trailing zeros inside
         * that span can be omitted from the payload.
         */
        @JvmStatic
        fun planImageFragments(
            bmp: ByteArray,
            maxFragmentSize: Int,
        ): MutableList<BleProtocol.ImageFragment> {
            return planImageFragments(bmp, maxFragmentSize, false)
        }

        @JvmStatic
        fun planImageFragments(
            bmp: ByteArray?,
            maxFragmentSize: Int,
            reserveFinalByte: Boolean,
        ): MutableList<BleProtocol.ImageFragment> {
            if (((bmp == null) || (bmp.size == 0))) {
                return mutableListOf(BleProtocol.ImageFragment(0, ByteArray(0), 0))
            }
            if ((maxFragmentSize <= 0)) {
                throw IllegalArgumentException("maxFragmentSize must be positive")
            }
            val bulkLength: Int = (if (reserveFinalByte) (bmp.size - 1) else bmp.size)
            val fragmentCount: Int =
                ((((bulkLength + maxFragmentSize) - 1) / maxFragmentSize) +
                    (if ((bulkLength < bmp.size)) 1 else 0))
            val fragments: MutableList<BleProtocol.ImageFragment> = ArrayList(fragmentCount)
            run {
                var index: Int = 0
                while (((index * maxFragmentSize) < bulkLength)) {
                    var start: Int = (index * maxFragmentSize)
                    var end: Int = minOf((start + maxFragmentSize), bulkLength)
                    fragments.add(buildFragment(index, bmp, start, end))
                    index++
                }
            }
            if ((bulkLength < bmp.size)) {
                fragments.add(
                    BleProtocol.ImageFragment(
                        fragments.size,
                        bmp.copyOfRange(bulkLength, bmp.size),
                        (bmp.size - bulkLength),
                    )
                )
            }

            return fragments
        }

        private fun buildFragment(
            index: Int,
            bmp: ByteArray,
            start: Int,
            end: Int,
        ): BleProtocol.ImageFragment {
            var dataEnd: Int = end
            while (((dataEnd > start) && (bmp[(dataEnd - 1)].toInt() == 0))) {
                dataEnd -= 1
            }
            if ((dataEnd == start)) {
                return BleProtocol.ImageFragment(index, ByteArray(0), (end - start))
            }
            return BleProtocol.ImageFragment(index, bmp.copyOfRange(start, dataEnd), (end - start))
        }

        @JvmStatic
        fun buildIncrementalImagePayload(
            previous: ByteArray?,
            next: ByteArray?,
            width: Int,
            height: Int,
            frameId: Int,
        ): IncrementalPlan? {
            var stride: Int = ((width + 1) shr 1)
            if (
                ((((((width <= 0) || (height <= 0)) || (previous == null)) || (next == null)) ||
                    (previous.size != (stride * height))) || (next.size != (stride * height)))
            ) {
                return null
            }
            var minByteX: Int = stride
            var maxByteX: Int = -1
            var minY: Int = height
            var maxY: Int = -1
            var changedBytes: Int = 0
            var columnChanged: BooleanArray = BooleanArray(stride)
            run {
                var y: Int = 0
                while ((y < height)) {
                    var rowOffset: Int = (y * stride)
                    run {
                        var x: Int = 0
                        while ((x < stride)) {
                            if ((previous[(rowOffset + x)] != next[(rowOffset + x)])) {
                                changedBytes++
                                columnChanged[x] = true
                                if ((x < minByteX)) {
                                    minByteX = x
                                }
                                if ((x > maxByteX)) {
                                    maxByteX = x
                                }
                                if ((y < minY)) {
                                    minY = y
                                }
                                maxY = y
                            }
                            x++
                        }
                    }
                    y++
                }
            }
            if ((maxY < 0)) {
                return null
            }
            var clusterCount: Int = 0
            var inCluster: Boolean = false
            run {
                var x: Int = minByteX
                while ((x <= maxByteX)) {
                    if (columnChanged[x]) {
                        if (!inCluster) {
                            clusterCount++
                        }
                        inCluster = true
                    } else {
                        inCluster = false
                    }
                    x++
                }
            }
            var left: Int = ((minByteX * 2) and 3.inv())
            var rightExclusive: Int = minOf(width, ((((maxByteX + 1) * 2) + 3) and 3.inv()))
            var top: Int = (minY and 1.inv())
            var bottomExclusive: Int = minOf(height, ((maxY + 2) and 1.inv()))
            var boxWidth: Int = (rightExclusive - left)
            var boxHeight: Int = (bottomExclusive - top)
            if (((boxWidth >= width) && (boxHeight >= height))) {
                return null
            }
            var out: ByteArray =
                encodeMode3Rect(next, stride, left, top, boxWidth, boxHeight, frameId)
            return IncrementalPlan(out, changedBytes, ((boxWidth shr 1) * boxHeight), clusterCount)
        }

        /**
         * The aligned changed bounding box between two same-size packed frames, or null when they
         * are identical: pixel-space {left, top, width, height} with left/width multiples of 4 and
         * top/height multiples of 2 (mode-3 header quantization). Exposed so the texture-cache
         * planner can reuse the exact rect geometry the single-bbox path would send.
         */
        @JvmStatic
        fun computeChangedBox(
            previous: ByteArray?,
            next: ByteArray?,
            width: Int,
            height: Int,
        ): IntArray? {
            var stride: Int = ((width + 1) shr 1)
            if (
                ((((((width <= 0) || (height <= 0)) || (previous == null)) || (next == null)) ||
                    (previous.size != (stride * height))) || (next.size != (stride * height)))
            ) {
                return null
            }
            var minByteX: Int = stride
            var maxByteX: Int = -1
            var minY: Int = height
            var maxY: Int = -1
            run {
                var y: Int = 0
                while ((y < height)) {
                    var rowOffset: Int = (y * stride)
                    run {
                        var x: Int = 0
                        while ((x < stride)) {
                            if ((previous[(rowOffset + x)] != next[(rowOffset + x)])) {
                                if ((x < minByteX)) {
                                    minByteX = x
                                }
                                if ((x > maxByteX)) {
                                    maxByteX = x
                                }
                                if ((y < minY)) {
                                    minY = y
                                }
                                maxY = y
                            }
                            x++
                        }
                    }
                    y++
                }
            }
            if ((maxY < 0)) {
                return null
            }
            var left: Int = ((minByteX * 2) and 3.inv())
            var rightExclusive: Int = minOf(width, ((((maxByteX + 1) * 2) + 3) and 3.inv()))
            var top: Int = (minY and 1.inv())
            var bottomExclusive: Int = minOf(height, ((maxY + 2) and 1.inv()))
            return intArrayOf(left, top, (rightExclusive - left), (bottomExclusive - top))
        }

        /**
         * The multi-rect split of the changed region (see computeSplitRects), or null when it is
         * one region / too fragmented / the frames aren't comparable. Exposed for the texture-cache
         * planner.
         */
        @JvmStatic
        fun computeChangedRects(
            previous: ByteArray?,
            next: ByteArray?,
            width: Int,
            height: Int,
            maxRects: Int,
        ): MutableList<IntArray>? {
            var stride: Int = ((width + 1) shr 1)
            if (
                ((((((width <= 0) || (height <= 0)) || (previous == null)) || (next == null)) ||
                    (previous.size != (stride * height))) || (next.size != (stride * height)))
            ) {
                return null
            }
            var rects: MutableList<IntArray>? =
                computeSplitRects(previous, next, stride, width, height, maxRects)
            return (if (((rects == null) || (rects.size < 2))) null else rects)
        }

        /**
         * Encode one CFW mode-3 rectangle delta:
         * [3][left/4][top/2][width/4][height/2][fid_lo][fid_hi][rle(box pixels)] left/width must be
         * multiples of 4 (=> left>>1, width>>1 are whole bytes), top/ height multiples of 2. The
         * box pixels are top-down rows of `next` (4bpp packed, width>>1 bytes/row), run-length
         * encoded before deflate. Shared by the single-bbox path, each rect of a mode-8 multi-rect
         * batch, and the resource-cache planner.
         */
        @JvmStatic
        fun encodeMode3Rect(
            next: ByteArray,
            stride: Int,
            left: Int,
            top: Int,
            boxWidth: Int,
            boxHeight: Int,
            fid: Int,
        ): ByteArray {
            var regionStride: Int = (boxWidth shr 1)
            var region: ByteArray = ByteArray((regionStride * boxHeight))
            run {
                var y: Int = 0
                while ((y < boxHeight)) {
                    next.copyInto(
                        region,
                        (y * regionStride),
                        (((top + y) * stride) + (left shr 1)),
                        (((top + y) * stride) + (left shr 1)) + regionStride,
                    )
                    y++
                }
            }
            var compressed: ByteArray = rleEncode(region)
            var out: ByteArray = ByteArray((7 + compressed.size))
            out[0] = CFW_MSG_BOUNDING_BOX.toByte()
            out[1] = ((left / 4)).toByte()
            out[2] = ((top / 2)).toByte()
            out[3] = ((boxWidth / 4)).toByte()
            out[4] = ((boxHeight / 2)).toByte()
            out[5] = ((fid and 0xff)).toByte()
            out[6] = (((fid shr 8) and 0xff)).toByte()
            compressed.copyInto(out, 7, 0, 0 + compressed.size)
            return out
        }

        /** A full repaint in independently decodable commands below the uint16 record limit. */
        @JvmStatic
        fun encodeFullFrameBands(
            packed: ByteArray,
            width: Int,
            height: Int,
            firstFid: Int,
        ): MutableList<ByteArray> {
            if (
                (((((((width <= 0) || (width > 640)) || ((width and 3) != 0)) || (height <= 0)) ||
                    (height > 480)) || ((height and 1) != 0)) ||
                    (packed.size != ((width * height) / 2)))
            ) {
                throw IllegalArgumentException("unsupported custom framebuffer dimensions")
            }
            var commands: MutableList<ByteArray> = ArrayList()
            var fid: Int = firstFid
            run {
                var top: Int = 0
                while ((top < height)) {
                    commands.add(
                        encodeMode3Rect(
                            packed,
                            (width / 2),
                            0,
                            top,
                            width,
                            minOf(64, (height - top)),
                            fid,
                        )
                    )
                    fid = (if ((fid >= 0xfffe)) 1 else (fid + 1))
                    top += 64
                }
            }
            return commands
        }

        private const val MULTI_RECT_V_GAP_ROWS: Int = 4

        private const val MULTI_RECT_H_GAP_BYTES: Int = 6

        /**
         * Build a mode-8 multi-rect payload for the change between two same-size 4bpp frames,
         * assigning consecutive frame ids starting at fidStart (each rect needs a distinct fid —
         * the CFW skips duplicate fids). Returns null when the change is a single region (use the
         * single-rect path), when it fragments past maxRects, or when the frames aren't comparable.
         */
        @JvmStatic
        fun buildMultiRectImagePayload(
            previous: ByteArray?,
            next: ByteArray?,
            width: Int,
            height: Int,
            fidStart: Int,
            maxRects: Int,
        ): MultiRectPlan? {
            var stride: Int = ((width + 1) shr 1)
            if (
                ((((((width <= 0) || (height <= 0)) || (previous == null)) || (next == null)) ||
                    (previous.size != (stride * height))) || (next.size != (stride * height)))
            ) {
                return null
            }
            var rects: MutableList<IntArray>? =
                computeSplitRects(previous, next, stride, width, height, maxRects)
            if (((rects == null) || (rects.size < 2))) {
                return null
            }
            var subs: MutableList<ByteArray> = ArrayList(rects.size)
            var coveredBytes: Int = 0
            var fid: Int = fidStart
            var total: Int = 2
            for (r in rects) {
                var sub: ByteArray = encodeMode3Rect(next, stride, r[0], r[1], r[2], r[3], fid)
                subs.add(sub)
                coveredBytes += ((r[2] shr 1) * r[3])
                total += (2 + sub.size)
                fid = (if ((fid >= 0xfffe)) 1 else (fid + 1))
            }
            var out: ByteArray = ByteArray(total)
            out[0] = CFW_MSG_MULTI_SEGMENT.toByte()
            out[1] = (rects.size).toByte()
            var pos: Int = 2
            for (sub in subs) {
                out[pos] = ((sub.size and 0xff)).toByte()
                out[(pos + 1)] = (((sub.size shr 8) and 0xff)).toByte()
                pos += 2
                sub.copyInto(out, pos, 0, 0 + sub.size)
                pos += sub.size
            }
            return MultiRectPlan(out, rects.size, coveredBytes, fid)
        }

        /**
         * Split the changed region between two packed 4bpp frames into a small set of aligned
         * rectangles that together cover every changed pixel: maximal vertical bands of changed
         * rows (merging gaps < V_GAP), each split into horizontal column clusters (merging gaps <
         * H_GAP), with each cluster's rows tightened to where it actually changes. Rects are
         * pixel-space {left,top,width,height}, left/width aligned to 4px and top/height to 2px.
         * Returns null if there's no change or the split exceeds maxRects (caller falls back to a
         * single bounding box).
         */
        private fun computeSplitRects(
            previous: ByteArray,
            next: ByteArray,
            stride: Int,
            width: Int,
            height: Int,
            maxRects: Int,
        ): MutableList<IntArray>? {
            var rowChanged: BooleanArray = BooleanArray(height)
            var anyChange: Boolean = false
            run {
                var y: Int = 0
                while ((y < height)) {
                    var off: Int = (y * stride)
                    run {
                        var x: Int = 0
                        while ((x < stride)) {
                            if ((previous[(off + x)] != next[(off + x)])) {
                                rowChanged[y] = true
                                anyChange = true
                                break
                            }
                            x++
                        }
                    }
                    y++
                }
            }
            if (!anyChange) {
                return null
            }
            var rects: MutableList<IntArray> = ArrayList()
            var col: BooleanArray = BooleanArray(stride)
            var y: Int = 0
            while ((y < height)) {
                if (!rowChanged[y]) {
                    y++
                    continue
                }
                var bandTop: Int = y
                var bandBot: Int = y
                var cur: Int = (y + 1)
                while ((cur < height)) {
                    if (rowChanged[cur]) {
                        bandBot = cur
                        cur++
                        continue
                    }
                    var g: Int = cur
                    while (((g < height) && !rowChanged[g])) {
                        g++
                    }
                    if (((g < height) && ((g - cur) < MULTI_RECT_V_GAP_ROWS))) {
                        cur = g
                    } else {
                        break
                    }
                }
                col.fill(false)
                run {
                    var yy: Int = bandTop
                    while ((yy <= bandBot)) {
                        if (!rowChanged[yy]) {
                            yy++
                            continue
                        }
                        var off: Int = (yy * stride)
                        run {
                            var x: Int = 0
                            while ((x < stride)) {
                                if ((previous[(off + x)] != next[(off + x)])) {
                                    col[x] = true
                                }
                                x++
                            }
                        }
                        yy++
                    }
                }
                var x: Int = 0
                while ((x < stride)) {
                    if (!col[x]) {
                        x++
                        continue
                    }
                    var cL: Int = x
                    var cR: Int = x
                    var cx: Int = (x + 1)
                    while ((cx < stride)) {
                        if (col[cx]) {
                            cR = cx
                            cx++
                            continue
                        }
                        var g: Int = cx
                        while (((g < stride) && !col[g])) {
                            g++
                        }
                        if (((g < stride) && ((g - cx) < MULTI_RECT_H_GAP_BYTES))) {
                            cx = g
                        } else {
                            break
                        }
                    }
                    var tTop: Int = height
                    var tBot: Int = -1
                    run {
                        var yy: Int = bandTop
                        while ((yy <= bandBot)) {
                            if (!rowChanged[yy]) {
                                yy++
                                continue
                            }
                            var off: Int = (yy * stride)
                            run {
                                var xx: Int = cL
                                while ((xx <= cR)) {
                                    if ((previous[(off + xx)] != next[(off + xx)])) {
                                        if ((yy < tTop)) {
                                            tTop = yy
                                        }
                                        tBot = yy
                                        break
                                    }
                                    xx++
                                }
                            }
                            yy++
                        }
                    }
                    if ((tBot >= 0)) {
                        var left: Int = ((cL * 2) and 3.inv())
                        var rightExclusive: Int = minOf(width, ((((cR + 1) * 2) + 3) and 3.inv()))
                        var top: Int = (tTop and 1.inv())
                        var bottomExclusive: Int = minOf(height, ((tBot + 2) and 1.inv()))
                        rects.add(
                            intArrayOf(left, top, (rightExclusive - left), (bottomExclusive - top))
                        )
                        if ((rects.size > maxRects)) {
                            return null
                        }
                    }
                    x = (cR + 1)
                }
                y = (bandBot + 1)
            }
            return rects
        }

        /**
         * Run-length encode headerless 4bpp pixels for CFW load_image_z mode 6. Wire format:
         * [6][rle(4bpp pixels)]. Always use mode 6: the logical image can be larger than its
         * EvenHub carrier, so a raw BMP fallback would carry dimensions the legacy container loader
         * cannot accept.
         */
        @JvmStatic
        fun maybeCompress(packed: ByteArray?, width: Int, height: Int): ByteArray {
            if (((packed == null) || (packed.size == 0))) {
                return packed ?: ByteArray(0)
            }
            var z: ByteArray = rleEncode(packed)
            var out: ByteArray = ByteArray((z.size + 1))
            out[0] = CFW_MSG_FULL_FRAME.toByte()
            z.copyInto(out, 1, 0, 0 + z.size)
            return out
        }

        /**
         * Run-length encode packed 4bpp pixels for CFW modes 3 and 6, whose payload is RLE tokens;
         * deflate belongs to the transport. Runs are over the pixel NIBBLES of {@code pix} in wire
         * order (high nibble = left pixel), including the pad nibble that ends each row at odd
         * widths — i.e. {@code pix} read as 2*length nibbles. One token is:
         * <pre>
         *   [cnt4|color4]                 cnt 1..15
         *   [0|color4][cnt8]              cnt 1..255
         *   [0|color4][0][cntLo][cntHi]   cnt 1..65535, little-endian
         * </pre>
         * with the low nibble always the color; runs longer than 65535 split across tokens. Worst
         * case (every nibble its own run) is exactly one byte per nibble, which is what the buffer
         * is sized for.
         */
        @JvmStatic
        fun rleEncode(pix: ByteArray): ByteArray {
            val n = pix.size * 2
            val out = ByteArray(n)
            var o: Int = 0
            var i: Int = 0
            while ((i < n)) {
                val first = pix[i ushr 1].toInt() and 255
                val v = if (i and 1 == 0) first ushr 4 else first and 15
                // Start at a byte boundary, consuming the known low nibble
                // first if the previous run ended halfway through a byte.
                var j = i + (i and 1)
                val pair = ((v shl 4) or v).toByte()
                while (j < n && pix[j ushr 1] == pair) j += 2
                // A final high nibble can match even when its low nibble doesn't.
                if (j < n && (pix[j ushr 1].toInt() and 240) == v shl 4) j++
                var run: Int = (j - i)
                while ((run > 0)) {
                    var c: Int = minOf(run, 0xffff)
                    if ((c <= 15)) {
                        out[o++] = (((c shl 4) or v)).toByte()
                    } else {
                        if ((c <= 255)) {
                            out[o++] = (v).toByte()
                            out[o++] = (c).toByte()
                        } else {
                            out[o++] = (v).toByte()
                            out[o++] = 0
                            out[o++] = ((c and 0xff)).toByte()
                            out[o++] = ((c shr 8)).toByte()
                        }
                    }
                    run -= c
                }
                i = j
            }
            return out.copyOf(o)
        }

    }

    constructor() {}

    class TileImagePlan {
        @JvmField val tileIndex: Int

        @JvmField val tile: BleProtocol.ImageTileOptions

        @JvmField val packed: ByteArray?

        @JvmField val width: Int

        @JvmField val height: Int

        @JvmField val payload: ByteArray

        @JvmField val sessionId: Int

        @JvmField var fragments: MutableList<BleProtocol.ImageFragment> = mutableListOf()

        constructor(
            tileIndex: Int,
            tile: BleProtocol.ImageTileOptions,
            packed: ByteArray?,
            width: Int,
            height: Int,
            sessionId: Int,
        ) {
            this.tileIndex = tileIndex
            this.tile = tile
            this.packed = (if ((packed == null)) ByteArray(0) else packed)
            this.width = width
            this.height = height
            this.payload = maybeCompress(this.packed, width, height)
            this.sessionId = sessionId
        }

        constructor(
            tileIndex: Int,
            tile: BleProtocol.ImageTileOptions,
            packed: ByteArray?,
            width: Int,
            height: Int,
            sessionId: Int,
            payloadOverride: ByteArray,
        ) {
            this.tileIndex = tileIndex
            this.tile = tile
            this.packed = (if ((packed == null)) ByteArray(0) else packed)
            this.width = width
            this.height = height
            this.payload = payloadOverride
            this.sessionId = sessionId
        }
    }

    /**
     * A mode-3 incremental payload plus diagnostics about how tightly the bounding box fit the
     * actual change. {@code changedBytes} is how many packed bytes actually differ; {@code
     * boxBytes} is how many the box sends. A large box with few changed bytes / multiple clusters
     * means distant small edits were merged into one oversized box (which can spill past the
     * fragment size into an extra serialized BLE message).
     */
    class IncrementalPlan {
        @JvmField val payload: ByteArray

        @JvmField val changedBytes: Int

        @JvmField val boxBytes: Int

        @JvmField val clusterCount: Int

        constructor(payload: ByteArray, changedBytes: Int, boxBytes: Int, clusterCount: Int) {
            this.payload = payload
            this.changedBytes = changedBytes
            this.boxBytes = boxBytes
            this.clusterCount = clusterCount
        }
    }

    /**
     * A CFW mode-8 multi-segment payload (`[8][count]` then per-rect `[len16][mode-3 submsg]`)
     * carrying several tight rectangle deltas instead of one bounding box, plus diagnostics. Each
     * rect is applied to the firmware shadow with the panel push deferred, then presented once.
     * Used when the change splits into regions whose bounding box wastes bytes (distant edits, or a
     * sparse box); the caller falls back to the single-rect path when this returns null or isn't
     * smaller.
     */
    class MultiRectPlan {
        @JvmField val payload: ByteArray

        @JvmField val rectCount: Int

        @JvmField val coveredBytes: Int

        @JvmField val nextFid: Int

        constructor(payload: ByteArray, rectCount: Int, coveredBytes: Int, nextFid: Int) {
            this.payload = payload
            this.rectCount = rectCount
            this.coveredBytes = coveredBytes
            this.nextFid = nextFid
        }
    }

    class ImageUpdateStats {
        @JvmField val paintMs: Int

        @JvmField val tileCount: Int

        @JvmField val frameId: Int

        @JvmField var firstWriteStartedAtMs: Long = 0L

        constructor(paintMs: Int, tileCount: Int, frameId: Int) {
            this.paintMs = maxOf(0, paintMs)
            this.tileCount = tileCount
            this.frameId = frameId
        }
    }
}
