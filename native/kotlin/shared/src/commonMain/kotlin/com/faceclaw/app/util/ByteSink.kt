package com.faceclaw.app

/** Growable byte buffer for wire encoders; no streams or platform objects escape. */
internal class ByteSink(capacity: Int = 32) {
    private var bytes = ByteArray(capacity.coerceAtLeast(1))
    private var count = 0

    fun size(): Int = count

    fun write(value: Char) = write(value.code)

    fun write(value: ByteArray) = write(value, 0, value.size)

    fun write(value: Int) {
        reserve(1)
        bytes[count++] = value.toByte()
    }

    fun write(value: ByteArray, offset: Int, length: Int) {
        require(offset >= 0 && length >= 0 && offset <= value.size - length)
        reserve(length)
        value.copyInto(bytes, count, offset, offset + length)
        count += length
    }

    fun toByteArray(): ByteArray = bytes.copyOf(count)

    private fun reserve(extra: Int) {
        if (count + extra > bytes.size) bytes = bytes.copyOf(maxOf(count + extra, bytes.size * 2))
    }
}

internal infix fun Byte.and(mask: Int): Int = toInt() and mask

internal infix fun Byte.shl(bits: Int): Int = toInt() shl bits

internal fun codePointUtf8(codePoint: Int): ByteArray {
    require(codePoint in 0..0x10ffff)
    if (codePoint <= 0xffff) return codePoint.toChar().toString().encodeToByteArray()
    val value = codePoint - 0x10000
    return charArrayOf((0xd800 + (value ushr 10)).toChar(), (0xdc00 + (value and 1023)).toChar())
        .concatToString()
        .encodeToByteArray()
}
