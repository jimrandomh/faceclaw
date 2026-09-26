package com.faceclaw.shared

import platform.Foundation.NSThread

internal actual object PlatformInfo {
    actual val name: String = "iOS"

    actual fun threadName(): String =
        NSThread.currentThread.name?.takeIf { it.isNotEmpty() }
            ?: if (NSThread.isMainThread) "main" else "background"

    actual fun isMainThread(): Boolean = NSThread.isMainThread
}
