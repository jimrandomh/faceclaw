package com.faceclaw.app

import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic

/** Faceclaw/10 records: clear flags, wire length and decoded CRC; persistent zlib body. */
class CfwTransport(private val platform: ProtocolPlatform) {
    private val lock = platform.createLock()
    private var deflater: ProtocolDeflater? = null
    private var resetPending = true
    private var previousLenses = 0

    fun reset() = lock.withLock {
        deflater?.reset()
        resetPending = true
        previousLenses = 0
    }

    /** Release native compression resources. A later encode starts a fresh stream. */
    fun close() = lock.withLock {
        deflater?.close()
        deflater = null
        resetPending = true
        previousLenses = 0
    }

    /** Compress only when writing, in exactly the order seen by the receiver. */
    fun encode(message: ByteArray?, streamId: Int, lenses: Int, mtu: Int): List<ByteArray> =
        lock.withLock {
            validate(message, streamId, lenses, mtu)
            val input = message!!
            if (previousLenses != lenses) reset()
            val reset = resetPending
            val encoder = deflater ?: platform.createDeflater().also { deflater = it }
            var body = encoder.syncFlush(input)
            var flags = lenses or COMPRESSED or (if (reset) RESET_CONTEXT else 0)
            if (body.isEmpty()) flags = flags and COMPRESSED.inv() // repeated empty sync flush
            if (body.size > MAX_MESSAGE) {
                // The attempted deflate advanced history: reset both ends before reuse.
                reset()
                body = input
                flags = lenses or RESET_CONTEXT
            } else {
                resetPending = false
                previousLenses = lenses
            }
            frameRecord(body, crc(input), streamId, flags, mtu)
        }

    companion object {
        /** Mirrors g2flash/patches/message_transport.h. */
        const val SID = 0xf0
        const val BOTH = 3
        const val MAX_MESSAGE = 65535
        const val COMPRESSED = 4
        const val RESET_CONTEXT = 8

        private fun validate(message: ByteArray?, streamId: Int, lenses: Int, mtu: Int) {
            require(
                message != null &&
                    message.size <= MAX_MESSAGE &&
                    streamId in 0..255 &&
                    lenses in 1..BOTH &&
                    mtu in 23..517
            ) {
                "invalid CFW stream parameters"
            }
        }

        /** One logical command per stream. Packets are bounded by actual ATT MTU. */
        @JvmStatic
        fun frame(message: ByteArray?, streamId: Int, lenses: Int, mtu: Int): List<ByteArray> {
            validate(message, streamId, lenses, mtu)
            return frameRecord(message!!, crc(message), streamId, lenses or RESET_CONTEXT, mtu)
        }

        private fun frameRecord(
            body: ByteArray,
            checksum: Int,
            streamId: Int,
            flags: Int,
            mtu: Int,
        ): List<ByteArray> {
            val lenses = flags and BOTH
            val capacity = minOf(252, mtu - 14)
            val stream = ByteArray(body.size + 5)
            stream[0] = flags.toByte()
            stream[1] = body.size.toByte()
            stream[2] = (body.size ushr 8).toByte()
            stream[3] = checksum.toByte()
            stream[4] = (checksum ushr 8).toByte()
            body.copyInto(stream, 5)
            val packets = mutableListOf<ByteArray>()
            for (offset in stream.indices step capacity) {
                val count = minOf(capacity, stream.size - offset)
                val packet = ByteArray(count + 11)
                packet[0] = 0xaa.toByte()
                packet[1] = 0x21
                packet[2] = (streamId + packets.size).toByte()
                packet[3] = (count + 3).toByte()
                packet[4] = 1
                packet[5] = 1
                packet[6] = SID.toByte()
                packet[8] =
                    (lenses or
                            (if (offset == 0) 0x80 else 0) or
                            (if (offset + count == stream.size) 0x40 else 0))
                        .toByte()
                stream.copyInto(packet, 9, offset, offset + count)
                val crc = crc(packet, 8, count + 1)
                packet[packet.size - 2] = crc.toByte()
                packet[packet.size - 1] = (crc ushr 8).toByte()
                packets.add(packet)
            }
            return packets
        }

        @JvmStatic fun crc(data: ByteArray): Int = crc(data, 0, data.size)

        private fun crc(data: ByteArray, offset: Int, count: Int): Int {
            var crc = 0xffff
            for (i in offset until offset + count) {
                crc = crc xor ((data[i].toInt() and 255) shl 8)
                repeat(8) {
                    crc = ((crc shl 1) xor (if (crc and 0x8000 != 0) 0x1021 else 0)) and 65535
                }
            }
            return crc
        }

        private fun u16(data: ByteArray, offset: Int): Int =
            (data[offset].toInt() and 255) or ((data[offset + 1].toInt() and 255) shl 8)

        @JvmStatic fun parseAck(packet: ByteArray?): Ack? = parseAcks(packet)?.first()

        /**
         * Validate the entire primary ACK and up to three preceding successes before applying any.
         */
        @JvmStatic
        fun parseAcks(packet: ByteArray?): Array<Ack>? {
            if (
                packet == null ||
                    packet.size !in 19..40 ||
                    (packet.size - 19) % 7 != 0 ||
                    packet[0].toInt() and 255 != 0xaa ||
                    packet[1].toInt() != 0x12 ||
                    packet[3].toInt() and 255 != packet.size - 8 ||
                    packet[4].toInt() != 1 ||
                    packet[5].toInt() != 1 ||
                    packet[6].toInt() and 255 != SID ||
                    packet[7].toInt() != 0 ||
                    (packet[8].toInt() != 1 && packet[8].toInt() != 3) ||
                    (packet[12].toInt() != 1 && packet[12].toInt() != 2) ||
                    (packet[8].toInt() == 3 && packet.size != 19) ||
                    crc(packet, 8, packet.size - 10) != u16(packet, packet.size - 2)
            )
                return null
            return Array(1 + (packet.size - 19) / 7) { i ->
                if (i == 0)
                    Ack(
                        packet[8].toInt() == 3,
                        packet[9].toInt() and 255,
                        u16(packet, 10),
                        packet[12].toInt(),
                        u16(packet, 13),
                        u16(packet, 15),
                    )
                else {
                    val offset = 17 + (i - 1) * 7
                    Ack(
                        false,
                        packet[offset].toInt() and 255,
                        u16(packet, offset + 1),
                        packet[12].toInt(),
                        u16(packet, offset + 3),
                        u16(packet, offset + 5),
                    )
                }
            }
        }
    }

    class Ack(
        @JvmField val nack: Boolean,
        @JvmField val streamId: Int,
        @JvmField val messageId: Int,
        @JvmField val lens: Int,
        @JvmField val size: Int,
        @JvmField val checksum: Int,
    )
}
