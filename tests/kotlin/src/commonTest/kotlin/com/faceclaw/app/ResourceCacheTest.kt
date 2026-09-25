package com.faceclaw.app

import kotlin.test.*

class ResourceCacheTest {
    private fun resource(size: Int, value: Int) = CachedResource(ByteArray(size) { value.toByte() })
    private fun u16(bytes: ByteArray, offset: Int) = (bytes[offset].toInt() and 255) or ((bytes[offset + 1].toInt() and 255) shl 8)
    private fun u32(bytes: ByteArray, offset: Int) = u16(bytes, offset) or (u16(bytes, offset + 2) shl 16)
    private fun uploaded(commands: List<ByteArray>): Map<Int, ByteArray> {
        val resources = HashMap<Int, ByteArray>()
        val received = HashMap<Int, Int>()
        for (command in commands) {
            assertTrue(command.size <= 3600)
            if (command[0].toInt() != 21) continue
            var pos = 3
            val seen = HashSet<Int>()
            repeat(u16(command, 1)) {
                val id = u16(command, pos)
                assertTrue(id in 0..511 && seen.add(id))
                val total = u32(command, pos + 2)
                val offset = u16(command, pos + 6)
                val length = u16(command, pos + 8)
                assertEquals(received[id] ?: 0, offset)
                val bytes = resources.getOrPut(id) { ByteArray(total) }
                command.copyInto(bytes, offset, pos + 10, pos + 10 + length)
                received[id] = offset + length
                pos += 10 + length
            }
            assertEquals(command.size, pos)
        }
        resources.forEach { (id, data) -> assertEquals(data.size, received[id]) }
        return resources
    }

    @Test fun contentAddressingAndWireVector() {
        val cache = ResourceCacheState()
        val image = CachedResource(byteArrayOf(1, 1, 31))
        val ids = cache.prepare(listOf(image, CachedResource(image.bytes)))
        assertContentEquals(intArrayOf(0, 0), ids)
        val commands = cache.drainCommands(3600)
        assertEquals(22, commands.first()[0].toInt())
        assertEquals(512, u16(commands.first(), 1))
        assertEquals(511, u16(commands.first(), 1025))
        assertContentEquals(byteArrayOf(21, 1, 0, 0, 0, 3, 0, 0, 0, 0, 0, 3, 0, 1, 1, 31), commands.last())
        assertContentEquals(image.bytes, uploaded(commands).getValue(0))
        assertEquals(2068, cache.usedBytes())
        assertEquals(0, cache.prepare(listOf(image))[0])
        assertTrue(cache.drainCommands(3600).isEmpty())
        cache.reset(); cache.prepare(listOf(image))
        assertEquals(22, cache.drainCommands(3600).first()[0].toInt())
    }

    @Test fun exactly64KiBUploadsInBoundedContiguousChunks() {
        val cache = ResourceCacheState()
        val data = CachedResource(ByteArray(65536) { (it * 37).toByte() })
        assertEquals(0, cache.prepare(listOf(data))[0])
        val commands = cache.drainCommands(3600)
        assertTrue(commands.count { it[0].toInt() == 21 } > 1)
        assertContentEquals(data.bytes, uploaded(commands).getValue(0))
        assertEquals(-1, cache.prepare(listOf(resource(65537, 1)))[0])
        assertTrue(cache.drainCommands(3600).isEmpty())
        assertEquals(0, cache.resourceId(data))
    }

    @Test fun lruEvictsByBytesAndProtectsAllCurrentFrameHits() {
        val cache = ResourceCacheState()
        val a = resource(60000, 1); val b = resource(60000, 2); val c = resource(60000, 3); val d = resource(60000, 4)
        assertContentEquals(intArrayOf(0, 1, 2), cache.prepare(listOf(a, b, c)))
        cache.drainCommands(3600)
        cache.prepare(listOf(a)); cache.drainCommands(3600) // b is oldest now.
        assertContentEquals(intArrayOf(1, 2), cache.prepare(listOf(d, c))) // protect later hit c before d.
        val commands = cache.drainCommands(3600)
        assertContentEquals(byteArrayOf(22, 1, 0, 1, 0), commands.first())
        assertEquals(-1, cache.resourceId(b))
        assertEquals(0, cache.resourceId(a)); assertEquals(2, cache.resourceId(c))
        assertEquals(1, cache.resourceId(d))
        assertContentEquals(d.bytes, uploaded(commands).getValue(1))
        val tooLarge = cache.prepare(listOf(a, c, d, b))
        assertEquals(-1, tooLarge.last())
        assertTrue(cache.drainCommands(3600).isEmpty())
        assertEquals(3, cache.residentCount())
    }

