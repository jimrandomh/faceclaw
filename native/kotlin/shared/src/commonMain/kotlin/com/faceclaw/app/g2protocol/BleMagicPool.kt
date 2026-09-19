package com.faceclaw.app

import kotlin.jvm.JvmField

/**
 * Allocates one-byte message identifiers in LRU order. Release records survive reuse so the
 * communicator can diagnose late ACKs after a timeout.
 */
class BleMagicPool(private val platform: ProtocolPlatform) {
    companion object {
        const val MIN_MAGIC = 100
        const val MAX_MAGIC = 255
    }

    private val lock = platform.createLock()
    private val available = ArrayDeque((MIN_MAGIC..MAX_MAGIC).toList())
    private val allocated = BooleanArray(256)
    private val releaseRecords = mutableMapOf<String, ReleaseRecord>()

    fun allocate(): Int = lock.withLock {
        check(available.isNotEmpty()) { "no BLE magic values available" }
        val magic = available.removeFirst()
        allocated[magic] = true
        magic
    }

    fun release(sid: Int, magic: Int, label: String?, reason: String?) = lock.withLock {
        if (magic !in MIN_MAGIC..MAX_MAGIC) return@withLock
        releaseRecords["$sid:$magic"] = ReleaseRecord(label, reason, platform.elapsedRealtimeMs())
        if (!allocated[magic]) return@withLock
        allocated[magic] = false
        available.addLast(magic)
    }

    fun getReleaseRecord(sid: Int, magic: Int): ReleaseRecord? = lock.withLock {
        releaseRecords["$sid:$magic"]
    }

    class ReleaseRecord(label: String?, reason: String?, @JvmField val releasedAtMs: Long) {
        @JvmField val label: String = label ?: ""
        @JvmField val reason: String = reason ?: ""
    }
}
