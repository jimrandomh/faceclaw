package com.faceclaw.shared

/** NativeScript implements this Kotlin-owned contract in TypeScript. */
interface KotlinBridgeListener {
    fun transform(message: String): String
}

/**
 * Portable Kotlin at the same commonMain source path used by ios-port. Calls and callbacks are
 * synchronous on the caller's thread. The listener is used only during roundTrip and is never
 * retained.
 */
class KotlinBridge {
    fun platform(): String = PlatformInfo.name

    fun threadName(): String = PlatformInfo.threadName()

    fun isMainThread(): Boolean = PlatformInfo.isMainThread()

    fun greet(name: String): String = "Hello, $name, from Kotlin"

    fun roundTrip(message: String, listener: KotlinBridgeListener): String {
        val reply = listener.transform("Kotlin received: $message")
        // Consume the TypeScript return value, then return it across the bridge.
        return "Kotlin received callback: $reply"
    }
}

internal expect object PlatformInfo {
    val name: String

    fun threadName(): String

    fun isMainThread(): Boolean
}
