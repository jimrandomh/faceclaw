package com.faceclaw.app

/** Immutable shell snapshot. Keys identify writable surfaces across repaints, not their pixels. */
class ShellScene(val layers: List<Layer>, val selections: List<MenuSelection> = emptyList()) {
    class Layer(val key: Int, val x: Int, val y: Int, val width: Int, val height: Int, val dim: Int, val packed: ByteArray, val selections: List<MenuSelection> = emptyList(), val depth: Int = 0)
    val allSelections = selections + layers.flatMap { it.selections }
    val fingerprint: String = layers.joinToString(";") { "${it.key},${it.x},${it.y},${it.width},${it.height},${it.dim},${it.depth},${CachedResource(it.packed).hash},${it.selections.joinToString { row -> row.fingerprint }}" } + selections.joinToString { it.fingerprint }
    fun calls(width: Int, height: Int, surfaces: IntArray, selected: IntArray): List<ByteArray> {
        val calls = ArrayList<ByteArray>(); var rowId = 0
        val now = drawAnimationTimeMs()
        for (row in selections) calls.addAll(row.calls(selected[rowId++], now))
        for ((index, layer) in layers.withIndex()) {
            if (layer.dim < 256) calls.add(DrawProtocol.lut(width, height, layer.dim))
            calls.add(DrawProtocol.image(surfaces[index], layer.x, layer.y, depth = layer.depth))
            for (row in layer.selections) calls.addAll(row.calls(selected[rowId++], now))
        }
        return calls
    }
    fun preview(screenGray: ByteArray, width: Int, height: Int, rightLens: Boolean = false): ByteArray {
        val screen = BmpUtil.pack4bppFromGray8(screenGray, width, height)
        val output = ByteArray(screen.size); val resources = HashMap<Int, ByteArray>()
        val surfaces = IntArray(layers.size) { id ->
            val layer = layers[id]; resources[id] = DrawProtocol.rawImage(layer.width, layer.height, layer.packed); id
        }
        val rows = IntArray(allSelections.size) { id -> resources[id + layers.size] = allSelections[id].resource.bytes; id + layers.size }
        resources[511] = DrawProtocol.displayList(calls(width, height, surfaces, rows))
        DisplayListRenderer(resources, rightLens = rightLens).render(511, DisplayListRenderer.Target(screen, width, height), DisplayListRenderer.Target(output, width, height))
        val target = DisplayListRenderer.Target(output, width, height)
        return ByteArray(width * height) { (target.get(it % width, it / width) * 16).toByte() }
    }
    internal class AnimatedPreview(val player: DisplayListPlayer, var pixels: ByteArray)

    internal fun animatedPreview(
        screenGray: ByteArray, width: Int, height: Int,
        schedule: (Int, () -> Unit) -> (() -> Unit),
    ): AnimatedPreview {
        val screen = BmpUtil.pack4bppFromGray8(screenGray, width, height)
        val output = ByteArray(screen.size)
        val resources = HashMap<Int, ByteArray>()
        val surfaces = IntArray(layers.size) { id ->
            val layer = layers[id]
            resources[id] = DrawProtocol.rawImage(layer.width, layer.height, layer.packed)
            id
        }
        val rows = IntArray(allSelections.size) { id ->
            resources[id + layers.size] = allSelections[id].resource.bytes
            id + layers.size
        }
        resources[511] = DrawProtocol.displayList(calls(width, height, surfaces, rows))
        val target = DisplayListRenderer.Target(output, width, height)
        lateinit var preview: AnimatedPreview
        val player = DisplayListPlayer(DisplayListRenderer(resources),
            DisplayListRenderer.Target(screen, width, height), target,
            clock = { drawAnimationTimeMs() }, schedule = schedule,
            displayed = { preview.pixels = ByteArray(width * height) { (target.get(it % width, it / width) * 16).toByte() } })
        preview = AnimatedPreview(player, screenGray)
        player.present(511)
        return preview
    }

    companion object {
        val EMPTY = ShellScene(emptyList())
        fun decode(reader: ByteReader): ShellScene {
            val count = reader.getShort().toInt() and 65535; require(count <= 64)
            val layers = ArrayList<Layer>()
            repeat(count) {
                require(reader.remaining() >= 16)
                val key = reader.getShort().toInt() and 65535
                val x = reader.getShort().toInt(); val y = reader.getShort().toInt()
                val w = reader.getShort().toInt() and 65535; val h = reader.getShort().toInt() and 65535
                val dim = reader.getShort().toInt() and 65535
                val selectionCount = reader.getShort().toInt() and 65535; require(selectionCount <= 64 && dim <= 256)
                val depth = reader.getShort().toInt(); require(depth in -128..127)
                require(w in 1..640 && h in 1..480 && 5 + (w + 1) / 2 * h <= 65536 && reader.remaining() >= w * h)
                val gray = ByteArray(w * h); reader.get(gray)
                val selections = List(selectionCount) { MenuSelection.read(reader, reader.get().toInt()) }
                layers.add(Layer(key, x, y, w, h, dim, BmpUtil.pack4bppFromGray8(gray, w, h), selections, depth))
            }
            require(reader.remaining() == 0)
            require(layers.sumOf { it.selections.size } + layers.size < 511)
            require(layers.map { it.key }.toSet().size == layers.size)
            return ShellScene(layers)
        }
    }
}
