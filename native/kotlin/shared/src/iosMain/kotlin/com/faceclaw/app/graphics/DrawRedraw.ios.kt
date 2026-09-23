package com.faceclaw.app

import platform.darwin.DISPATCH_TIME_NOW
import platform.darwin.dispatch_after
import platform.darwin.dispatch_get_main_queue
import platform.darwin.dispatch_time

internal actual fun scheduleDrawRedraw(delayMs: Int, action: () -> Unit): () -> Unit {
    val lock = protocolPlatform().createLock()
    var cancelled = false
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, delayMs.toLong() * 1_000_000L), dispatch_get_main_queue()) {
        if (lock.withLock { !cancelled }) action()
    }
    return { lock.withLock { cancelled = true } }
}
