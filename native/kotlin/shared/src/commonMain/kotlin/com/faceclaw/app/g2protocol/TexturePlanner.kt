package com.faceclaw.app

import kotlin.jvm.JvmField
import kotlin.jvm.JvmOverloads
import kotlin.jvm.JvmStatic

/**
 * Plans a screen update that ships text and icons as on-glasses cached draws instead of pixels (CFW
 * modes 19/20/21/22; see g2flash/patches/zlib_glue.c and resource_cache.c).
 *
 * Approach: dirty rects come from comparing the fully composited old and new frames, exactly as the
 * plain incremental path does. For each deferred draw (glyph or image) whose pixels intersect a
 * sent rect, check that every pixel the on-glasses draw would write lands correct — i.e. the new
 * composite's 4bpp value at each in-panel nonzero-source pixel equals what the draw produces (this
 * one check subsumes plane occlusion, surface occlusion/clipping, and draw-on-draw overlap). A draw
 * that passes and is (or can be made) resident in the resource cache is replayed on-glasses: its
 * written pixels are punched to 0 in the delta rect content — which is what makes text and icons
 * nearly free to compress — and re-emitted as a mode-20 string or mode-19 image sub-message in the
 * same atomic mode-8 batch, so the shadow after apply equals the full composite exactly. Everything
 * else stays baked.
 *
 * Fallback shape: when nothing qualifies, plan() returns null and the caller uses the plain
 * single-bbox/multi-rect/full-frame paths unchanged.
 */
