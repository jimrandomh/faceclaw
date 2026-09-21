package com.faceclaw.app

import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic

/**
 * Retained-surface compositor: the phone-side model of what is on the glasses screen.
 *
 * Each surface is an 8bpp grayscale buffer retained at its last-submitted contents, positioned on
 * the screen with a z-order and a transparency mode. Sources on the TS side (today the dashboard;
 * later the shell and per-app worker threads) submit updates to their surface, and the compositor
 * recombines the retained surfaces into a full-screen frame that feeds the existing
 * dedupe/compress/transmit pipeline. Because every surface is retained, a full screen frame can be
 * regenerated at any time (frame drops, reconnects, previews, screenshots) without asking sources
 * to repaint.
 *
 * Surface format contract (mirrored by the TS side):
 * - Pixels are 8bpp grayscale, row-major, one byte per pixel. The wire pipeline quantizes to 4bpp
 *   downstream, so the low nibble is not visible.
 * - TRANSPARENCY_COLOR_KEY surfaces treat pixel value 0 as fully transparent and value 1 as black.
 *   Quantization collapses 1 into the same 4bpp level as 0, so reserving 0 costs no visible shade;
 *   painters of color-key surfaces must clamp intentional black to 1.
 * - An update may cover any rect of its surface; the rest is retained. The update buffer holds
 *   exactly rectWidth*rectHeight bytes, row-major.
 * - Surfaces composite in ascending z-order onto a black (0) background.
 * - Surface geometry changes take effect when the next frame composites; they do not trigger a
 *   recomposite by themselves.
 *
 * Thread safety: all methods are safe to call from any thread. Apply and composite happen
 * atomically under an internal lock, and each composite carries a monotonic sequence number so
 * callers can detect when a composite was superseded by a concurrent one before being acted on.
 */
class SurfaceCompositor {
    companion object {
        const val TRANSPARENCY_OPAQUE: Int = 0

        const val TRANSPARENCY_COLOR_KEY: Int = 1

        private val NO_DRAWS: Array<ScreenDraw> = emptyArray<ScreenDraw>()

        private fun dimValue(value: Int, dim: Int): Int {
            return maxOf(1, (((value * dim) + 128) shr 8))
        }

        private fun parseDraws(draws: ByteReader?): Array<ScreenDraw> {
            if (((draws == null) || (draws.remaining() < 1))) {
                return NO_DRAWS
            }
            val cursor: ByteReader = draws
            var out: MutableList<ScreenDraw> = ArrayList()
            while ((cursor.remaining() >= 1)) {
                var kind: Int = (cursor.get() and 0xff)
                if (((kind == ScreenDraw.KIND_GLYPH) && (cursor.remaining() >= 11))) {
                    var fontId: Int = (cursor.getShort().toInt() and 0xffff)
                    var encoding: Int = cursor.getInt()
                    var penX: Int = cursor.getShort().toInt()
                    var lineY: Int = cursor.getShort().toInt()
                    var value: Int = (cursor.get() and 0xff)
                    out.add(ScreenDraw.glyph(fontId, encoding, penX, lineY, value))
                } else {
                    if (((kind == ScreenDraw.KIND_IMAGE) && (cursor.remaining() >= 8))) {
                        var imageId: Int = cursor.getInt()
                        var x: Int = cursor.getShort().toInt()
                        var y: Int = cursor.getShort().toInt()
                        out.add(ScreenDraw.image(imageId, x, y))
                    } else {
                        if (((kind == ScreenDraw.KIND_FWTEXT) && (cursor.remaining() >= 6))) {
                            var x: Int = cursor.getShort().toInt()
                            var y: Int = cursor.getShort().toInt()
                            var value: Int = (cursor.get() and 0xff)
                            var count: Int = (cursor.get() and 0xff)
                            if ((cursor.remaining() < (count * 7))) {
                                break
                            }
                            var cps: IntArray = IntArray(count)
                            var dx: IntArray = IntArray(count)
                            var ink: BooleanArray = BooleanArray(count)
                            run {
                                var i: Int = 0
                                while ((i < count)) {
                                    cps[i] = cursor.getInt()
                                    dx[i] = cursor.getShort().toInt()
                                    ink[i] = (cursor.get().toInt() != 0)
                                    i++
                                }
                            }
                            out.add(ScreenDraw.fwText(x, y, value, cps, dx, ink))
                        } else {
                            break
                        }
                    }
                }
            }
            return out.toTypedArray()
        }
    }

