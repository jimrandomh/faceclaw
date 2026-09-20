package com.faceclaw.app

/** OS services used by the protocol state machines; supplied by their owner. */
interface ProtocolPlatform {
    /** Monotonic milliseconds since boot, including time spent asleep. */
    fun elapsedRealtimeMs(): Long

    fun createLock(): ProtocolLock

    fun createDeflater(): ProtocolDeflater
}

/** Must be reentrant: transport encoding can reset its history under the lock. */
interface ProtocolLock {
    fun lock()

    fun unlock()
}

/** Persistent zlib stream. Each write completes a SYNC_FLUSH, not a new stream. */
interface ProtocolDeflater {
    fun reset()

    fun syncFlush(message: ByteArray): ByteArray

    fun close()
}

internal inline fun <T> ProtocolLock.withLock(action: () -> T): T {
    lock()
    try {
        return action()
    } finally {
        unlock()
    }
}

enum class GattWriteMode {
    WITH_RESPONSE,
    WITHOUT_RESPONSE,
}

/** Keeps message callbacks independent of java.lang.Runnable. */
fun interface MessageCallback {
    fun run()
}