class TexturePlanner {
    companion object {
        /** Cap on mode-20 string sub-messages (mode-8 count is a u8). */
        private const val MAX_GLYPH_RUNS: Int = 180

        /**
         * Soft cap on cached-glyph selection per update, before run grouping. Sized above a
         * full-screen 6x12 terminal repaint (~4,240 cells) so dense screens draw everything; the
         * run budget is the real bound.
         */
        private const val MAX_SELECTED_GLYPHS: Int = 4600

        /** Cap on mode-19 image sub-messages per update. */
        private const val MAX_IMAGE_DRAWS: Int = 60

        /** Cap on mode-15 builtin-font string sub-messages per update. */
        private const val MAX_FWTEXT_RUNS: Int = 80

        /** Resource command payload size that fits one BLE image message comfortably. */
        private const val UPLOAD_PAYLOAD_MAX: Int = 3600

        /** Max x-adjust control bytes between two glyphs before starting a new run. */
        private const val MAX_ADJUST_BYTES: Int = 4

        /** Options: identity LUT (top 15) + transparent, for mode-19 image draws. */
        private const val IMAGE_DRAW_OPTIONS: Int = 0x1f

        /**
         * Plan a cached-draw update. previous is the delta base (the frame the shadow currently
         * holds), or null/mismatched for a full-frame keyframe. Returns null when the plain paths
         * should run instead (no replayable draws, or identical frames).
         */
        @JvmStatic
        @JvmOverloads
        fun plan(
            previous: ByteArray?,
            next: ByteArray?,
            width: Int,
            height: Int,
            draws: Array<SurfaceCompositor.ScreenDraw>?,
            cache: ResourceCacheState,
            fidStart: Int,
            allowMultiRect: Boolean,
            maxRects: Int,
            platform: ProtocolPlatform = protocolPlatform(),
        ): Result? {
            if (
                (((((next == null) || (draws == null)) || (draws.size == 0)) || (width <= 0)) ||
                    (height <= 0))
            ) {
                return null
            }
            var stride: Int = ((width + 1) shr 1)
            if ((next.size != (stride * height))) {
                return null
            }
            var planStartedAtMs: Long = platform.elapsedRealtimeMs()
            var fullFrame: Boolean = ((previous == null) || (previous.size != next.size))
            var rects: MutableList<IntArray>
            if (!fullFrame) {
                var box: IntArray? =
                    BleImageOptimizer.computeChangedBox(previous, next, width, height)
                if ((box == null)) {
                    return null
                }
                if (((box[2] >= width) && (box[3] >= height))) {
                    fullFrame = true
                    rects = mutableListOf(intArrayOf(0, 0, width, height))
                } else {
                    var split: MutableList<IntArray>? =
                        (if (allowMultiRect)
                            BleImageOptimizer.computeChangedRects(
                                previous,
                                next,
                                width,
                                height,
                                maxRects,
                            )
                        else null)
                    rects = (if ((split != null)) split else mutableListOf(box))
                }
            } else {
                rects = mutableListOf(intArrayOf(0, 0, width, height))
            }
            var matchStartedAtMs: Long = platform.elapsedRealtimeMs()
            var selected: MutableList<Selected> = ArrayList()
            var bakedCandidates: Int = 0
            var selectedImages: Int = 0
            var fwSubs: MutableList<ByteArray> = ArrayList()
            var fwPunches: MutableList<FwPunch> = ArrayList()
            var fwGlyphCount: Int = 0
            var fwBaked: Int = 0
            for (draw in draws) {
                if ((draw.kind != SurfaceCompositor.ScreenDraw.KIND_FWTEXT)) {
                    continue
                }
                fwBaked += planFwRun(draw, rects, next, stride, width, height, fwSubs, fwPunches)
            }
            fwGlyphCount = fwPunches.size
            bakedCandidates += fwBaked
            for (draw in draws) {
                if ((draw.kind == SurfaceCompositor.ScreenDraw.KIND_GLYPH)) {
                    var atlas: GlyphAtlas.Glyph? = GlyphAtlas.get(draw.fontId, draw.encoding)
                    if ((atlas == null)) {
                        continue
                    }
                    var gx: Int = (draw.x + atlas.bbxX)
                    var inkTop: Int = (draw.y + atlas.inkTop)
                    if (!intersectsAny(rects, gx, inkTop, atlas.width, atlas.inkHeight)) {
                        continue
                    }
                    if (
                        ((((((draw.encoding < 32) || (draw.encoding > 127)) || (gx < 0)) ||
                            (draw.y < 0)) || (gx > 0xffff)) || (draw.y > 0xffff))
                    ) {
                        bakedCandidates++
                        continue
                    }
                    var top: Int = BmpUtil.nibbleForGray(draw.value)
                    if (
                        !glyphMatchesComposite(next, stride, width, height, atlas, gx, draw.y, top)
                    ) {
                        bakedCandidates++
                        continue
                    }
                    if ((selected.size >= MAX_SELECTED_GLYPHS)) {
                        bakedCandidates++
                        continue
                    }
                    selected.add(Selected(draw, atlas, null, gx, top))
                } else {
                    var atlas: ImageAtlas.Entry? = ImageAtlas.get(draw.imageId)
                    if ((atlas == null)) {
                        continue
                    }
                    if (!intersectsAny(rects, draw.x, draw.y, atlas.width, atlas.height)) {
                        continue
                    }
                    if (
                        (((((draw.x < 0) || (draw.y < 0)) || (draw.x > 0xffff)) ||
                            (draw.y > 0xffff)) || (selectedImages >= MAX_IMAGE_DRAWS))
                    ) {
                        bakedCandidates++
                        continue
                    }
                    if (
                        !imageMatchesComposite(next, stride, width, height, atlas, draw.x, draw.y)
                    ) {
                        bakedCandidates++
                        continue
                    }
                    selected.add(Selected(draw, null, atlas, draw.x, 0))
                    selectedImages++
                }
            }
            if ((selected.isEmpty() && fwSubs.isEmpty())) {
                return null
            }
            val rollback = cache.checkpoint()
            var cacheStartedAtMs: Long = platform.elapsedRealtimeMs()
            var drawable: MutableList<Selected> =
                (if (selected.isEmpty()) mutableListOf() else ensureResident(cache, selected))
            bakedCandidates += (selected.size - drawable.size)
            var glyphDrawable: MutableList<Selected> = ArrayList()
            var imageDrawable: MutableList<Selected> = ArrayList()
            for (sel in drawable) {
                if ((sel.glyphAtlas != null)) {
                    glyphDrawable.add(sel)
                } else {
                    imageDrawable.add(sel)
                }
            }
            var runs: MutableList<ByteArray> = ArrayList()
            var drawnGlyphs: MutableList<Selected> = buildRuns(glyphDrawable, runs)
            bakedCandidates += (glyphDrawable.size - drawnGlyphs.size)
            var drawn: MutableList<Selected> = ArrayList(drawnGlyphs)
            drawn.addAll(imageDrawable)
            if (
                ((drawn.isEmpty() && fwSubs.isEmpty()) ||
                    ((((rects.size + runs.size) + imageDrawable.size) + fwSubs.size) > 255))
            ) {
                if (!selected.isEmpty()) {
                    rollback()
                }
                return null
            }
            var punchStartedAtMs: Long = platform.elapsedRealtimeMs()
            var punched: ByteArray = next.copyOf()
            for (sel in drawn) {
                punch(punched, stride, width, height, sel)
            }
            for (fw in fwPunches) {
                punchFw(punched, stride, width, height, fw)
            }
            var encodeStartedAtMs: Long = platform.elapsedRealtimeMs()
            var subs: MutableList<ByteArray> = ArrayList()
            var fid: Int = fidStart
            if (fullFrame) {
                subs.add(BleImageOptimizer.maybeCompress(punched, width, height))
            } else {
                for (r in rects) {
                    subs.add(
                        BleImageOptimizer.encodeMode3Rect(
                            punched,
                            stride,
                            r[0],
                            r[1],
                            r[2],
                            r[3],
                            fid,
                        )
                    )
                    fid = (if ((fid >= 0xfffe)) 1 else (fid + 1))
                }
            }
            for (sel in imageDrawable) {
                subs.add(encodeImageDraw(sel))
            }
            subs.addAll(runs)
            subs.addAll(fwSubs)
            var payload: ByteArray = assembleMode8(subs)
            if (payload.size > CfwTransport.MAX_MESSAGE) {
                rollback()
                return null
            }
            val resourceCommands = cache.drainCommands(UPLOAD_PAYLOAD_MAX)
            val uploadBytes = resourceCommands.sumOf { it.size }
            var result: Result =
                Result(
                    payload,
                    resourceCommands,
                    fid,
                    rects.size,
                    drawnGlyphs.size,
                    runs.size,
                    imageDrawable.size,
                    fwGlyphCount,
                    fwSubs.size,
                    bakedCandidates,
                    uploadBytes,
                    fullFrame,
                )
            var doneAtMs: Long = platform.elapsedRealtimeMs()
            result.rectsMs = ((matchStartedAtMs - planStartedAtMs)).toInt()
            result.matchMs = ((cacheStartedAtMs - matchStartedAtMs)).toInt()
            result.cacheMs = ((punchStartedAtMs - cacheStartedAtMs)).toInt()
            result.punchMs = ((encodeStartedAtMs - punchStartedAtMs)).toInt()
            result.encodeMs = ((doneAtMs - encodeStartedAtMs)).toInt()
            return result
        }

        /**
         * Plan one firmware-font run (mode 15): classify every member, and when any correct ink
         * member intersects a sent rect, emit sub-messages over the maximal correct stretches. A
         * stretch never spans an incorrect member — the sub-message boundary restarts the
         * firmware's advance walk at an explicit pen x, so occluded or unknown glyphs simply stay
         * baked without disturbing their neighbors' positions. Emitted ink members are queued for
         * punching. Returns how many ink members stay baked.
         */
        private fun planFwRun(
            draw: SurfaceCompositor.ScreenDraw,
            rects: MutableList<IntArray>,
            next: ByteArray,
            stride: Int,
            width: Int,
            height: Int,
            outSubs: MutableList<ByteArray>,
            outPunches: MutableList<FwPunch>,
        ): Int {
            var n: Int = draw.fwCps!!.size
            if ((((n == 0) || (draw.y < 0)) || (draw.y > 0xffff))) {
                return countInk(draw)
            }
            var top: Int = BmpUtil.nibbleForGray(draw.value)
            var ok: BooleanArray = BooleanArray(n)
            var entries: Array<FwGlyphAtlas.Entry?> = arrayOfNulls<FwGlyphAtlas.Entry>(n)
            var relevant: Boolean = false
            var baked: Int = 0
            run {
                var i: Int = 0
                while ((i < n)) {
                    if (!draw.fwInk!![i]) {
                        ok[i] = true
                        i++
                        continue
                    }
                    var entry: FwGlyphAtlas.Entry? = FwGlyphAtlas.get(draw.fwCps!![i])
                    if ((entry == null)) {
                        baked++
                        i++
                        continue
                    }
                    var gx: Int = ((draw.x + draw.fwDx!![i]) + entry.ofsX)
                    var gy: Int = (draw.y + entry.inkTop)
                    if (!fwGlyphMatchesComposite(next, stride, width, height, entry, gx, gy, top)) {
                        baked++
                        i++
                        continue
                    }
                    ok[i] = true
                    entries[i] = entry
                    if (intersectsAny(rects, gx, gy, entry.boxW, entry.boxH)) {
                        relevant = true
                    }
                    i++
                }
            }
            if (!relevant) {
                return 0
            }
            var i: Int = 0
            while (((i < n) && (outSubs.size < MAX_FWTEXT_RUNS))) {
                while (((i < n) && !(ok[i] && draw.fwInk!![i]))) {
                    i++
                }
                if ((i >= n)) {
                    break
                }
                var startX: Int = (draw.x + draw.fwDx!![i])
                if (((startX < 0) || (startX > 0xffff))) {
                    baked++
                    i++
                    continue
                }
                var j: Int = i
                var lastInk: Int = -1
                var bytesToLastInk: Int = 0
                var bytesSoFar: Int = 0
                while (((j < n) && ok[j])) {
                    var encodedLength: Int = utf8Length(draw.fwCps!![j])
                    if (((bytesSoFar + encodedLength) > 255)) {
                        break
                    }
                    bytesSoFar += encodedLength
                    if (draw.fwInk!![j]) {
                        lastInk = j
                        bytesToLastInk = bytesSoFar
                    }
                    j++
                }
                if ((lastInk < i)) {
                    baked++
                    i++
                    continue
                }
                var sub: ByteArray = ByteArray((7 + bytesToLastInk))
                sub[0] = 15
                sub[1] = ((startX and 0xff)).toByte()
                sub[2] = (((startX shr 8) and 0xff)).toByte()
                sub[3] = ((draw.y and 0xff)).toByte()
                sub[4] = (((draw.y shr 8) and 0xff)).toByte()
                sub[5] = ((top or 0x10)).toByte()
                sub[6] = (bytesToLastInk).toByte()
                var pos: Int = 7
                run {
                    var k: Int = i
                    while ((k <= lastInk)) {
                        var encoded: ByteArray = codePointUtf8(draw.fwCps!![k])
                        encoded.copyInto(sub, pos, 0, 0 + encoded.size)
                        pos += encoded.size
                        k++
                    }
                }
                outSubs.add(sub)
                run {
                    var k: Int = i
                    while ((k <= lastInk)) {
                        if (draw.fwInk!![k]) {
                            outPunches.add(
                                FwPunch(
                                    entries[k]!!,
                                    ((draw.x + draw.fwDx!![k]) + entries[k]!!.ofsX),
                                    (draw.y + entries[k]!!.inkTop),
                                )
                            )
                        }
                        k++
                    }
                }
                i = (lastInk + 1)
            }
            return baked
        }

        private fun utf8Length(cp: Int): Int {
            if ((cp < 0x80)) {
                return 1
            }
            if ((cp < 0x800)) {
                return 2
            }
            if ((cp < 0x10000)) {
                return 3
            }
            return 4
        }

        private fun countInk(draw: SurfaceCompositor.ScreenDraw): Int {
            var count: Int = 0
            for (ink in draw.fwInk!!) {
                if (ink) {
                    count++
                }
            }
            return count
        }

        /**
         * Whether every in-panel nonzero pixel of the builtin-font glyph lands correct: the
         * composite's 4bpp value must equal the firmware's LUT output src*top/15 (integer division
         * — a general LUT check, since these glyphs are anti-aliased).
         */
        private fun fwGlyphMatchesComposite(
            packed: ByteArray,
            stride: Int,
            width: Int,
            height: Int,
            entry: FwGlyphAtlas.Entry,
            gx: Int,
            gy: Int,
            top: Int,
        ): Boolean {
            run {
                var row: Int = 0
                while ((row < entry.boxH)) {
                    var y: Int = (gy + row)
                    if (((y < 0) || (y >= height))) {
                        row++
                        continue
                    }
                    run {
                        var col: Int = 0
                        while ((col < entry.boxW)) {
                            var source: Int = entry.nibbleAt(col, row)
                            if ((source == 0)) {
                                col++
                                continue
                            }
                            var x: Int = (gx + col)
                            if (((x < 0) || (x >= width))) {
                                col++
                                continue
                            }
                            if ((nibbleAt(packed, stride, x, y) != ((source * top) / 15))) {
                                return false
                            }
                            col++
                        }
                    }
                    row++
                }
            }
            return true
        }

        private fun punchFw(
            packed: ByteArray,
            stride: Int,
            width: Int,
            height: Int,
            fw: FwPunch,
        ): Unit {
            run {
                var row: Int = 0
                while ((row < fw.entry.boxH)) {
                    var y: Int = (fw.gy + row)
                    if (((y < 0) || (y >= height))) {
                        row++
                        continue
                    }
                    run {
                        var col: Int = 0
                        while ((col < fw.entry.boxW)) {
                            if ((fw.entry.nibbleAt(col, row) == 0)) {
                                col++
                                continue
                            }
                            punchPixel(packed, stride, width, (fw.gx + col), y)
                            col++
                        }
                    }
                    row++
                }
            }
        }

        private fun intersectsAny(
            rects: MutableList<IntArray>,
            x: Int,
            y: Int,
            w: Int,
            h: Int,
        ): Boolean {
            if (((w <= 0) || (h <= 0))) {
                return false
            }
            for (r in rects) {
                if (
                    ((((x < (r[0] + r[2])) && ((x + w) > r[0])) && (y < (r[1] + r[3]))) &&
                        ((y + h) > r[1]))
                ) {
                    return true
                }
            }
            return false
        }

        /**
         * Whether every in-panel ink pixel of the glyph lands correct in the packed new frame: the
         * composite's 4bpp value must equal the firmware's LUT output source*top/15 (integer). For
         * 1bpp glyphs (source 15) this is exactly `== top`; AA glyphs get the general check. Ink
         * outside the panel is clipped by the firmware and irrelevant.
         */
        private fun glyphMatchesComposite(
            packed: ByteArray,
            stride: Int,
            width: Int,
            height: Int,
            atlas: GlyphAtlas.Glyph,
            gx: Int,
            lineY: Int,
            top: Int,
        ): Boolean {
            run {
                var row: Int = atlas.inkTop
                while ((row < (atlas.inkTop + atlas.inkHeight))) {
                    var y: Int = (lineY + row)
                    if (((y < 0) || (y >= height))) {
                        row++
                        continue
                    }
                    run {
                        var col: Int = 0
                        while ((col < atlas.width)) {
                            var source: Int = atlas.nibbleAt(col, row)
                            if ((source == 0)) {
                                col++
                                continue
                            }
                            var x: Int = (gx + col)
                            if (((x < 0) || (x >= width))) {
                                col++
                                continue
                            }
                            if ((nibbleAt(packed, stride, x, y) != ((source * top) / 15))) {
                                return false
                            }
                            col++
                        }
                    }
                    row++
                }
            }
            return true
        }

        /**
         * Whether every in-panel nonzero pixel of the cached image equals the packed new frame —
         * the mode-19 transparent draw writes exactly those.
         */
        private fun imageMatchesComposite(
            packed: ByteArray,
            stride: Int,
            width: Int,
            height: Int,
            atlas: ImageAtlas.Entry,
            left: Int,
            top: Int,
        ): Boolean {
            run {
                var row: Int = 0
                while ((row < atlas.height)) {
                    var y: Int = (top + row)
                    if (((y < 0) || (y >= height))) {
                        row++
                        continue
                    }
                    run {
                        var col: Int = 0
                        while ((col < atlas.width)) {
                            var source: Int = atlas.nibbleAt(col, row)
                            if ((source == 0)) {
                                col++
                                continue
                            }
                            var x: Int = (left + col)
                            if (((x < 0) || (x >= width))) {
                                col++
                                continue
                            }
                            if ((nibbleAt(packed, stride, x, y) != source)) {
                                return false
                            }
                            col++
                        }
                    }
                    row++
                }
            }
            return true
        }

        private fun nibbleAt(packed: ByteArray, stride: Int, x: Int, y: Int): Int {
            var b: Int = (packed[((y * stride) + (x shr 1))] and 0xff)
            return (if (((x and 1) != 0)) (b and 0x0f) else (b shr 4))
        }

        private fun punch(
            packed: ByteArray,
            stride: Int,
            width: Int,
            height: Int,
            sel: Selected,
        ): Unit {
            if ((sel.glyphAtlas != null)) {
                var atlas: GlyphAtlas.Glyph = sel.glyphAtlas
                run {
                    var row: Int = atlas.inkTop
                    while ((row < (atlas.inkTop + atlas.inkHeight))) {
                        var y: Int = (sel.draw.y + row)
                        if (((y < 0) || (y >= height))) {
                            row++
                            continue
                        }
                        run {
                            var col: Int = 0
                            while ((col < atlas.width)) {
                                if (!atlas.inkAt(col, row)) {
                                    col++
                                    continue
                                }
                                punchPixel(packed, stride, width, (sel.gx + col), y)
                                col++
                            }
                        }
                        row++
                    }
                }
            } else {
                var atlas: ImageAtlas.Entry = sel.imageAtlas!!
                run {
                    var row: Int = 0
                    while ((row < atlas.height)) {
                        var y: Int = (sel.draw.y + row)
                        if (((y < 0) || (y >= height))) {
                            row++
                            continue
                        }
                        run {
                            var col: Int = 0
                            while ((col < atlas.width)) {
                                if ((atlas.nibbleAt(col, row) == 0)) {
                                    col++
                                    continue
                                }
                                punchPixel(packed, stride, width, (sel.gx + col), y)
                                col++
                            }
                        }
                        row++
                    }
                }
            }
        }

        private fun punchPixel(packed: ByteArray, stride: Int, width: Int, x: Int, y: Int): Unit {
            if (((x < 0) || (x >= width))) {
                return
            }
            var index: Int = ((y * stride) + (x shr 1))
            if (((x and 1) != 0)) {
                packed[index] = ((packed[index] and 0xf0)).toByte()
            } else {
                packed[index] = ((packed[index] and 0x0f)).toByte()
            }
        }

        /** Protect every hit before LRU admission so a miss cannot evict this frame's later draws. */
        private fun ensureResident(
            cache: ResourceCacheState,
            selected: MutableList<Selected>,
        ): MutableList<Selected> {
            val fonts = selected.filter { it.glyphAtlas != null }.groupBy { it.draw.fontId }
                .mapValues { (id, draws) -> FontResourceAtlas.get(id, draws.map { it.draw.encoding }.toSet()) }
            val candidates = selected.filter { it.glyphAtlas == null || it.draw.encoding in fonts.getValue(it.draw.fontId).encodings }
            val resources = candidates.map { sel ->
                if (sel.glyphAtlas != null) fonts.getValue(sel.draw.fontId).resource else sel.imageAtlas!!.resource
            }
            val ids = cache.prepare(resources)
            return candidates.filterIndexed { index, sel -> sel.resourceId = ids[index]; ids[index] >= 0 }.toMutableList()
        }

        /** Mode-19 cached-image draw: [19][resourceId u16][x u16][y u16][options u8]. */
        @JvmStatic
        private fun encodeImageDraw(sel: Selected): ByteArray = byteArrayOf(
            19, sel.resourceId.toByte(), (sel.resourceId ushr 8).toByte(),
            sel.draw.x.toByte(), (sel.draw.x ushr 8).toByte(),
            sel.draw.y.toByte(), (sel.draw.y ushr 8).toByte(), IMAGE_DRAW_OPTIONS.toByte(),
        )

        /**
         * Group selected glyphs into mode-20 string sub-messages: [20][fontResource u16][x u16][y
         * u16][options u8][strlen u8][string] One run per (font, line y, top color) span; within a
         * run, control bytes 1..31 adjust x by -10..+20 to hit each glyph's exact position, and
         * each glyph advances x by its cached width. Order across runs is free: every drawn glyph's
         * ink equals the composite, so overlaps write equal values. Returns the glyphs actually
         * emitted (run budget can drop stragglers).
         */
        @JvmStatic
        private fun buildRuns(
            drawable: MutableList<Selected>,
            outRuns: MutableList<ByteArray>,
        ): MutableList<Selected> {
            var sorted: MutableList<Selected> = ArrayList(drawable)
            sorted.sortWith(
                compareBy<Selected> { it.draw.fontId }
                    .thenBy { it.draw.y }
                    .thenBy { it.top }
                    .thenBy { it.gx }
            )
            var drawn: MutableList<Selected> = ArrayList(sorted.size)
            var i: Int = 0
            while (((i < sorted.size) && (outRuns.size < MAX_GLYPH_RUNS))) {
                var first: Selected = sorted.get(i)
                val fontResource = first.resourceId
                if ((fontResource < 0)) {
                    i++
                    continue
                }
                var string: ByteSink = ByteSink()
                var runGlyphs: MutableList<Selected> = ArrayList()
                var cursor: Int = first.gx
                var j: Int = i
                while ((j < sorted.size)) {
                    var sel: Selected = sorted.get(j)
                    if (
                        (((sel.draw.fontId != first.draw.fontId) || (sel.draw.y != first.draw.y)) ||
                            (sel.top != first.top))
                    ) {
                        break
                    }
                    var delta: Int = (sel.gx - cursor)
                    var adjustBytes: Int = adjustByteCount(delta)
                    if (((adjustBytes > MAX_ADJUST_BYTES) && (j > i))) {
                        break
                    }
                    if ((((string.size() + adjustBytes) + 1) > 255)) {
                        break
                    }
                    emitAdjust(string, delta)
                    string.write(sel.draw.encoding)
                    runGlyphs.add(sel)
                    cursor = (sel.gx + sel.glyphAtlas!!.width)
                    j++
                }
                if (!runGlyphs.isEmpty()) {
                    var stringBytes: ByteArray = string.toByteArray()
                    val run = ByteArray(9 + stringBytes.size)
                    run[0] = 20
                    run[1] = fontResource.toByte()
                    run[2] = (fontResource ushr 8).toByte()
                    run[3] = first.gx.toByte()
                    run[4] = (first.gx ushr 8).toByte()
                    run[5] = first.draw.y.toByte()
                    run[6] = (first.draw.y ushr 8).toByte()
                    run[7] = (first.top or 0x10).toByte()
                    run[8] = stringBytes.size.toByte()
                    stringBytes.copyInto(run, 9)
                    outRuns.add(run)
                    drawn.addAll(runGlyphs)
                    i = j
                } else {
                    i++
                }
            }
            return drawn
        }

        /** How many 1..31 control bytes are needed to move the cursor by delta. */
        private fun adjustByteCount(delta: Int): Int {
            if ((delta == 0)) {
                return 0
            }
            return (if ((delta > 0)) ((delta + 19) / 20) else ((-delta + 9) / 10))
        }

        private fun emitAdjust(out: ByteSink, delta: Int): Unit {
            var delta = delta
            while ((delta != 0)) {
                var step: Int = (if ((delta > 0)) minOf(delta, 20) else maxOf(delta, -10))
                out.write((step + 11))
                delta -= step
            }
        }

        /** [8][count]([len u16][sub])* — one atomic present for deltas + draws. */
        private fun assembleMode8(subs: MutableList<ByteArray>): ByteArray {
            var total: Int = 2
            for (sub in subs) {
                total += (2 + sub.size)
            }
            var out: ByteArray = ByteArray(total)
            out[0] = 8
            out[1] = (subs.size).toByte()
            var pos: Int = 2
            for (sub in subs) {
                out[pos] = ((sub.size and 0xff)).toByte()
                out[(pos + 1)] = (((sub.size shr 8) and 0xff)).toByte()
                pos += 2
                sub.copyInto(out, pos, 0, 0 + sub.size)
                pos += sub.size
            }
            return out
        }
    }

