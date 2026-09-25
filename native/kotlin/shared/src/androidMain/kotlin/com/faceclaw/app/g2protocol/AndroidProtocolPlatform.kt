package com.faceclaw.app

import android.bluetooth.BluetoothGattCharacteristic
import android.os.SystemClock
import java.io.ByteArrayOutputStream
import java.util.concurrent.locks.ReentrantLock
import java.util.zip.Deflater

object AndroidProtocolPlatform : ProtocolPlatform {
    override fun elapsedRealtimeMs(): Long = SystemClock.elapsedRealtime()

    override fun createLock(): ProtocolLock =
        object : ProtocolLock {
            private val lock = ReentrantLock()

            override fun lock() = lock.lock()

            override fun unlock() = lock.unlock()
        }

    override fun createDeflater(): ProtocolDeflater = AndroidDeflater()

    override fun createCondition(): ProtocolCondition =
        object : ProtocolCondition {
            private val lock = ReentrantLock()
            private val condition = lock.newCondition()

            override fun lock() = lock.lock()

            override fun unlock() = lock.unlock()

            override fun awaitMs(timeoutMs: Long) {
                if (timeoutMs > 0) condition.await(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
            }

            override fun signalAll() = condition.signalAll()
        }

    @JvmStatic
    fun writeType(mode: GattWriteMode): Int =
        when (mode) {
            GattWriteMode.WITH_RESPONSE -> BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            GattWriteMode.WITHOUT_RESPONSE -> BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        }
}

private class AndroidDeflater : ProtocolDeflater {
    private val deflater = Deflater()

    override fun reset() = deflater.reset()

    override fun syncFlush(message: ByteArray): ByteArray {
        deflater.setInput(message)
        val out = ByteArrayOutputStream()
        val chunk = ByteArray(4096)
        do {
            val count = deflater.deflate(chunk, 0, chunk.size, Deflater.SYNC_FLUSH)
            out.write(chunk, 0, count)
        } while (count == chunk.size)
        return out.toByteArray()
    }

    override fun close() = deflater.end()
}
