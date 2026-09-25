package com.faceclaw.app

/**
 * Numeric fields in the draw grammar go through this codec. Most fields still
 * uses fixed-width little-endian values; rounded-rectangle x/y use extended varints and expressions. Byte blocks
 * (RLE, text, LUTs and already-encoded calls) retain their own formats.
 */
internal class DrawReader(
    private val bytes: ByteArray,
    start: Int = 0,
    private val end: Int = bytes.size,
) {
    var position: Int = start
        private set
    val remaining: Int get() = end - position

    init {
        require(start >= 0 && start <= end && end <= bytes.size)
    }

    fun readU8(): Int {
        require(remaining >= 1) { "Truncated draw field" }
        return bytes[position++].toInt() and 255
    }

    fun readS8(): Int = readU8().toByte().toInt()

    fun readU16(): Int {
        val low = readU8()
        return low or (readU8() shl 8)
    }

    fun readS16(): Int = readU16().toShort().toInt()

    fun readBytes(count: Int): ByteArray {
        require(count >= 0 && count <= remaining) { "Truncated draw data" }
        val result = bytes.copyOfRange(position, position + count)
        position += count
        return result
    }

    /** A bounded view prevents a truncated call from consuming the next call. */
    fun readSlice(count: Int): DrawReader {
        require(count >= 0 && count <= remaining) { "Truncated draw call" }
        val result = DrawReader(bytes, position, position + count)
        position += count
        return result
    }

    fun requireDone() {
        require(remaining == 0) { "Trailing draw data" }
    }
}

internal class DrawWriter {
    private val out = ByteSink()

    fun writeU8(value: Int) = out.write(value)
    fun writeS8(value: Int) = out.write(value)
    fun writeU16(value: Int) {
        out.write(value)
        out.write(value ushr 8)
    }
    fun writeS16(value: Int) = writeU16(value)
    fun writeBytes(value: ByteArray) = out.write(value)
    fun writeExtended(value: DrawValue) = out.write(ExtendedVarint.write(value))
    fun toByteArray(): ByteArray = out.toByteArray()
}
