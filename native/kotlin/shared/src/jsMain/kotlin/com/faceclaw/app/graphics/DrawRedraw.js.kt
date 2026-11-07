package com.faceclaw.app

private external fun setTimeout(handler: () -> Unit, timeout: Int): Int

private external fun clearTimeout(handle: Int)

internal actual fun scheduleDrawRedraw(delayMs: Int, action: () -> Unit): () -> Unit {
    val handle = setTimeout(action, delayMs)
    return { clearTimeout(handle) }
}
