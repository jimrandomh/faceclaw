package com.faceclaw.app

/**
 * Immutable shell snapshot. Keys identify writable surfaces across repaints, not their pixels.
 * [screenDepth] is the stereo depth of the whole presentation: the screen copy and everything
 * drawn over it shift together per lens (see [calls]).
 *
 * [overlay] is the foreground window's overlay (a window context menu): retained drawings that
 * play after the window's own [selections] and the shell's chrome, before layer [overlayAt] (the
 * first shell overlay, such as the system menu), so the window can dim the chrome too. First it
 * dims everything drawn so far by [overlayDim]/256, unless a shell layer dims: that layer then
 * comes after the overlay and is the only dim, so no pixel is dimmed twice.
 */
class ShellScene(
    val layers: List<Layer>,
    val selections: List<RetainedDrawing> = emptyList(),
    val screenDepth: Int = 0,
    val overlay: List<RetainedDrawing> = emptyList(),
    val overlayDim: Int = 256,
    val overlayAt: Int = layers.size,
) {
    class Layer(val key: Int, val x: Int, val y: Int, val width: Int, val height: Int, val dim: Int, val packed: ByteArray, val selections: List<RetainedDrawing> = emptyList(), val depth: Int = 0) {
        // Layers are reused by every composite until the shell repaints, and hashing packed
        // byte-by-byte on each one was a measurable share of the compositor's time.
        internal val fingerprint: String by lazy {
            "$key,$x,$y,$width,$height,$dim,$depth,${CachedResource(packed).hash},${selections.joinToString { row -> row.fingerprint }}"
        }
    }
    /** Every retained drawing, in the order [calls] plays them. */
    val allSelections = selections + layers.take(overlayAt).flatMap { it.selections } + overlay +
        layers.drop(overlayAt).flatMap { it.selections }
    val retainedResources = allSelections.flatMap { it.resources }
    init {
        require(retainedResources.size + layers.size < 511 && screenDepth in -128..127)
        require(overlayAt in 0..layers.size && overlayDim in 0..256)
    }
    val fingerprint: String = layers.joinToString(";") { it.fingerprint } + selections.joinToString { it.fingerprint } + "|depth:$screenDepth" +
        "|overlay@$overlayAt:$overlayDim:" + overlay.joinToString { it.fingerprint }
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
        fun addOverlay() {
            if (overlayDim < 256 && layers.none { it.dim < 256 }) calls.add(DrawProtocol.lut(width, height, overlayDim))
            for (row in overlay) add(row)
        }
        for ((index, layer) in layers.withIndex()) {
            if (index == overlayAt) addOverlay()
            if (layer.dim < 256) calls.add(DrawProtocol.lut(width, height, layer.dim))
            calls.add(DrawProtocol.image(surfaces[index], layer.x, layer.y, depth = DrawProtocol.addDepth(layer.depth, screenDepth)))
            for (row in layer.selections) add(row)
        }
        if (overlayAt == layers.size) addOverlay()
        return calls
    }
    /** This scene without its whole-presentation shift: the phone mirror's view (see SurfaceCompositor.previewScene). */
    fun unshifted(): ShellScene = if (screenDepth == 0) this else ShellScene(layers, selections, 0, overlay, overlayDim, overlayAt)

    fun preview(screenGray: ByteArray, width: Int, height: Int, rightLens: Boolean = false): ByteArray {
        val screen = BmpUtil.pack4bppFromGray8(screenGray, width, height)
        val output = ByteArray(screen.size); val resources = HashMap<Int, ByteArray>()
        val surfaces = IntArray(layers.size) { id ->
            val layer = layers[id]; resources[id] = DrawProtocol.rawImage(layer.width, layer.height, layer.packed); id
        }
        val rows = IntArray(retainedResources.size) { id -> resources[id + layers.size] = retainedResources[id].bytes; id + layers.size }
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
        val rows = IntArray(retainedResources.size) { id ->
            resources[id + layers.size] = retainedResources[id].bytes
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
                val selections = List(selectionCount) { readRetainedDrawing(reader, reader.get().toInt()) }
                layers.add(Layer(key, x, y, w, h, dim, BmpUtil.pack4bppFromGray8(gray, w, h), selections, depth))
            }
            require(reader.remaining() == 4)
            val screenDepth = reader.getShort().toInt()
            val overlayAt = reader.getShort().toInt() and 65535; require(overlayAt <= layers.size)
            require(layers.sumOf { layer -> layer.selections.sumOf { it.resources.size } } + layers.size < 511)
            require(layers.map { it.key }.toSet().size == layers.size)
            return ShellScene(layers, screenDepth = screenDepth, overlayAt = overlayAt)
        }
    }
}