    constructor() {}

    class Result {
        /** Complete image payload: a mode-8 batch of rect deltas + cached draws. */
        @JvmField val payload: ByteArray

        /** Mode-22 evictions and mode-21 uploads to enqueue BEFORE the image message. */
        @JvmField val resourceCommands: MutableList<ByteArray>

        /** Next mode-3 frame id (deltas consumed some). */
        @JvmField val nextFid: Int

        @JvmField val rectCount: Int

        @JvmField val drawnGlyphs: Int

        @JvmField val runCount: Int

        @JvmField val drawnImages: Int

        @JvmField val fwGlyphs: Int

        @JvmField val fwRuns: Int

        @JvmField val bakedCandidates: Int

        @JvmField val uploadBytes: Int

        @JvmField val fullFrame: Boolean

        /**
         * Where the planning time went, in ms. This runs on the send thread, directly in the
         * input-to-display path, so the split is reported in the frame log: rects = finding the
         * changed region, match = checking each draw against the composite, cache =
         * residency/uploads plus run building, punch = clearing replayed draws out of a copy of the
         * frame, encode = compressing the leftover pixels.
         */
        @JvmField var rectsMs: Int = 0

        @JvmField var matchMs: Int = 0

        @JvmField var cacheMs: Int = 0

        @JvmField var punchMs: Int = 0

