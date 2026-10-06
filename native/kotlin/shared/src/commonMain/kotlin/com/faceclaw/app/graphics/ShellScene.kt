package com.faceclaw.app

/**
 * Immutable shell snapshot. Keys identify writable surfaces across repaints, not their pixels.
 * [screenDepth] is the stereo depth of the whole presentation: the screen copy and everything
 * drawn over it shift together per lens (see [calls]).
 */
class ShellScene(val layers: List<Layer>, val selections: List<RetainedDrawing> = emptyList(), val screenDepth: Int = 0) {
    class Layer(val key: Int, val x: Int, val y: Int, val width: Int, val height: Int, val dim: Int, val packed: ByteArray, val selections: List<RetainedDrawing> = emptyList(), val depth: Int = 0) {
        // Layers are reused by every composite until the shell repaints, and hashing packed
        // byte-by-byte on each one was a measurable share of the compositor's time.
        internal val fingerprint: String by lazy {
            "$key,$x,$y,$width,$height,$dim,$depth,${CachedResource(packed).hash},${selections.joinToString { row -> row.fingerprint }}"
        }
    }
    val allSelections = selections + layers.flatMap { it.selections }
    val retainedResources = allSelections.flatMap { it.resources }
    init { require(retainedResources.size + layers.size < 511 && screenDepth in -128..127) }
    val fingerprint: String = layers.joinToString(";") { it.fingerprint } + selections.joinToString { it.fingerprint } + "|depth:$screenDepth"
    /**
     * The root list. A nonzero [screenDepth] adds to every positional call's own depth, so the
     * scene moves as one; depths are even (see uiDepthSetting) so the per-lens halves add
     * exactly. Dim LUTs stay put: they cover the whole target, and a shifted one would leave an
     * undimmed strip at one edge.
     */
    fun calls(width: Int, height: Int, surfaces: IntArray, selected: IntArray): List<ByteArray> {
        val calls = ArrayList<ByteArray>(); var rowId = 0
        val now = drawAnimationTimeMs()
        fun shifted(call: ByteArray) = DrawProtocol.withAddedDepth(call, screenDepth)
        calls.addAll(DrawProtocol.screenCopy(width, height, screenDepth))
        fun add(row: RetainedDrawing) {
            for (call in row.calls(selected.copyOfRange(rowId, rowId + row.resources.size), now)) calls.add(shifted(call))
            rowId += row.resources.size
        }
        for (row in selections) add(row)
        for ((index, layer) in layers.withIndex()) {
            if (layer.dim < 256) calls.add(DrawProtocol.lut(width, height, layer.dim))
            calls.add(DrawProtocol.image(surfaces[index], layer.x, layer.y, depth = DrawProtocol.addDepth(layer.depth, screenDepth)))
            for (row in layer.selections) add(row)
        }
        return calls
    }
    /** This scene without its whole-presentation shift: the phone mirror's view (see SurfaceCompositor.previewScene). */
    fun unshifted(): ShellScene = if (screenDepth == 0) this else ShellScene(layers, selections, 0)

    fun preview(screenGray: ByteArray, width: Int, height: Int, rightLens: Boolean = false): ByteArray {
        val screen = BmpUtil.pack4bppFromGray8(screenGray, width, height)
        val output = ByteArray(screen.size)
        DisplayListRenderer(rendererResources(width, height), rightLens = rightLens).render(511, DisplayListRenderer.Target(screen, width, height), DisplayListRenderer.Target(output, width, height))
        val target = DisplayListRenderer.Target(output, width, height)
        return ByteArray(width * height) { (target.get(it % width, it / width) * 16).toByte() }
    }

    /**
     * [screen] (packed 4bpp) with this scene's own retained drawings and its bottom [layerCount]
     * layers drawn in, for a frame whose shell exceeds the resource budget (see ScenePlanner.plan).
     * Both lenses share the result, so stereo depth is dropped, and animations are drawn settled.
     */
    fun flatten(screen: ByteArray, width: Int, height: Int, layerCount: Int): ByteArray {
        val baked = ShellScene(layers.take(layerCount), selections)
        val output = ByteArray(screen.size)
        DisplayListRenderer(baked.rendererResources(width, height), flat = true).render(511,
            DisplayListRenderer.Target(screen, width, height), DisplayListRenderer.Target(output, width, height), SETTLED_MS)
        return output
    }

    /** Layer surfaces, then retained resources, by index, and the root list at 511. */
    private fun rendererResources(width: Int, height: Int): HashMap<Int, ByteArray> {
        val resources = HashMap<Int, ByteArray>()
        val surfaces = IntArray(layers.size) { id ->
            val layer = layers[id]; resources[id] = DrawProtocol.rawImage(layer.width, layer.height, layer.packed); id
        }
        val rows = IntArray(retainedResources.size) { id -> resources[id + layers.size] = retainedResources[id].bytes; id + layers.size }
        resources[511] = DrawProtocol.displayList(calls(width, height, surfaces, rows))
        return resources
    }
    internal class AnimatedPreview(val player: DisplayListPlayer, var pixels: ByteArray)

    internal fun animatedPreview(
        screenGray: ByteArray, width: Int, height: Int,
        schedule: (Int, () -> Unit) -> (() -> Unit),
    ): AnimatedPreview {
        val screen = BmpUtil.pack4bppFromGray8(screenGray, width, height)
        val output = ByteArray(screen.size)
        val target = DisplayListRenderer.Target(output, width, height)
        lateinit var preview: AnimatedPreview
        val player = DisplayListPlayer(DisplayListRenderer(rendererResources(width, height)),
            DisplayListRenderer.Target(screen, width, height), target,
            clock = { drawAnimationTimeMs() }, schedule = schedule,
            displayed = { preview.pixels = ByteArray(width * height) { (target.get(it % width, it / width) * 16).toByte() } })
        preview = AnimatedPreview(player, screenGray)
        player.present(511)
        return preview
    }

    companion object {
        val EMPTY = ShellScene(emptyList())
        /** Past every animation's end: TIME counts from PRESENT and clamps to the animation's length. */
        private const val SETTLED_MS = 3_600_000L
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
                val selections = List(selectionCount) { readRetainedDrawing(reader, reader.get().toInt()) }
                layers.add(Layer(key, x, y, w, h, dim, BmpUtil.pack4bppFromGray8(gray, w, h), selections, depth))
            }
            require(reader.remaining() == 2)
            val screenDepth = reader.getShort().toInt()
            require(layers.sumOf { layer -> layer.selections.sumOf { it.resources.size } } + layers.size < 511)
            require(layers.map { it.key }.toSet().size == layers.size)
            return ShellScene(layers, screenDepth = screenDepth)
        }
    }
}
