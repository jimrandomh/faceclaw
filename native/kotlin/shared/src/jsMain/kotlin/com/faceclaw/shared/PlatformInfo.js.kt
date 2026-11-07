package com.faceclaw.shared

internal actual object PlatformInfo {
    actual val name: String = "Web"

    actual fun threadName(): String = "main"

    actual fun isMainThread(): Boolean = true
}
