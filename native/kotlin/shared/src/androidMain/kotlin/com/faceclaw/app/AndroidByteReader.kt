package com.faceclaw.app

import java.nio.ByteBuffer

/** NativeScript's ArrayBuffer-backed ByteBuffer stays on the JVM side. */
class AndroidByteReader(buffer: ByteBuffer) : ByteReader() {
    // NativeScript can reuse the same ByteBuffer for an ArrayBuffer. Reading one
    // frame must not advance the cursor used by a later atlas/preview crossing.
    private val buffer = buffer.duplicate()
    override fun remaining(): Int = buffer.remaining()

    override fun get(): Byte = buffer.get()

    override fun get(index: Int): Byte = buffer.get(index)

    override fun get(bytes: ByteArray, offset: Int, length: Int): ByteReader {
        buffer.get(bytes, offset, length)
        return this
    }
}