    /**
     * One deferred draw (a text glyph or an icon image) within a frame, in screen coordinates. The
     * draw's pixels are already baked into the composited gray buffer (the TS side bakes before
     * submitting); this record preserves the draw's identity so the resource-cache planner can
     * replay it as an on-glasses cached draw instead of image bytes.
     *
     * Glyphs: x/y are the pen position and line top; the raster (and its bearing/cell placement)
     * comes from GlyphAtlas under (fontId, encoding). Images: x/y are the blit's top-left; the
     * raster comes from ImageAtlas under imageId.
     */
    class ScreenDraw {
        companion object {
            const val KIND_GLYPH: Int = 0

            const val KIND_IMAGE: Int = 1

            /** A firmware-builtin-font text run (CFW mode 15). */
            const val KIND_FWTEXT: Int = 2

            @JvmStatic
            fun glyph(fontId: Int, encoding: Int, penX: Int, lineY: Int, value: Int): ScreenDraw {
                return ScreenDraw(
                    KIND_GLYPH,
                    fontId,
                    encoding,
                    0,
                    penX,
                    lineY,
                    value,
                    null,
                    null,
                    null,
                )
            }

            @JvmStatic
            fun image(imageId: Int, x: Int, y: Int): ScreenDraw {
                return ScreenDraw(KIND_IMAGE, 0, 0, imageId, x, y, 0, null, null, null)
            }

            @JvmStatic
            fun fwText(
                x: Int,
                y: Int,
                value: Int,
                cps: IntArray,
                dx: IntArray,
                ink: BooleanArray,
            ): ScreenDraw {
                return ScreenDraw(KIND_FWTEXT, 0, 0, 0, x, y, value, cps, dx, ink)
            }
        }

        @JvmField val kind: Int

        /** Glyph draws only. */
        @JvmField val fontId: Int

        /** Glyph draws only. */
        @JvmField val encoding: Int

        /** Image draws only. */
        @JvmField val imageId: Int

        @JvmField val x: Int

        @JvmField val y: Int

        /** Glyph and fw-text draws: 8-bit brightness. */
        @JvmField val value: Int

        /** Fw-text runs only: member codepoints, in text order. */
        @JvmField val fwCps: IntArray?

        /** Fw-text runs only: member pen offsets relative to x. */
        @JvmField val fwDx: IntArray?

        /** Fw-text runs only: whether each member has visible pixels. */
        @JvmField val fwInk: BooleanArray?

        constructor(
            kind: Int,
            fontId: Int,
            encoding: Int,
            imageId: Int,
            x: Int,
            y: Int,
            value: Int,
            fwCps: IntArray?,
            fwDx: IntArray?,
            fwInk: BooleanArray?,
        ) {
            this.kind = kind
            this.fontId = fontId
            this.encoding = encoding
            this.imageId = imageId
            this.x = x
            this.y = y
            this.value = value
            this.fwCps = fwCps
            this.fwDx = fwDx
            this.fwInk = fwInk
        }
    }

    /** One composited full-screen frame plus the metadata the pipeline needs. */
    class Composite {
        /** Full-screen 8bpp grayscale pixels, screenWidth*screenHeight bytes. */
        @JvmField val gray: ByteArray

        @JvmField val width: Int

        @JvmField val height: Int

