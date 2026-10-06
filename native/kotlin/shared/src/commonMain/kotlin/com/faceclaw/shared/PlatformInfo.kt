package com.faceclaw.shared

internal expect object PlatformInfo {
    val name: String

    fun threadName(): String

    fun isMainThread(): Boolean
}
