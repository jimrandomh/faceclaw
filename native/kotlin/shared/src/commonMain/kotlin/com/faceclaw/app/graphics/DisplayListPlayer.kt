package com.faceclaw.app

/**
 * PRESENT resets the clock; timer redraws preserve it. The owner serializes
 * calls and supplies a cancellable 45 ms scheduler on its rendering thread.
 */
class DisplayListPlayer(
    private val renderer: DisplayListRenderer,
    private val screen: DisplayListRenderer.Target,
    private val composition: DisplayListRenderer.Target,
    private val clock: () -> Long,
    private val schedule: (Int, () -> Unit) -> (() -> Unit),
    private val displayed: () -> Unit,
) {
    private var root = DrawProtocol.SCREEN
    private var origin = 0L
    private var generation = 0
    private var cancel: (() -> Unit)? = null

    fun present(root: Int) {
        stop()
        this.root = root
        origin = clock()
        draw(generation)
    }

    fun stop() {
        generation++
        cancel?.invoke()
        cancel = null
    }

    private fun draw(token: Int) {
        if (token != generation) return
        cancel = null
        renderer.render(root, screen, composition, (clock() - origin).coerceAtLeast(0))
        displayed()
        if (token == generation && renderer.animationPending) {
            cancel = schedule(45) { draw(token) }
        }
    }
}
