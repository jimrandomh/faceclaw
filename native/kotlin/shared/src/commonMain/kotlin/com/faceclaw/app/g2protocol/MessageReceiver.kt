package com.faceclaw.app

/** Split/coalesced notifications and protobuf fragments, isolated per BLE link and sequence. */
class MessageReceiver {
    class Message(
        val sid: Int,
        val flag: Int,
        val payload: ByteArray,
        val command: Int,
        val magic: Int,
        val packet: ByteArray? = null,
    )

    private class Partial(val total: Int, var seen: Long) {
        val chunks = mutableListOf<ByteArray>()
        var size = 0
    }

    private val lock = protocolPlatform().createLock()
    private val streams = mutableMapOf<String, ByteArray>()
    private val messages = mutableMapOf<String, Partial>()

    fun clear() = lock.withLock {
        streams.clear()
        messages.clear()
    }

    fun receive(link: String, data: ByteArray, now: Long): List<Message> = lock.withLock {
        messages.entries.removeAll { now - it.value.seen > 5000 }
        val stream = (streams[link] ?: ByteArray(0)) + data
        val output = mutableListOf<Message>()
        var offset = 0
        while (stream.size - offset >= 8) {
            fun u8(index: Int) = stream[offset + index].toInt() and 255
            if (u8(0) != 0xaa || u8(1) !in intArrayOf(0x21, 0x12)) {
                offset++
                continue
            }
            val length = u8(3)
            if (stream.size - offset < length + 8) break
            val count = u8(4)
            val index = u8(5)
            val sid = u8(6)
            val flag = u8(7)
            val key = "$link:${u8(2)}:$sid:$flag"
            val packet = stream.copyOfRange(offset, offset + length + 8)
            val chunk = packet.copyOfRange(8, packet.size)
            offset += length + 8
            if (sid == CfwTransport.SID) {
                output.add(Message(sid, flag, chunk, -1, -1, packet))
                continue
            }
            if (count == 0 || index == 0 || index > count) {
                messages.remove(key)
                continue
            }
            if (index == 1) messages[key] = Partial(count, now)
            val partial = messages[key]
            if (partial == null || partial.total != count || partial.chunks.size + 1 != index) {
                messages.remove(key)
                continue
            }
            partial.chunks.add(chunk)
            partial.size += chunk.size
            partial.seen = now
            if (partial.size > 65536) {
                messages.remove(key)
                continue
            }
            if (index != count) continue
            messages.remove(key)
            val bytes = ByteSink(partial.size)
            partial.chunks.forEach { bytes.write(it) }
            val complete = bytes.toByteArray()
            if (complete.size < 2) continue
            val payload = complete.copyOf(complete.size - 2)
            val checksum =
                (complete[complete.size - 2].toInt() and 255) or
                    ((complete.last().toInt() and 255) shl 8)
            if (CfwTransport.crc(payload) != checksum || !validProtobuf(payload)) continue
            output.add(
                Message(
                    sid,
                    flag,
                    payload,
                    BleProtocol.readVarintFieldValue(payload, 1, -1),
                    BleProtocol.readVarintFieldValue(payload, 2, -1),
                )
            )
        }
        streams[link] = stream.copyOfRange(offset, stream.size)
        output
    }

    private fun validProtobuf(data: ByteArray): Boolean {
        var offset = 0
        fun varint(): Int? {
            var value = 0
            for (i in 0..4) {
                if (offset == data.size) return null
                val byte = data[offset++].toInt() and 255
                if (i == 4 && byte > 15) return null
                value = value or ((byte and 127) shl (i * 7))
                if (byte and 128 == 0) return value
            }
            return null
        }
        while (offset < data.size) {
            val key = varint() ?: return false
            if (key ushr 3 == 0) return false
            if (key and 7 == 0) {
                varint() ?: return false
                continue
            }
            val length =
                when (key and 7) {
                    1 -> 8
                    5 -> 4
                    2 -> varint() ?: return false
                    else -> return false
                }
            if (length < 0 || length > data.size - offset) return false
            offset += length
        }
        return true
    }
}