        /**
         * Stable identifier of screen content, combining every surface's geometry and content
         * fingerprint; equal fingerprints mean equal composited pixels.
         */
        @JvmField val fingerprint: String

        /** Monotonic: a Composite with a higher seq contains strictly newer state. */
        @JvmField val seq: Long

        /**
         * Screen-space deferred draws of every visible surface, in composite order (surface z
         * ascending, then each surface's draw order). Their pixels are already baked into gray.
         */
        @JvmField val draws: Array<ScreenDraw>?

        constructor(
            gray: ByteArray,
            width: Int,
            height: Int,
            fingerprint: String,
            seq: Long,
            draws: Array<ScreenDraw>?,
        ) {
            this.gray = gray
            this.width = width
            this.height = height
            this.fingerprint = fingerprint
            this.seq = seq
            this.draws = (if ((draws == null)) NO_DRAWS else draws)
        }
    }

    private class Surface {
        @JvmField val id: String

        @JvmField var x: Int = 0

        @JvmField var y: Int = 0

        @JvmField var width: Int = 0

        @JvmField var height: Int = 0

        @JvmField var zOrder: Int = 0

        @JvmField var transparency: Int = 0

        @JvmField var visible: Boolean = true

        @JvmField var pixels: ByteArray = ByteArray(0)

        @JvmField var fingerprint: String = ""

        /** Surface-local deferred draws of the retained content (already baked into pixels). */
        @JvmField var draws: Array<ScreenDraw> = NO_DRAWS

        constructor(id: String) {
            this.id = id
        }
    }

    private val lock = protocolPlatform().createLock()

    private var screenWidth: Int = 0

    private var screenHeight: Int = 0

    private var blanked: Boolean = false

    /** See setUnderlayDim: surfaces with zOrder below this are dimmed by underlayDim/256. */
    private var underlayDimBelowZOrder: Int = Int.MIN_VALUE

    private var underlayDim: Int = 256

    private val surfaces: MutableMap<String, Surface> = HashMap()

    private var nextCompositeSeq: Long = 1

    /** Set the output frame size. Must be called before any surface work. */
    fun configureScreen(width: Int, height: Int): Unit {
        if (((width <= 0) || (height <= 0))) {
            throw IllegalArgumentException(((("bad screen size " + width) + "x") + height))
        }
        lock.withLock {
            this.screenWidth = width
            this.screenHeight = height
        }
    }

    /**
     * Create a surface or update an existing one's geometry. A resize discards the surface's
     * retained pixels (reset to 0).
     */
    fun configureSurface(
        id: String?,
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        zOrder: Int,
        transparency: Int,
    ): Unit {
        if (((id == null) || id.isEmpty())) {
            throw IllegalArgumentException("surface id must be non-empty")
        }
        if (((width <= 0) || (height <= 0))) {
            throw IllegalArgumentException(
                ((((("bad surface size " + width) + "x") + height) + " for ") + id)
            )
        }
        if (((transparency != TRANSPARENCY_OPAQUE) && (transparency != TRANSPARENCY_COLOR_KEY))) {
            throw IllegalArgumentException(
                ((("bad transparency mode " + transparency) + " for ") + id)
            )
        }
        lock.withLock {
            requireScreenConfiguredLocked()
            var surface: Surface? = surfaces.get(id)
            if ((surface == null)) {
                surface = Surface(id)
                surfaces.put(id, surface)
            }
            if (
                (((surface.pixels == null) || (surface.width != width)) ||
                    (surface.height != height))
            ) {
                surface.pixels = ByteArray((width * height))
                surface.fingerprint = ""
                surface.draws = NO_DRAWS
            }
            surface.x = x
            surface.y = y
            surface.width = width
            surface.height = height
            surface.zOrder = zOrder
            surface.transparency = transparency
        }
    }

    fun removeSurface(id: String): Unit {
        lock.withLock {
            surfaces.remove(id)
        }
    }