        @JvmField var encodeMs: Int = 0

        constructor(
            payload: ByteArray,
            resourceCommands: MutableList<ByteArray>,
            nextFid: Int,
            rectCount: Int,
            drawnGlyphs: Int,
            runCount: Int,
            drawnImages: Int,
            fwGlyphs: Int,
            fwRuns: Int,
            bakedCandidates: Int,
            uploadBytes: Int,
            fullFrame: Boolean,
        ) {
            this.payload = payload
            this.resourceCommands = resourceCommands
            this.nextFid = nextFid
            this.rectCount = rectCount
            this.drawnGlyphs = drawnGlyphs
            this.runCount = runCount
            this.drawnImages = drawnImages
            this.fwGlyphs = fwGlyphs
            this.fwRuns = fwRuns
            this.bakedCandidates = bakedCandidates
            this.uploadBytes = uploadBytes
            this.fullFrame = fullFrame
        }
    }

    /** One draw selected for on-glasses replay. */
    private class Selected {
        var resourceId: Int = -1

        @JvmField val draw: SurfaceCompositor.ScreenDraw

        @JvmField val glyphAtlas: GlyphAtlas.Glyph?

        @JvmField val imageAtlas: ImageAtlas.Entry?

        @JvmField val gx: Int

        @JvmField val top: Int

        constructor(
            draw: SurfaceCompositor.ScreenDraw,
            glyphAtlas: GlyphAtlas.Glyph?,
            imageAtlas: ImageAtlas.Entry?,
            gx: Int,
            top: Int,
        ) {
            this.draw = draw
            this.glyphAtlas = glyphAtlas
            this.imageAtlas = imageAtlas
            this.gx = gx
            this.top = top
        }
    }

    /** One punch task for an emitted firmware-font glyph. */
    private class FwPunch {
        @JvmField val entry: FwGlyphAtlas.Entry

        @JvmField val gx: Int

        @JvmField val gy: Int

        constructor(entry: FwGlyphAtlas.Entry, gx: Int, gy: Int) {
            this.entry = entry
            this.gx = gx
            this.gy = gy
        }
    }
}
