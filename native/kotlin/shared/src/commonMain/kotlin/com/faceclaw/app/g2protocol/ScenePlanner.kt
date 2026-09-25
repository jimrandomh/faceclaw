package com.faceclaw.app

import kotlin.jvm.JvmOverloads

/** The delta base contains only app pixels. Shell resources are composed at presentation. */
class ScenePlanner(private val cache: ResourceCacheState) {
    class Plan(val commands: List<ByteArray>, val nextFid: Int)
    private val owned = HashMap<String, CachedResource>()
    private val pixels = HashMap<String, ByteArray>()
    private var previous: ByteArray? = null
    private var screenWidth = 0
    private var screenHeight = 0
    private var epoch = -1
    private var root = -1
    @JvmOverloads
    fun plan(screen: ByteArray, width: Int, height: Int, draws: Array<SurfaceCompositor.ScreenDraw>?, scene: ShellScene, firstId: Int, textures: Boolean = true, incremental: Boolean = true, multiRect: Boolean = true, maxRects: Int = 6): Plan {
        require(width in 1..640 && height in 1..480)
        if (epoch != cache.generation) { previous = null; pixels.clear(); root = -1; epoch = cache.generation }
        require(screen.size == ((width + 1) / 2) * height)
        if (width != screenWidth || height != screenHeight) previous = null
        screenWidth = width; screenHeight = height
        val commands = ArrayList<ByteArray>()
        val keys = scene.layers.map { "shell:${it.key}:${it.width}x${it.height}" }
        val surfaces = scene.layers.mapIndexed { i, layer -> owned.getOrPut(keys[i]) {
            CachedResource(DrawProtocol.rawImage(layer.width, layer.height), keys[i])
        } }
        owned.keys.retainAll(keys.toSet()); pixels.keys.retainAll(keys.toSet())
        val selectedResources = scene.retainedResources
        cache.pin(surfaces + selectedResources)
        val absent = surfaces.map { cache.resourceId(it) < 0 }
        val prepared = cache.prepare(surfaces + selectedResources)
        val ids = prepared.copyOfRange(0, surfaces.size)
        val selectedIds = prepared.copyOfRange(surfaces.size, prepared.size)
        check(prepared.all { it >= 0 }) { "Shell surfaces exceed the resource budget" }
        commands.addAll(cache.drainCommands(3600))
        val rootCalls = scene.calls(width, height, ids, selectedIds)
        for ((i, layer) in scene.layers.withIndex()) {
            val old = if (absent[i]) null else pixels[keys[i]]
            commands.addAll(DrawProtocol.messages(pixelCalls(old, layer.packed, layer.width, layer.height, ids[i])))
            pixels[keys[i]] = layer.packed
        }
        val base = if (incremental) previous else null
        val texture = if (textures) TexturePlanner.plan(base, screen, width, height, draws, cache, firstId, multiRect, maxRects) else null
        if (texture != null) {
            commands.addAll(texture.resourceCommands)
            commands.addAll(DrawProtocol.messages(DrawProtocol.fromOptimized(texture.payload, width, height)))
        } else commands.addAll(DrawProtocol.messages(pixelCalls(base, screen, width, height, null)))
        val list = CachedResource(DrawProtocol.displayList(rootCalls))
        val rootId = cache.prepare(listOf(list))[0]
        check(rootId >= 0) { "No space for root display list" }
        commands.addAll(cache.drainCommands(3600))
        cache.pin(surfaces + selectedResources + list)
        val evicted = commands.any { it[0].toInt() == ResourceCacheState.EVICT_MODE }
        if (evicted) commands.add(0, DrawProtocol.root(DrawProtocol.SCREEN))
        if (root != rootId || evicted) commands.add(DrawProtocol.root(rootId))
        commands.add(byteArrayOf(DrawProtocol.PRESENT.toByte()))
        root = rootId; previous = screen.copyOf()
        return Plan(commands, texture?.nextFid ?: firstId)
    }
    private fun pixelCalls(old: ByteArray?, next: ByteArray, width: Int, height: Int, target: Int?): List<ByteArray> {
        val stride = (width + 1) / 2
        if (old != null && old.contentEquals(next)) return emptyList()
        val calls = ArrayList<ByteArray>()
        for (top in 0 until height step 32) {
            val rows = minOf(32, height - top)
            if (old != null && (top * stride until (top + rows) * stride).all { old[it] == next[it] }) continue
            var left = width; var right = -1
            for (y in top until top + rows) for (x in 0 until width) {
                val p = y * stride + x / 2; val shift = if (x % 2 == 0) 4 else 0
                if (old == null || (((old[p].toInt() xor next[p].toInt()) ushr shift) and 15) != 0) { left = minOf(left, x); right = maxOf(right, x) }
            }
            if (right < left) continue
            if (width % 4 == 0 && rows % 2 == 0) { left = left / 4 * 4; right = minOf(width, ((right + 4) / 4) * 4) - 1 }
            calls.add(DrawProtocol.bbox(next, stride, left, top, right - left + 1, rows, target))
        }
        return calls
    }
}