    /**
     * Dim every surface whose zOrder is below belowZOrder to factor256/256 of its brightness (256 =
     * no dimming): how a shell overlay that dims what it covers (the TS Layer.dimUnderneath)
     * reaches the window surfaces beneath the shell surface, which the shell's own layer stack
     * cannot paint. Visible pixels stay at least 1 (the color-key black); glyph and firmware-text
     * draws keep their cached-draw form with a dimmed value; image draws leave the composite's draw
     * list (their pixels, already baked into the surface, dim as raster). Takes effect when the
     * next frame composites.
     */
    fun setUnderlayDim(belowZOrder: Int, factor256: Int): Unit {
        lock.withLock {
            underlayDimBelowZOrder = belowZOrder
            underlayDim = maxOf(0, minOf(256, factor256))
        }
    }

    /** The dim factor (256 = none) that applies to a surface. */
    private fun dimForLocked(surface: Surface): Int {
        return (if ((surface.zOrder < underlayDimBelowZOrder)) underlayDim else 256)
    }

    /**
     * Hidden surfaces keep their retained pixels and accept updates, but are excluded from the
     * composite and its fingerprint (used for background windows). Takes effect when the next frame
     * composites.
     */
    fun setSurfaceVisible(id: String, visible: Boolean): Unit {
        lock.withLock {
            var surface: Surface? = surfaces.get(id)
            if ((surface == null)) {
                throw IllegalArgumentException(("unknown surface " + id))
            }
            surface.visible = visible
        }
    }

    /**
     * While blanked (screen off), composites are all-zero regardless of surface content; retained
     * state is untouched, so unblanking restores the screen without asking sources to repaint.
     */
    fun setBlanked(blanked: Boolean): Unit {
        lock.withLock {
            this.blanked = blanked
        }
    }

    /**
     * Apply an update to one surface and composite the whole screen, as one atomic step. The update
     * covers the rect (rectX, rectY, rectWidth, rectHeight) in surface-local coordinates; pixels
     * must hold exactly rectWidth*rectHeight bytes. contentFingerprint identifies the surface's
     * full content after this update.
     */
    fun applyAndComposite(
        surfaceId: String,
        pixels: ByteReader,
        rectX: Int,
        rectY: Int,
        rectWidth: Int,
        rectHeight: Int,
        contentFingerprint: String,
    ): Composite {
        return applyAndComposite(
            surfaceId,
            pixels,
            rectX,
            rectY,
            rectWidth,
            rectHeight,
            contentFingerprint,
            null,
        )
    }

    /**
     * As above, with the frame's deferred draws: a little-endian buffer of tagged records
     * [0][fontId u16][encoding u32][penX s16][lineY s16][value u8] (glyph) [1][imageId u32][x
     * s16][y s16] (image) in surface-local coordinates and draw order. The list describes the
     * surface's FULL retained content and replaces the previous list, so it is only meaningful for
     * full-surface updates (which is what every submitter sends); pass null to clear. Draw pixels
     * must already be baked into pixels.
     */
    fun applyAndComposite(
        surfaceId: String,
        pixels: ByteReader?,
        rectX: Int,
        rectY: Int,
        rectWidth: Int,
        rectHeight: Int,
        contentFingerprint: String?,
        glyphs: ByteReader?,
    ): Composite =
        updateSurface(
            surfaceId,
            pixels,
            rectX,
            rectY,
            rectWidth,
            rectHeight,
            contentFingerprint,
            glyphs,
            true,
        )!!

    /** Retain pixels without recompositing; iOS coalesces updates before its frame callback. */
    fun submitSurface(
        surfaceId: String,
        pixels: ByteReader,
        rectX: Int,
        rectY: Int,
        rectWidth: Int,
        rectHeight: Int,
        fingerprint: String,
    ) = submitSurface(surfaceId, pixels, rectX, rectY, rectWidth, rectHeight, fingerprint, null)

