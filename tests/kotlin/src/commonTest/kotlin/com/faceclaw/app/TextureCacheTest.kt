package com.faceclaw.app

import kotlin.test.*

class TextureCacheTest {
    private fun u32(bytes: ByteArray, offset: Int): Int =
        (0..3).fold(0) { n, i -> n or ((bytes[offset + i].toInt() and 255) shl (i * 8)) }

    @Test
    fun offsetsAbove64KiBAndLazyFontSlotsRoundTripOnBothPlatforms() {
        val cache = TextureCacheState()
        val large = ImageAtlas.Entry(255, 255, ByteArray(255 * 255) { (it % 15 + 1).toByte() })
        repeat(3) { assertTrue(cache.ensureImage(it, large) >= 0) }
        val glyph = GlyphAtlas.Glyph(1, 1, 0, 1, 0, null, byteArrayOf(15))
        val offset = cache.ensureGlyph(42, 65, glyph)
        val table = cache.fontTableOffset(42)
        assertTrue(table > 65535)
        assertEquals(table + 384, offset)
        val memory = ByteArray(TextureCacheState.CACHE_SIZE)
        for (upload in cache.drainUploadPayloads(3600)) {
            assertEquals(18, upload[0].toInt())
            var pos = 1
            while (pos < upload.size) {
                val address = u32(upload, pos)
                val length = (upload[pos + 4].toInt() and 255) or ((upload[pos + 5].toInt() and 255) shl 8)
                upload.copyInto(memory, address, pos + 6, pos + 6 + length)
                pos += 6 + length
            }
            assertEquals(upload.size, pos)
        }
        assertEquals(offset, u32(memory, table + (65 - 32) * 4))
        assertContentEquals(glyph.cachedBytes, memory.copyOfRange(offset, offset + glyph.cachedBytes.size))
        assertEquals(offset, cache.ensureGlyph(42, 65, glyph))
        assertFalse(cache.hasPendingUploads())
        cache.reset()
        assertEquals(0, cache.usedBytes())
        assertEquals(384, cache.ensureGlyph(42, 65, glyph))
        assertTrue(cache.hasPendingUploads())
    }

    @Test
    fun plannerReusesResidencyAndReuploadsAfterReset() {
        val cache = TextureCacheState()
        val id = ImageAtlas.ensure("texture-test-white", 2, 2, ArrayByteReader(ByteArray(4) { -1 }))
        val pixels = ByteArray(8 * 4)
        for (y in 0..1) for (x in 0..1) pixels[y * 8 + x] = -1
        val packed = BmpUtil.pack4bppFromGray8(pixels, 8, 4)
        val draws = arrayOf(SurfaceCompositor.ScreenDraw.image(id, 0, 0))
        fun plan() = assertNotNull(TexturePlanner.plan(null, packed, 8, 4, draws, cache, 1, true, 8, testPlatform()))
        val cold = plan()
        assertEquals(1, cold.drawnImages)
        assertTrue(cold.uploads.isNotEmpty())
        val warm = plan()
        assertTrue(warm.uploads.isEmpty())
        assertContentEquals(cold.payload, warm.payload)
        cache.reset()
        assertTrue(plan().uploads.isNotEmpty())
        // Occlusion fails the correctness check and leaves the image baked.
        assertNull(TexturePlanner.plan(null, ByteArray(packed.size), 8, 4, draws, cache, 1, true, 8, testPlatform()))
    }

    @Test
    fun fullCacheResetsAndRetriesTheCurrentFrame() {
        val cache = TextureCacheState()
        val large = ImageAtlas.Entry(255, 255, ByteArray(255 * 255) { (it % 15 + 1).toByte() })
        var fillerId = -1
        while (cache.ensureImage(fillerId--, large) >= 0) {}
        // Fill the remaining tail, forcing the next real allocation to fail.
        val remaining = TextureCacheState.CACHE_SIZE - cache.usedBytes()
        while (cache.ensureImage(fillerId--, ImageAtlas.Entry(1, 1, byteArrayOf(15))) >= 0) {}
        assertTrue(remaining > 0)
        val generation = cache.generation()
        val id = ImageAtlas.ensure("texture-test-full", 2, 2, ArrayByteReader(ByteArray(4) { -1 }))
        val result = assertNotNull(TexturePlanner.plan(null, ByteArray(4) { -1 }, 4, 2,
            arrayOf(SurfaceCompositor.ScreenDraw.image(id, 0, 0)), cache, 1, true, 8, testPlatform()))
        assertEquals(generation + 1, cache.generation())
        assertEquals(1, result.drawnImages)
        assertTrue(cache.usedBytes() < 100)
        assertTrue(result.uploads.isNotEmpty())
    }

    @Test
    fun workingSetLargerThanTheCacheFallsBackWithoutAResetLoop() {
        val cache = TextureCacheState()
        val raster = ByteArray(255 * 255) { if (it % 2 == 0) 16 else 32 }
        val draws = (0..4).map {
            val id = ImageAtlas.ensure("oversized-working-set-$it", 255, 255, ArrayByteReader(raster))
            SurfaceCompositor.ScreenDraw.image(id, 0, 0)
        }.toTypedArray()
        val gray = ByteArray(256 * 256)
        repeat(255) { raster.copyInto(gray, it * 256, it * 255, (it + 1) * 255) }
        val result = assertNotNull(TexturePlanner.plan(null,
            BmpUtil.pack4bppFromGray8(gray, 256, 256), 256, 256, draws, cache, 1, true, 8, testPlatform()))
        assertEquals(1, cache.generation())
        assertEquals(4, result.drawnImages)
        assertEquals(1, result.bakedCandidates)
        assertTrue(cache.usedBytes() <= TextureCacheState.CACHE_SIZE)
    }
}