    @Test fun idPressureUsesLruEvenWhenBytesAreAvailable() {
        val cache = ResourceCacheState()
        val resources = (0..512).map { CachedResource(byteArrayOf(it.toByte(), (it ushr 8).toByte())) }
        assertContentEquals(IntArray(512) { it }, cache.prepare(resources.take(512)))
        cache.drainCommands(3600)
        cache.prepare(listOf(resources[0])); cache.drainCommands(3600)
        assertEquals(1, cache.prepare(listOf(resources[512]))[0])
        val commands = cache.drainCommands(3600)
        assertContentEquals(byteArrayOf(22, 1, 0, 1, 0), commands.first())
        assertEquals(0, cache.resourceId(resources[0]))
        assertEquals(-1, cache.resourceId(resources[1]))
    }

    @Test fun rejectedPlansRestoreResidencyAndLru() {
        val cache = ResourceCacheState()
        val resources = (0..3).map { resource(65536, it) }
        cache.prepare(resources.take(3)); cache.drainCommands(3600)
        val rollback = cache.checkpoint()
        cache.prepare(listOf(resources[3]))
        assertEquals(-1, cache.resourceId(resources[0]))
        rollback()
        assertEquals(0, cache.resourceId(resources[0])); assertEquals(-1, cache.resourceId(resources[3]))
        assertTrue(cache.drainCommands(3600).isEmpty())
        cache.prepare(listOf(resources[3]))
        assertContentEquals(byteArrayOf(22, 1, 0, 0, 0), cache.drainCommands(3600).first())
    }

    @Test fun imagePlannerEmitsResourceIdsAndReusesResidency() {
        val cache = ResourceCacheState()
        val id = ImageAtlas.ensure("resource-test-white", 2, 2, ArrayByteReader(ByteArray(4) { -1 }))
        val pixels = ByteArray(8 * 4)
        for (y in 0..1) for (x in 0..1) pixels[y * 8 + x] = -1
        val packed = BmpUtil.pack4bppFromGray8(pixels, 8, 4)
        val draws = arrayOf(SurfaceCompositor.ScreenDraw.image(id, 0, 0))
        fun plan() = assertNotNull(TexturePlanner.plan(null, packed, 8, 4, draws, cache, 1, true, 8, testPlatform()))
        val cold = plan()
        assertEquals(1, cold.drawnImages)
        assertContentEquals(byteArrayOf(19, 0, 0, 0, 0, 0, 0, 31), cold.payload.takeLast(8).toByteArray())
        assertTrue(cold.resourceCommands.isNotEmpty())
        val warm = plan()
        assertTrue(warm.resourceCommands.isEmpty()); assertContentEquals(cold.payload, warm.payload)
        cache.reset(); assertTrue(plan().resourceCommands.isNotEmpty())
        assertNull(TexturePlanner.plan(null, ByteArray(packed.size), 8, 4, draws, cache, 1, true, 8, testPlatform()))
    }