    /** Retain the full surface's draw identities along with its already-baked pixels. */
    fun submitSurface(
        surfaceId: String,
        pixels: ByteReader,
        rectX: Int,
        rectY: Int,
        rectWidth: Int,
        rectHeight: Int,
        fingerprint: String,
        draws: ByteReader?,
    ) {
        updateSurface(
            surfaceId,
            pixels,
            rectX,
            rectY,
            rectWidth,
            rectHeight,
            fingerprint,
            draws,
            false,
        )
    }

    private fun updateSurface(
        surfaceId: String,
        pixels: ByteReader?,
        rectX: Int,
        rectY: Int,
        rectWidth: Int,
        rectHeight: Int,
        contentFingerprint: String?,
        glyphs: ByteReader?,
        composeAfter: Boolean,
    ): Composite? {
        var parsed: Array<ScreenDraw> = parseDraws(glyphs)
        lock.withLock {
            requireScreenConfiguredLocked()
            var surface: Surface? = surfaces.get(surfaceId)
            if ((surface == null)) {
                throw IllegalArgumentException(("unknown surface " + surfaceId))
            }
            if (
                ((((((rectX < 0) || (rectY < 0)) || (rectWidth <= 0)) || (rectHeight <= 0)) ||
                    ((rectX + rectWidth) > surface.width)) ||
                    ((rectY + rectHeight) > surface.height))
            ) {
                throw IllegalArgumentException(
                    (((((((((((((("update rect " + rectWidth) + "x") + rectHeight) + "+") + rectX) +
                        "+") + rectY) + " outside surface ") + surfaceId) + " (") + surface.width) +
                        "x") + surface.height) + ")")
                )
            }
            var expectedBytes: Int = (rectWidth * rectHeight)
            if (((pixels == null) || (pixels.remaining() != expectedBytes))) {
                throw IllegalArgumentException(
                    ((((("update buffer for " + surfaceId) + " has ") +
                        (if ((pixels == null)) 0 else pixels.remaining())) + " bytes, expected ") +
                        expectedBytes)
                )
            }
            run {
                var row: Int = 0
                while ((row < rectHeight)) {
                    var dstOffset: Int = (((rectY + row) * surface.width) + rectX)
                    pixels.get(surface.pixels, dstOffset, rectWidth)
                    row++
                }
            }
            surface.fingerprint = (if ((contentFingerprint == null)) "" else contentFingerprint)
            surface.draws = parsed
            return if (composeAfter) compositeLocked() else null
        }
    }

    /** Composite the current retained state without applying an update. */
    fun composite(): Composite {
        lock.withLock {
            requireScreenConfiguredLocked()
            return compositeLocked()
        }
    }

    /**
     * Current composited pixels for the phone-side preview / screenshot, or null before the screen
     * is configured. Does not consume a sequence number (it is never stored as the desired frame).
     */
    fun previewComposite(): Composite? {
        lock.withLock {
            if (((screenWidth <= 0) || (screenHeight <= 0))) {
                return null
            }
            var gray: ByteArray = buildGrayLocked()
            return Composite(gray, screenWidth, screenHeight, "preview", 0, NO_DRAWS)
        }
    }

    private fun buildGrayLocked(): ByteArray {
        var gray: ByteArray = ByteArray((screenWidth * screenHeight))
        if (blanked) {
            return gray
        }
        var ordered: MutableList<Surface> = ArrayList(surfaces.values)
        ordered.sortWith(compareBy<Surface> { it.zOrder }.thenBy { it.id })
        for (surface in ordered) {
            if (surface.visible) {
                blendLocked(gray, surface)
            }
        }
        return gray
    }

