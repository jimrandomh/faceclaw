@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package com.faceclaw.app

import kotlin.test.*
import kotlinx.cinterop.*
import platform.CoreBluetooth.*
import platform.posix.memset
import platform.zlib.*

internal actual fun testPlatform(): ProtocolPlatform = IosProtocolPlatform

internal actual fun inflateRecords(records: List<ByteArray>): List<ByteArray> = memScoped {
    val stream = alloc<z_stream>()
    memset(stream.ptr, 0, sizeOf<z_stream>().convert())
    check(inflateInit(stream.ptr) == Z_OK)
    try {
        records.map { record ->
            if (record[0].toInt() and CfwTransport.RESET_CONTEXT != 0)
                check(inflateReset(stream.ptr) == Z_OK)
            val body = record.copyOfRange(5, record.size)
            if (record[0].toInt() and CfwTransport.COMPRESSED == 0) body
            else {
                val output = mutableListOf<Byte>()
                val buffer = ByteArray(4096)
                body.usePinned { input ->
                    stream.next_in = input.addressOf(0).reinterpret()
                    stream.avail_in = body.size.toUInt()
                    buffer.usePinned { destination ->
                        do {
                            stream.next_out = destination.addressOf(0).reinterpret()
                            stream.avail_out = buffer.size.toUInt()
                            val status = inflate(stream.ptr, Z_SYNC_FLUSH)
                            check(status == Z_OK || status == Z_BUF_ERROR)
                            output.addAll(buffer.take(buffer.size - stream.avail_out.toInt()))
                        } while (stream.avail_in > 0u || stream.avail_out == 0u)
                    }
                }
                stream.next_in = null
                stream.next_out = null
                output.toByteArray()
            }
        }
    } finally {
        inflateEnd(stream.ptr)
    }
}

class IosProtocolTest {
    @Test
    fun platformClockAndWriteModes() {
        val before = IosProtocolPlatform.elapsedRealtimeMs()
        assertTrue(before > 0)
        assertTrue(IosProtocolPlatform.elapsedRealtimeMs() >= before)
        assertEquals(
            CBCharacteristicWriteWithResponse,
            IosProtocolPlatform.writeType(GattWriteMode.WITH_RESPONSE),
        )
        assertEquals(
            CBCharacteristicWriteWithoutResponse,
            IosProtocolPlatform.writeType(ConnectionOptions.WRITE_MODE),
        )
    }
}

internal actual fun digest(bytes: ByteArray): String {
    val result = ByteArray(32)
    result.usePinned { output ->
        if (bytes.isEmpty())
            platform.CoreCrypto.CC_SHA256(null, 0u, output.addressOf(0).reinterpret())
        else
            bytes.usePinned { input ->
                platform.CoreCrypto.CC_SHA256(
                    input.addressOf(0),
                    bytes.size.toUInt(),
                    output.addressOf(0).reinterpret(),
                )
            }
    }
    return BinaryEncoding.bytesToHex(result)
}
