@file:OptIn(
    kotlinx.cinterop.ExperimentalForeignApi::class,
    kotlin.experimental.ExperimentalNativeApi::class,
)

package com.faceclaw.app

import kotlin.native.ref.createCleaner
import kotlinx.cinterop.*
import platform.CoreBluetooth.CBCharacteristicWriteType
import platform.CoreBluetooth.CBCharacteristicWriteWithResponse
import platform.CoreBluetooth.CBCharacteristicWriteWithoutResponse
import platform.Foundation.NSCondition
import platform.Foundation.NSDate
import platform.Foundation.NSRecursiveLock
import platform.Foundation.dateWithTimeIntervalSinceNow
import platform.posix.CLOCK_MONOTONIC_RAW
import platform.posix.clock_gettime_nsec_np
import platform.posix.memset
import platform.zlib.*

object IosProtocolPlatform : ProtocolPlatform {
    // Unlike wall time, this cannot jump; unlike uptime, it includes sleep.
    override fun elapsedRealtimeMs(): Long =
        (clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW.convert()) / 1_000_000uL).toLong()

    override fun createLock(): ProtocolLock =
        object : ProtocolLock {
            private val lock = NSRecursiveLock()

            override fun lock() = lock.lock()

            override fun unlock() = lock.unlock()
        }

    override fun createDeflater(): ProtocolDeflater = IosDeflater()

    override fun createCondition(): ProtocolCondition =
        object : ProtocolCondition {
            private val condition = NSCondition()

            override fun lock() = condition.lock()

            override fun unlock() = condition.unlock()

            override fun awaitMs(timeoutMs: Long) {
                if (timeoutMs > 0) condition.waitUntilDate(NSDate.dateWithTimeIntervalSinceNow(timeoutMs / 1000.0))
            }

            override fun signalAll() = condition.broadcast()
        }

    fun writeType(mode: GattWriteMode): CBCharacteristicWriteType =
        when (mode) {
            GattWriteMode.WITH_RESPONSE -> CBCharacteristicWriteWithResponse
            GattWriteMode.WITHOUT_RESPONSE -> CBCharacteristicWriteWithoutResponse
        }
}

/** The cleaner holds only the allocation state, never the owning deflater. */
private class ZlibState {
    private val lock = NSRecursiveLock()
    var stream: CPointer<z_stream>? = nativeHeap.alloc<z_stream>().ptr
        private set

    init {
        memset(stream, 0, sizeOf<z_stream>().convert())
        val status = deflateInit(stream, Z_DEFAULT_COMPRESSION)
        if (status != Z_OK) {
            nativeHeap.free(stream!!)
            stream = null
            error("zlib initialization failed: $status")
        }
    }

    fun <T> use(action: (CPointer<z_stream>) -> T): T {
        lock.lock()
        try {
            return action(checkNotNull(stream) { "zlib stream is closed" })
        } finally {
            lock.unlock()
        }
    }

    fun close() {
        lock.lock()
        try {
            val value = stream ?: return
            deflateEnd(value)
            nativeHeap.free(value)
            stream = null
        } finally {
            lock.unlock()
        }
    }
}

private class IosDeflater : ProtocolDeflater {
    private val state = ZlibState()
    private val cleaner = createCleaner(state) { it.close() }

    override fun reset() = state.use { check(deflateReset(it) == Z_OK) }

    override fun syncFlush(message: ByteArray): ByteArray = state.use { stream ->
        val chunks = mutableListOf<ByteArray>()
        var size = 0
        val buffer = ByteArray(4096)
        message.usePinned { input ->
            stream.pointed.next_in =
                if (message.isEmpty()) null else input.addressOf(0).reinterpret()
            stream.pointed.avail_in = message.size.toUInt()
            try {
                buffer.usePinned { output ->
                    do {
                        stream.pointed.next_out = output.addressOf(0).reinterpret()
                        stream.pointed.avail_out = buffer.size.toUInt()
                        val status = deflate(stream, Z_SYNC_FLUSH)
                        // A repeated empty SYNC_FLUSH is a valid no-op.
                        check(status == Z_OK || status == Z_BUF_ERROR) {
                            "zlib deflate failed: $status"
                        }
                        val count = buffer.size - stream.pointed.avail_out.toInt()
                        if (count > 0) {
                            chunks.add(buffer.copyOf(count))
                            size += count
                        }
                    } while (stream.pointed.avail_out == 0u)
                }
            } finally {
                // Do not leave pointers to unpinned Kotlin arrays in native memory.
                stream.pointed.next_in = null
                stream.pointed.next_out = null
                stream.pointed.avail_in = 0u
                stream.pointed.avail_out = 0u
            }
        }
        ByteArray(size).also { result ->
            var offset = 0
            for (chunk in chunks) {
                chunk.copyInto(result, offset)
                offset += chunk.size
            }
        }
    }

    override fun close() = state.close()
}
