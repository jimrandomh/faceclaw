package com.faceclaw.app

/** One-shot scheduler; the owner acquires its rendering lock in [action]. */
internal expect fun scheduleDrawRedraw(delayMs: Int, action: () -> Unit): () -> Unit

private val drawTimeOrigin = kotlin.time.TimeSource.Monotonic.markNow()
internal fun drawAnimationTimeMs(): Long = drawTimeOrigin.elapsedNow().inWholeMilliseconds