    @Test fun imagePixelLoopsPreserveClippingTransparencyAndNeighborNibbles() {
        val width = 12
        val height = 8
        for (imageWidth in listOf(3, 4, 5, 9)) {
            val imageHeight = 5
            val pixels = ByteArray(imageWidth * imageHeight) { i ->
                if (i % 3 == 0) 0 else (((i % 15) + 1) * 16).toByte()
            }
            val id = ImageAtlas.ensure("pixel-loop-$imageWidth", imageWidth, imageHeight, ArrayByteReader(pixels))
            for (left in listOf(-1, 0, 1, 2, 10, 11, 14)) for (top in listOf(-1, 0, 1, 7, 9)) {
                val gray = ByteArray(width * height) { ((it % 15 + 1) * 16).toByte() }
                val visibleInk = ArrayList<Int>()
                for (row in 0 until imageHeight) for (col in 0 until imageWidth) {
                    val x = left + col; val y = top + row; val value = pixels[row * imageWidth + col]
                    if (x in 0 until width && y in 0 until height && value.toInt() != 0) {
                        gray[y * width + x] = value
                        visibleInk.add(y * width + x)
                    }
                }
                val expected = BmpUtil.pack4bppFromGray8(gray, width, height)
                val draws = arrayOf(SurfaceCompositor.ScreenDraw.image(id, left, top))
                val plan = TexturePlanner.plan(null, expected, width, height, draws, ResourceCacheState(), 1, true, 8, testPlatform())
                if (left < 0 || top < 0 || left >= width || top >= height) {
                    assertNull(plan) // The wire format cannot replay negative image origins.
                    continue
                }
                val result = assertNotNull(plan, "$imageWidth at $left,$top")
                assertEquals(1, result.drawnImages)
                val actual = ByteArray(expected.size) { 0x55 }
                DisplayListRenderer(uploaded(result.resourceCommands)).execute(
                    DrawProtocol.sequence(DrawProtocol.fromOptimized(result.payload, width, height)),
                    DisplayListRenderer.Target(actual, width, height))
                assertContentEquals(expected, actual, "$imageWidth at $left,$top")

                // A conflicting visible ink pixel must reject the cached draw.
                if (visibleInk.isNotEmpty()) {
                    val offset = visibleInk.first()
                    gray[offset] = 0
                    assertNull(TexturePlanner.plan(null, BmpUtil.pack4bppFromGray8(gray, width, height),
                        width, height, draws, ResourceCacheState(), 1, true, 8, testPlatform()))
                }
            }
        }
    }

    private fun registerFont(key: String, encodings: List<Int>, size: Int = 2): Int {
        val out = ByteSink(); val name = key.encodeToByteArray()
        out.write(name.size); out.write(name, 0, name.size); out.write(size)
        out.write(encodings.size); out.write(0)
        for (encoding in encodings) {
            out.write(encoding); repeat(3) { out.write(0) }
            out.write(0); out.write(0); out.write(size); out.write(size)
            repeat(size * ((size + 1) / 2)) { out.write(0x12) }
        }
        GlyphAtlas.registerAa(ArrayByteReader(out.toByteArray()))
        return GlyphAtlas.fontId(key)
    }

    @Test fun fontTablesUseRelativeU16OffsetsAndGrowOnDemand() {
        val id = registerFont("resource-font-relative", listOf(65, 66))
        val first = FontResourceAtlas.get(id, setOf(65))
        assertEquals(193, u16(first.resource.bytes, 1 + (65 - 32) * 2))
        assertEquals(0, u16(first.resource.bytes, 1 + (66 - 32) * 2))
        assertSame(first, FontResourceAtlas.get(id, setOf(65)))
        val second = FontResourceAtlas.get(id, setOf(66))
        assertTrue(second.encodings.containsAll(setOf(65, 66)))
        assertEquals(193 + GlyphAtlas.get(id, 65)!!.cachedBytes.size, u16(second.resource.bytes, 1 + (66 - 32) * 2))
        val cache = ResourceCacheState()
        cache.prepare(listOf(second.resource)); val commands = cache.drainCommands(3600)
        assertContentEquals(second.resource.bytes, uploaded(commands).getValue(0))
    }

    @Test fun oversizedFontsPrioritizeTheCurrentFrameWithin64KiB() {
        val id = registerFont("resource-font-limit", listOf(65, 66), 255)
        val a = FontResourceAtlas.get(id, setOf(65))
        assertEquals(setOf(65), a.encodings)
        val b = FontResourceAtlas.get(id, setOf(66))
        assertEquals(setOf(66), b.encodings)
        assertTrue(b.resource.bytes.size <= 65536)
        assertEquals(0, u16(b.resource.bytes, 1 + (65 - 32) * 2))
        assertEquals(193, u16(b.resource.bytes, 1 + (66 - 32) * 2))
    }
}
