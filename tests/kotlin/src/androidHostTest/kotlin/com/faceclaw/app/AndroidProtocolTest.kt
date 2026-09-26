package com.faceclaw.app

import java.io.ByteArrayOutputStream
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.zip.Inflater
import kotlin.test.*

// Host tests have no Android clock; all other services use the production adapter.
internal actual fun testPlatform(): ProtocolPlatform =
    object : ProtocolPlatform by AndroidProtocolPlatform {
        override fun elapsedRealtimeMs() = System.nanoTime() / 1_000_000
    }

internal actual fun inflateRecords(records: List<ByteArray>): List<ByteArray> {
    val inflater = Inflater()
    try {
        return records.map { record ->
            if (record[0].toInt() and CfwTransport.RESET_CONTEXT != 0) inflater.reset()
            val body = record.copyOfRange(5, record.size)
            if (record[0].toInt() and CfwTransport.COMPRESSED == 0) body
            else {
                inflater.setInput(body)
                val out = ByteArrayOutputStream()
                val buffer = ByteArray(4096)
                do {
                    val count = inflater.inflate(buffer)
                    out.write(buffer, 0, count)
                } while (!inflater.needsInput())
                out.toByteArray()
            }
        }
    } finally {
        inflater.end()
    }
}

class AndroidProtocolTest {
    @Test
    fun javaGoldenCorpus() {
        // SHA-256 of packets emitted by the pre-migration Java implementation.
        val raw = java.security.MessageDigest.getInstance("SHA-256")
        val compressed = java.security.MessageDigest.getInstance("SHA-256")
        val transport = CfwTransport(testPlatform())
        var state = 123456789
        try {
            repeat(120) { i ->
                val size = intArrayOf(0, 1, 4, 247, 248, 252, 4095, 4096, 8192, 65535)[i % 10]
                val data =
                    ByteArray(size) {
                        state = state xor (state shl 13)
                        state = state xor (state ushr 17)
                        state = state xor (state shl 5)
                        state.toByte()
                    }
                if (i % 3 == 0) data.fill((i % 7).toByte())
                val id = (i * 37) and 255
                val lenses = 1 + (i / 7) % 3
                val mtu = intArrayOf(23, 247, 512, 517)[i % 4]
                if (i % 13 == 0) transport.reset()
                CfwTransport.frame(data, id, lenses, mtu).forEach { raw.update(it) }
                transport.encode(data, id, lenses, mtu).forEach { compressed.update(it) }
            }
            assertEquals(
                "d0efdb99ac71763dd29b70fbd0021b80e1cfe514dfc8a60e2a8424892b16c9f5",
                raw.digest().toHexString(),
            )
            assertEquals(
                "eb5ce0cc6e41b8e84f0d9455f98f3f666b20be0643c3756c5f7aa9d9a66085e2",
                compressed.digest().toHexString(),
            )
        } finally {
            transport.close()
        }
    }

    @Test
    fun writeModeMapping() {
        assertEquals(
            android.bluetooth.BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT,
            AndroidProtocolPlatform.writeType(GattWriteMode.WITH_RESPONSE),
        )
        assertEquals(
            android.bluetooth.BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE,
            AndroidProtocolPlatform.writeType(ConnectionOptions.WRITE_MODE),
        )
    }

    @Test
    fun concurrentAllocationNeverDuplicatesAnInUseId() {
        val pool = BleMagicPool(testPlatform())
        val inUse = Collections.synchronizedSet(mutableSetOf<Int>())
        val executor = Executors.newFixedThreadPool(8)
        try {
            val jobs =
                List(8) {
                    executor.submit {
                        repeat(2000) {
                            val id = pool.allocate()
                            assertTrue(inUse.add(id))
                            Thread.yield()
                            assertTrue(inUse.remove(id))
                            pool.release(1, id, null, null)
                        }
                    }
                }
            jobs.forEach { it.get(30, TimeUnit.SECONDS) }
            assertEquals(156, List(156) { pool.allocate() }.toSet().size)
        } finally {
            executor.shutdownNow()
        }
    }
}

internal actual fun digest(bytes: ByteArray): String =
    BinaryEncoding.bytesToHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes))
