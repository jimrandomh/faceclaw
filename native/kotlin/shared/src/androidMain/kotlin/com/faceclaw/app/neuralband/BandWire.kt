// Ported from callbacked/kinesis (MIT, Copyright (c) 2026 callbacked): Sources/KinesisCore/BandWire.swift,
// by way of tetramo-labs/glassly (MIT).
package com.faceclaw.app.neuralband

internal class ProtoFields(data: ByteArray) {
    private sealed class Value {
        class Integer(val value: ULong) : Value()
        class Bytes(val bytes: ByteArray) : Value()
        object Fixed : Value()
    }

    private val values = HashMap<Int, MutableList<Value>>()

    init {
        var offset = 0
        fun varint(): ULong {
            var value = 0uL
            var shift = 0
            while (shift <= 63) {
                if (offset >= data.size) throw BandProtocolError("Truncated protobuf varint")
                val byte = data[offset].toInt() and 0xff
                offset += 1
                if (shift == 63 && byte > 1) throw BandProtocolError("Protobuf varint overflow")
                value = value or ((byte and 127).toULong() shl shift)
                if (byte < 128) return value
                shift += 7
            }
            throw BandProtocolError("Unterminated protobuf varint")
        }
        while (offset < data.size) {
            val tag = varint()
            val number = tag shr 3
            if (number == 0uL || number >= (1uL shl 29)) {
                throw BandProtocolError("Invalid protobuf field number")
            }
            val field = number.toInt()
            val wire = (tag and 7uL).toInt()
            if (wire == 0) {
                values.getOrPut(field) { mutableListOf() }.add(Value.Integer(varint()))
                continue
            }
            val size: ULong = when (wire) {
                1 -> 8uL
                2 -> varint()
                5 -> 4uL
                else -> throw BandProtocolError("Unsupported protobuf wire type")
            }
            if (size > (data.size - offset).toULong()) throw BandProtocolError("Truncated protobuf field")
            val end = offset + size.toInt()
            if (wire == 2) {
                values.getOrPut(field) { mutableListOf() }.add(Value.Bytes(data.copyOfRange(offset, end)))
            } else {
                values.getOrPut(field) { mutableListOf() }.add(Value.Fixed)
            }
            offset = end
        }
    }

    fun integer(field: Int, fallback: ULong = 0uL): ULong {
        val fieldValues = values[field] ?: return fallback
        val only = fieldValues.singleOrNull() as? Value.Integer
            ?: throw BandProtocolError("Expected protobuf integer")
        return only.value
    }

    fun requiredInteger(field: Int): ULong {
        if (values[field] == null) throw BandProtocolError("Missing protobuf integer")
        return integer(field)
    }

    fun bytes(field: Int, count: Int? = null): ByteArray {
        val only = values[field]?.singleOrNull() as? Value.Bytes
        if (only == null || (count != null && only.bytes.size != count)) {
            throw BandProtocolError("Invalid protobuf byte field")
        }
        return only.bytes
    }

    fun contains(field: Int): Boolean = values[field] != null

    fun allBytes(field: Int): List<ByteArray> = values[field]?.mapNotNull { (it as? Value.Bytes)?.bytes } ?: emptyList()

    fun allByteFields(): List<ByteArray> = values.keys.sorted().flatMap { allBytes(it) }

    fun text(field: Int): String? = try {
        bytes(field).toString(Charsets.UTF_8)
    } catch (e: BandProtocolError) {
        null
    }
}

internal object BandWire {
    fun varint(value: ULong): ByteArray {
        var remaining = value
        val bytes = ArrayList<Byte>(10)
        while (remaining >= 128uL) {
            bytes.add(((remaining and 127uL).toInt() or 128).toByte())
            remaining = remaining shr 7
        }
        bytes.add(remaining.toInt().toByte())
        return bytes.toByteArray()
    }

    fun field(number: Int, value: ULong): ByteArray =
        varint((number shl 3).toULong()) + varint(value)

    fun field(number: Int, bytes: ByteArray): ByteArray =
        varint((number shl 3 or 2).toULong()) + varint(bytes.size.toULong()) + bytes

    fun frame(channel: Int, words: List<UInt> = emptyList(), payload: ByteArray = ByteArray(0)): ByteArray {
        var body = ByteArray(0)
        for (word in words) body += word.bigEndianBytes()
        body += payload
        if (body.size > 0x7fff) throw BandProtocolError("DataX frame too large")
        val size = body.size or (if (words.isEmpty()) 0 else 0x8000)
        return be16Bytes(size) + be16Bytes(channel) + body
    }
}

/** Channels are the wire's 16-bit values held in an Int. */
class DataXFrame(
    val channel: Int,
    val words: List<UInt>,
    val payload: ByteArray,
)

internal class DataXReceiver {
    private var pending = ByteArray(0)
    var alwaysPadded = false
        private set

    fun setAlwaysPadded() {
        alwaysPadded = true
    }

    private fun withoutPadding(record: ByteArray): ByteArray {
        if (record.isEmpty()) return record
        val marker = record.last().toInt() and 0xff
        val count = (marker - 0xc0) and 0xff
        if (count !in 1..16 || count > record.size) return record
        if ((record.size - count until record.size).any { (record[it].toInt() and 0xff) != marker }) return record
        return record.copyOfRange(0, record.size - count)
    }

    fun feed(plaintext: ByteArray): List<DataXFrame> {
        if (plaintext.isEmpty() || plaintext.size % 16 != 0) {
            throw BandProtocolError("Unaligned DataX plaintext")
        }
        if (!alwaysPadded && (plaintext.size - 16 until plaintext.size).all { (plaintext[it].toInt() and 0xff) == 0xd0 }) {
            alwaysPadded = true
        }
        pending += if (alwaysPadded) withoutPadding(plaintext) else plaintext
        val frames = ArrayList<DataXFrame>()
        while (pending.size >= 4) {
            val length = pending.be16(0)
            val size = (length and 0x7fff) + 4
            if (pending.size < size) break
            val channel = pending.be16(2)
            var offset = 4
            val words = ArrayList<UInt>()
            if (length and 0x8000 != 0) {
                do {
                    if (offset + 4 > size) throw BandProtocolError("Truncated DataX typed header")
                    words.add(pending.be32(offset))
                    offset += 4
                } while (words.last() and 0x80000000u != 0u)
            }
            frames.add(DataXFrame(channel, words, pending.copyOfRange(offset, size)))
            pending = pending.copyOfRange(size, pending.size)
        }
        if (!alwaysPadded) pending = withoutPadding(pending)
        return frames
    }
}

internal fun ByteArray.be16(offset: Int): Int =
    ((this[offset].toInt() and 0xff) shl 8) or (this[offset + 1].toInt() and 0xff)

internal fun ByteArray.be32(offset: Int): UInt =
    (be16(offset).toUInt() shl 16) or be16(offset + 2).toUInt()

internal fun be16Bytes(value: Int): ByteArray =
    byteArrayOf((value shr 8).toByte(), value.toByte())
