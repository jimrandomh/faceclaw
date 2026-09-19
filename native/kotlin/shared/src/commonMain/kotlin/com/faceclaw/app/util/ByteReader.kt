package com.faceclaw.app

/** Sequential little-endian input. Platform adapters can read native buffers without a copy. */
abstract class ByteReader {
    abstract fun remaining(): Int

    abstract fun get(): Byte

    abstract fun get(index: Int): Byte

    open fun get(bytes: ByteArray): ByteReader = get(bytes, 0, bytes.size)

    open fun get(bytes: ByteArray, offset: Int, length: Int): ByteReader {
        require(
            length >= 0 && offset >= 0 && offset <= bytes.size - length && remaining() >= length
        )
        for (i in offset until offset + length) bytes[i] = get()
        return this
    }

    fun getShort(): Short = ((get().toInt() and 255) or ((get().toInt() and 255) shl 8)).toShort()

    fun getInt(): Int = (getShort().toInt() and 65535) or (getShort().toInt() shl 16)
}

class ArrayByteReader(private val bytes: ByteArray) : ByteReader() {
    private var position = 0

    override fun remaining(): Int = bytes.size - position

    override fun get(): Byte = bytes[position++]

    override fun get(index: Int): Byte = bytes[index]

    override fun get(bytes: ByteArray, offset: Int, length: Int): ByteReader {
        require(
            length >= 0 && offset >= 0 && offset <= bytes.size - length && remaining() >= length
        )
        this.bytes.copyInto(bytes, offset, position, position + length)
        position += length
        return this
    }
}
