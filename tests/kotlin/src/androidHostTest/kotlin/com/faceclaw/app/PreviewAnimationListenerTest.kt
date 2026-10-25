package com.faceclaw.app

import java.util.Collections
import kotlin.test.*

/**
 * The phone mirror pulls previews only when told to, while the compositor's player advances an
 * animated display list on its own timer. It needs a notification after every redraw, the
 * settled one included, or it keeps a mid-slide frame. Host-only: it runs the real redraw thread.
 */
class PreviewAnimationListenerTest {
    // FrameDisplayListTest's menu golden (a 2x2 highlight sliding in to rest at (3, 2)),
    // restarted at 1 of its 240 ms so the slide is still in flight at the first pull. Not 0:
    // at exactly 0 the highlight is wholly above this 8x8 screen, so a pull in the same
    // millisecond as the submit (a warm JIT) would match the settled frame.
    private val menu = "077f0000000300020002000200022a00000096000000010002000200ffffffff0200080000ff24017e30020000000001812c8001812c1611010017328001812c16103001812c3023414031ff24017c30020000000001812c8001812c1611010017328001812c16103001812c30234140310200020001000103100400000000000000001f"
        .chunked(2).map { it.toInt(16).toByte() }.toByteArray().also { it.fill(0, 18, 22); it[18] = 1 }

    private fun settledPreview(): ByteArray {
        val reader = ArrayByteReader(menu)
        assertEquals(DrawRecordKind.DISPLAY_LIST, reader.get().toInt())
        val list = FrameDisplayList.read(reader, drawAnimationTimeMs() - 10_000)
        return ShellScene(emptyList(), listOf(list)).preview(ByteArray(64), 8, 8)
    }

    @Test fun mirrorIsNotifiedOfEachRedrawThroughTheSettledFrame() {
        val c = SurfaceCompositor()
        c.configureScreen(8, 8)
        c.configureSurface("app", 0, 0, 8, 8, 0, 0)
        val pulled = Collections.synchronizedList(ArrayList<ByteArray>())
        c.setPreviewAnimationListener { pulled.add(assertNotNull(c.previewComposite()).gray) }
        c.submitSurface("app", ArrayByteReader(ByteArray(64)), 0, 0, 8, 8, "menu", ArrayByteReader(menu))
        val settled = settledPreview()
        assertFalse(assertNotNull(c.previewComposite()).gray.contentEquals(settled), "the first pull is mid-slide")
        // Redraws are 45 ms apart; 150 ms without one means the player has stopped.
        val deadline = System.nanoTime() + 2_000_000_000L
        var count = -1
        while (System.nanoTime() < deadline && pulled.size != count) {
            count = pulled.size
            Thread.sleep(150)
        }
        assertEquals(count, pulled.size, "the player stops once the slide's timeline ends")
        assertTrue(pulled.size >= 2, "one notification per redraw")
        assertContentEquals(settled, pulled.last(), "the last notification's pull is the settled frame")
    }
}
