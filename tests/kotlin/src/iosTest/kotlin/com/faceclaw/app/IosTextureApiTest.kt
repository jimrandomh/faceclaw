package com.faceclaw.app

import kotlin.test.*

class IosTextureApiTest {
    private fun imageDraw(id: Int): ByteArray = byteArrayOf(
        1, id.toByte(), (id shr 8).toByte(), (id shr 16).toByte(), (id shr 24).toByte(), 0, 0, 0, 0,
    )

    @Test
    fun nativeSnapshotsPreserveDrawsAcrossCoalescingAndSessionResets() {
        val atlas = IosTextureAtlas()
        val white = ByteArray(4) { -1 }.data()
        val id = atlas.imageId("ios-texture-api-white", 2, 2, white)
        assertEquals(id, IosTextureAtlas().imageId("ios-texture-api-white", 2, 2, white))
        val compositor = IosSurfaceCompositor(8, 4)
        compositor.configure("app", 2, 0, 2, 2, 0, false)
        compositor.submitDraws("app", white, 0, 0, 2, 2, imageDraw(id).data())
        val frame = compositor.compositeFrame()
        assertEquals(2, frame.composite.draws!!.single().x)
        // A later update must not change the previously submitted snapshot.
        compositor.submit("app", ByteArray(4).data(), 0, 0, 2, 2)
        assertTrue(compositor.compositeFrame().composite.draws!!.isEmpty())
        val next = IosProtocol().pack(frame.pixels, 8, 4)
        val planner = IosTexturePlanner()
        val cold = assertNotNull(planner.plan(null, next, frame, 1))
        assertEquals(22, cold.resourceCommands.first().byteArray()[0].toInt())
        assertTrue(cold.resourceCommands.any { it.byteArray()[0].toInt() == 21 })
        assertEquals(8, cold.payload.byteArray()[0].toInt())
        val warm = assertNotNull(planner.plan(null, next, frame, 1))
        assertTrue(warm.resourceCommands.isEmpty())
        assertContentEquals(cold.payload.byteArray(), warm.payload.byteArray())
        planner.reset()
        assertTrue(assertNotNull(planner.plan(null, next, frame, 1)).resourceCommands.isNotEmpty())
        // A partial update clears identities even if the caller supplies stale draws.
        compositor.submitDraws("app", byteArrayOf(-1).data(), 0, 0, 1, 1, imageDraw(id).data())
        assertTrue(compositor.compositeFrame().composite.draws!!.isEmpty())
    }

    @Test
    fun glyphRegistrationAndDrawingUseTheSharedAsciiTable() {
        val atlas = IosTextureAtlas()
        val key = "ios-aa-texture-test"
        val bytes = key.encodeToByteArray()
        atlas.registerAaGlyphs((byteArrayOf(bytes.size.toByte()) + bytes +
            byteArrayOf(2, 1, 0, 65, 0, 0, 0, 0, 0, 2, 2, -1, -1)).data())
        val font = atlas.fontId(key)
        val draws = byteArrayOf(0, font.toByte(), (font shr 8).toByte(), 65, 0, 0, 0, 0, 0, 0, 0, -1)
        val compositor = IosSurfaceCompositor(4, 2)
        compositor.configure("text", 0, 0, 2, 2, 0, false)
        compositor.submitDraws("text", ByteArray(4) { -1 }.data(), 0, 0, 2, 2, draws.data())
        val frame = compositor.compositeFrame()
        val plan = assertNotNull(IosTexturePlanner().plan(null, IosProtocol().pack(frame.pixels, 4, 2), frame, 1))
        assertTrue(plan.usedBytes > 2048 + 192)
        val payload = plan.payload.byteArray()
        // The last mode-8 submessage is the shared mode-20 cached glyph run.
        assertEquals(20, payload[payload.size - 10].toInt())
        assertEquals(65, payload.last().toInt())
    }

    @Test
    fun oversizedPlanDiscardsUnsentResidencyBeforePixelFallback() {
        val atlas = IosTextureAtlas()
        val white = ByteArray(4) { -1 }.data()
        val id = atlas.imageId("ios-oversized-plan", 2, 2, white)
        var random = 12345
        val gray = ByteArray(640 * 480) {
            random = random xor (random shl 13)
            random = random xor (random ushr 17)
            random = random xor (random shl 5)
            random.toByte()
        }
        gray[0] = -1; gray[1] = -1; gray[640] = -1; gray[641] = -1
        val compositor = IosSurfaceCompositor(640, 480)
        compositor.configure("noise", 0, 0, 640, 480, 0, false)
        compositor.submitDraws("noise", gray.data(), 0, 0, 640, 480, imageDraw(id).data())
        val frame = compositor.compositeFrame()
        val planner = IosTexturePlanner()
        assertNull(planner.plan(null, IosProtocol().pack(frame.pixels, 640, 480), frame, 1))
        val small = IosSurfaceCompositor(4, 2)
        small.configure("icon", 0, 0, 2, 2, 0, false)
        small.submitDraws("icon", white, 0, 0, 2, 2, imageDraw(id).data())
        val next = small.compositeFrame()
        val retry = assertNotNull(planner.plan(null, IosProtocol().pack(next.pixels, 4, 2), next, 1))
        assertTrue(retry.resourceCommands.isNotEmpty(), "the rejected plan's image was never uploaded")
    }
}
