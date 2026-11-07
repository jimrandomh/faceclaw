@file:OptIn(ExperimentalJsExport::class)

package com.faceclaw.app

/**
 * What the browser demo's main thread uses of the shared Kotlin (see the .web.ts files in app/native): the
 * same compositor, display-list renderer and atlases the phones use, so the demo draws what the
 * glasses would. There is no BLE underneath; frames end at the compositor.
 *
 * ByteArray crosses as an Int8Array, without copying.
 */
@JsExport
class WebSurfaceCompositor(width: Int, height: Int) {
    private val compositor = SurfaceCompositor().also { it.configureScreen(width, height) }
    private val sizes = HashMap<String, Pair<Int, Int>>()
    private var sequence = 0

    fun configure(id: String, x: Int, y: Int, width: Int, height: Int, zOrder: Int, transparent: Boolean) {
        compositor.configureSurface(id, x, y, width, height, zOrder, if (transparent) 1 else 0)
        sizes[id] = width to height
    }

    fun remove(id: String) {
        sizes.remove(id)
        compositor.removeSurface(id)
    }

    fun hasSurface(id: String): Boolean = sizes.containsKey(id)

    fun visible(id: String, visible: Boolean) = compositor.setSurfaceVisible(id, visible)

    fun depth(id: String, depth: Int) = compositor.setSurfaceDepth(id, depth)

    fun dim(below: Int, factor: Double) {
        require(!factor.isNaN() && !factor.isInfinite())
        compositor.setUnderlayDim(below, (factor.coerceIn(0.0, 1.0) * 256).toInt())
    }

    fun blank(blanked: Boolean) = compositor.setBlanked(blanked)

    fun shell(data: ByteArray) = compositor.setShellScene(ArrayByteReader(data))

    /** Clipped to the surface, like the iOS facade: a frame racing a resize mustn't throw. */
    fun submit(id: String, data: ByteArray, x: Int, y: Int, width: Int, height: Int, draws: ByteArray?) {
        val (sw, sh) = sizes[id] ?: error("Unknown surface: $id")
        require(width > 0 && height > 0 && data.size == width * height)
        val left = maxOf(0, x)
        val right = minOf(sw, x + width)
        val top = maxOf(0, y)
        val bottom = minOf(sh, y + height)
        if (right <= left || bottom <= top) return
        val pixels =
            if (left == x && top == y && right - left == width && bottom - top == height) data
            else {
                val clipped = ByteArray((right - left) * (bottom - top))
                for (row in top until bottom) data.copyInto(
                    clipped,
                    (row - top) * (right - left),
                    (row - y) * width + left - x,
                    (row - y) * width + right - x,
                )
                clipped
            }
        compositor.submitSurface(
            id,
            ArrayByteReader(pixels),
            left,
            top,
            right - left,
            bottom - top,
            (++sequence).toString(),
            // Draw records describe a full surface; partial updates keep their baked pixels only.
            if (x == 0 && y == 0 && width == sw && height == sh) draws?.let { ArrayByteReader(it) } else null,
        )
    }

    fun composite(): ByteArray = compositor.composite().gray

    /** Called after each step of an animation the preview is replaying (see SurfaceCompositor). */
    fun setPreviewAnimationListener(listener: (() -> Unit)?) = compositor.setPreviewAnimationListener(listener)
}

@JsExport
object WebTextureAtlas {
    fun assignFontId(key: String, id: Int) = GlyphAtlas.assignFontId(key, id)

    fun registerGlyphs(data: ByteArray) = GlyphAtlas.register(ArrayByteReader(data))

    fun registerAaGlyphs(data: ByteArray) = GlyphAtlas.registerAa(ArrayByteReader(data))

    fun registerFirmwareGlyphs(data: ByteArray) = FwGlyphAtlas.register(ArrayByteReader(data))

    fun registerImage(key: String, id: Int, width: Int, height: Int, pixels: ByteArray) =
        ImageAtlas.ensureWithId(key, id, width, height, ArrayByteReader(pixels))
}

@JsExport
object WebProtocol {
    fun fontMetrics(path: String): ByteArray = LvglFontFile.getMetrics(path)

    fun fontGlyph(path: String, codePoint: Int): ByteArray = LvglFontFile.getGlyph(path, codePoint)
}
