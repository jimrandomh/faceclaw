package com.faceclaw.app

import kotlin.test.*

/** The foreground window's overlay (a window context menu) in the shell scene. */
class WindowOverlayTest {
    private val width = 64
    private val height = 32

    /** A 4x4 masked-image presentation record at (x, y). */
    private fun maskedImage(x: Int, y: Int) = byteArrayOf(DrawRecordKind.MASKED_IMAGE.toByte()) +
        DrawProtocol.word(x) + DrawProtocol.word(y) + DrawProtocol.word(4) + DrawProtocol.word(4) +
        DrawProtocol.word(0) + byteArrayOf(0, 0, 0) + DrawProtocol.word(0) + ByteArray(16) { -1 }

    /** Shell scene bytes: 1x1 layers at (n, 0), with the given dims, then the overlay's index. */
    private fun shellScene(dims: List<Int>, overlayAt: Int): ByteArray {
        var bytes = DrawProtocol.word(dims.size)
        for ((n, dim) in dims.withIndex()) {
            bytes += listOf(n + 1, n, 0, 1, 1, dim, 0, 0).flatMap { DrawProtocol.word(it).toList() }.toByteArray() + byteArrayOf(-1)
        }
        return bytes + DrawProtocol.word(0) + DrawProtocol.word(overlayAt)
    }

    private fun composite(dims: List<Int>, overlayAt: Int): ShellScene {
        val c = SurfaceCompositor()
        c.configureScreen(width, height)
        c.configureSurface("app", 8, 4, 48, 24, 0, SurfaceCompositor.TRANSPARENCY_OPAQUE)
        // The window's own selection, then its overlay at a quarter brightness.
        val draws = maskedImage(0, 0) + byteArrayOf(DrawRecordKind.WINDOW_OVERLAY.toByte()) + DrawProtocol.word(64) + maskedImage(10, 10)
        c.submitSurface("app", ArrayByteReader(ByteArray(48 * 24) { 96 }), 0, 0, 48, 24, "menu", ArrayByteReader(draws))
        c.setShellScene(ArrayByteReader(shellScene(dims, overlayAt)))
        return c.composite().shellScene
    }

    /** The order of the scene's luts, layer images and overlay in its root list. */
    private fun order(scene: ShellScene): List<String> {
        val surfaces = IntArray(scene.layers.size) { 100 + it }
        val rows = IntArray(scene.retainedResources.size) { 200 + it }
        val calls = scene.calls(width, height, surfaces, rows)
        val overlay = scene.overlay.single().calls(intArrayOf(rows[1]), 0).first()
        fun layer(index: Int) = DrawProtocol.image(surfaces[index], index, 0, depth = DrawProtocol.addDepth(0, 0))
        return calls.mapNotNull { call ->
            when {
                call.contentEquals(overlay) -> "overlay"
                scene.layers.indices.any { call.contentEquals(layer(it)) } ->
                    "layer" + scene.layers.indices.first { call.contentEquals(layer(it)) }
                // The dims these tests use (a lut quantizes, so nearby factors share one).
                listOf(64, 128).any { call.contentEquals(DrawProtocol.lut(width, height, it)) } ->
                    "lut" + listOf(64, 128).first { call.contentEquals(DrawProtocol.lut(width, height, it)) }
                else -> null
            }
        }
    }

    @Test fun overlayDimsTheChromeAndPlaysUnderShellOverlays() {
        val scene = composite(listOf(256, 256, 256), 2)
        assertEquals(1, scene.selections.size)
        assertEquals(64, scene.overlayDim)
        assertEquals(listOf("layer0", "layer1", "lut64", "overlay", "layer2"), order(scene))
        assertTrue(scene.overlay.single().fingerprint in scene.fingerprint)
    }

    @Test fun aDimmingShellLayerIsTheOnlyDimAndStaysOnTop() {
        // The system menu over the window's menu: one dim, under the system menu only.
        assertEquals(listOf("layer0", "overlay", "lut64", "layer1"), order(composite(listOf(256, 64), 1)))
        // The popup switcher's dim rides on the chrome's first part; the overlay goes under it.
        assertEquals(listOf("overlay", "lut128", "layer0", "layer1"), order(composite(listOf(128, 256), 0)))
    }

    @Test fun overlayRendersOverTheChromeInThePreview() {
        val scene = composite(listOf(256), 1)
        val preview = scene.preview(ByteArray(width * height) { 96 }, width, height)
        // The window, its own selection and the chrome pixel at (0, 0) all dim; the overlay doesn't.
        assertTrue((preview[20 * width + 30].toInt() and 255) < 96)
        assertTrue((preview[5 * width + 9].toInt() and 255) < 240)
        assertTrue((preview[0].toInt() and 255) < 240)
        assertEquals(240, preview[14 * width + 18].toInt() and 255)
    }
}