    private fun compositeLocked(): Composite {
        var gray: ByteArray = ByteArray((screenWidth * screenHeight))
        if (blanked) {
            return Composite(
                gray,
                screenWidth,
                screenHeight,
                ((("blanked:" + screenWidth) + "x") + screenHeight),
                nextCompositeSeq++,
                NO_DRAWS,
            )
        }
        var ordered: MutableList<Surface> = ArrayList(surfaces.values)
        ordered.sortWith(compareBy<Surface> { it.zOrder }.thenBy { it.id })
        var fingerprint: StringBuilder = StringBuilder()
        fingerprint.append(screenWidth).append('x').append(screenHeight)
        var draws: MutableList<ScreenDraw> = ArrayList()
        for (surface in ordered) {
            if (!surface.visible) {
                continue
            }
            blendLocked(gray, surface)
            var dim: Int = dimForLocked(surface)
            for (draw in surface.draws) {
                if (((dim < 256) && (draw.kind == ScreenDraw.KIND_IMAGE))) {
                    continue
                }
                var value: Int = (if ((dim < 256)) dimValue(draw.value, dim) else draw.value)
                draws.add(
                    ScreenDraw(
                        draw.kind,
                        draw.fontId,
                        draw.encoding,
                        draw.imageId,
                        (draw.x + surface.x),
                        (draw.y + surface.y),
                        value,
                        draw.fwCps,
                        draw.fwDx,
                        draw.fwInk,
                    )
                )
            }
            fingerprint
                .append('|')
                .append(surface.id)
                .append('@')
                .append(surface.x)
                .append(',')
                .append(surface.y)
                .append('+')
                .append(surface.width)
                .append('x')
                .append(surface.height)
                .append('#')
                .append(surface.zOrder)
                .append(':')
                .append(surface.transparency)
                .append(':')
                .append(surface.fingerprint)
            if ((dim < 256)) {
                fingerprint.append(":dim").append(dim)
            }
        }
        return Composite(
            gray,
            screenWidth,
            screenHeight,
            fingerprint.toString(),
            nextCompositeSeq++,
            draws.toTypedArray(),
        )
    }

    private fun blendLocked(gray: ByteArray, surface: Surface): Unit {
        var srcX: Int = maxOf(0, -surface.x)
        var srcY: Int = maxOf(0, -surface.y)
        var dstX: Int = maxOf(0, surface.x)
        var dstY: Int = maxOf(0, surface.y)
        var copyWidth: Int = minOf((surface.width - srcX), (screenWidth - dstX))
        var copyHeight: Int = minOf((surface.height - srcY), (screenHeight - dstY))
        if (((copyWidth <= 0) || (copyHeight <= 0))) {
            return
        }
        var dim: Int = dimForLocked(surface)
        run {
            var row: Int = 0
            while ((row < copyHeight)) {
                var srcOffset: Int = (((srcY + row) * surface.width) + srcX)
                var dstOffset: Int = (((dstY + row) * screenWidth) + dstX)
                if ((dim < 256)) {
                    run {
                        var col: Int = 0
                        while ((col < copyWidth)) {
                            var value: Int = (surface.pixels[(srcOffset + col)] and 0xff)
                            if ((value.toInt() != 0)) {
                                gray[(dstOffset + col)] = (dimValue(value, dim)).toByte()
                            } else {
                                if ((surface.transparency == TRANSPARENCY_OPAQUE)) {
                                    gray[(dstOffset + col)] = 0
                                }
                            }
                            col++
                        }
                    }
                } else {
                    if ((surface.transparency == TRANSPARENCY_OPAQUE)) {
                        surface.pixels.copyInto(gray, dstOffset, srcOffset, srcOffset + copyWidth)
                    } else {
                        run {
                            var col: Int = 0
                            while ((col < copyWidth)) {
                                var value: Byte = surface.pixels[(srcOffset + col)]
                                if ((value.toInt() != 0)) {
                                    gray[(dstOffset + col)] = value
                                }
                                col++
                            }
                        }
                    }
                }
                row++
            }
        }
    }

    private fun requireScreenConfiguredLocked(): Unit {
        if (((screenWidth <= 0) || (screenHeight <= 0))) {
            throw IllegalStateException("configureScreen must be called first")
        }
    }
}
