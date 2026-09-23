package com.faceclaw.app

import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

private object DrawRedrawScheduler {
    val executor = ScheduledThreadPoolExecutor(1) { task ->
        Thread(task, "Faceclaw draw animation").apply { isDaemon = true }
    }.apply { removeOnCancelPolicy = true }
}

internal actual fun scheduleDrawRedraw(delayMs: Int, action: () -> Unit): () -> Unit {
    val future = DrawRedrawScheduler.executor.schedule(action, delayMs.toLong(), TimeUnit.MILLISECONDS)
    return { future.cancel(false); Unit }
}
