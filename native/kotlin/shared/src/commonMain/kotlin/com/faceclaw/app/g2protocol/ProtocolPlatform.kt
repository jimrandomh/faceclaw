package com.faceclaw.app

/** OS services used by the protocol state machines; supplied by their owner. */
interface ProtocolPlatform {
    /** Monotonic milliseconds since boot, including time spent asleep. */
    fun elapsedRealtimeMs(): Long

    fun createLock(): ProtocolLock

    fun createDeflater(): ProtocolDeflater

    /** A mutex plus condition variable for blocking waits (see [ProtocolCondition]). */
    fun createCondition(): ProtocolCondition
}

/**
 * Mutex + condition variable. NOT reentrant: iOS backs it with NSCondition, so a thread that
 * already holds the lock must not lock it again (Android's implementation would tolerate it
 * and hide the bug). Hold the lock while calling [awaitMs] and [signalAll].
 */
interface ProtocolCondition {
    fun lock()

    fun unlock()

    /** Waits up to [timeoutMs] (spurious wake-ups possible); the lock is held again on return. */
    fun awaitMs(timeoutMs: Long)

    fun signalAll()
}

inline fun <T> ProtocolCondition.withLock(action: () -> T): T {
    lock()
    try {
        return action()
    } finally {
        unlock()
    }
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
