package com.faceclaw.app

import kotlin.jvm.JvmOverloads

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

class ArrayByteReader @JvmOverloads constructor(
    private val bytes: ByteArray,
    private val start: Int = 0,
    private val end: Int = bytes.size,
) : ByteReader() {
    private var position = start

    init {
        require(start >= 0 && start <= end && end <= bytes.size)
    }

    override fun remaining(): Int = end - position

    override fun get(): Byte {
        require(remaining() > 0)
        return bytes[position++]
    }

    override fun get(index: Int): Byte {
        require(index >= 0 && index < end - start)
        return bytes[start + index]
    }

    override fun get(bytes: ByteArray, offset: Int, length: Int): ByteReader {
        require(
            length >= 0 && offset >= 0 && offset <= bytes.size - length && remaining() >= length
        )
        this.bytes.copyInto(bytes, offset, position, position + length)
        position += length
        return this
    }
}
