package com.faceclaw.app

/** Platform selection happens at compilation; protocol algorithms stay shared. */
internal expect fun protocolPlatform(): ProtocolPlatform

internal expect fun deflateData(bytes: ByteArray): ByteArray

internal expect fun inflateData(bytes: ByteArray, size: Int): ByteArray

internal expect fun readFileData(path: String): ByteArray

/** Whole-file write (truncating); parent directories must exist. */
expect fun writeFileData(path: String, bytes: ByteArray)

expect fun fileExists(path: String): Boolean

/** Size in bytes, or -1 when the file does not exist. */
expect fun fileLength(path: String): Long

expect fun deleteFile(path: String): Boolean

expect fun renameFile(from: String, to: String): Boolean

/** A file being written front to back whose earlier bytes can still be patched (container headers). */
interface SeekableOutput {
    /** Bytes appended so far. */
    val size: Long

    /** Appends [length] bytes of [bytes] from [offset]. */
    fun write(bytes: ByteArray, offset: Int, length: Int)

    /** Overwrites bytes already written, at [position]; later appends still go to the end. */
    fun writeAt(position: Long, bytes: ByteArray)

    fun close()
}

/** A file read at arbitrary positions without loading it whole. */
interface SeekableInput {
    val length: Long

    /** Reads up to [length] bytes at [position] into [buffer]; returns the count read (short only at the end). */
    fun readAt(position: Long, buffer: ByteArray, offset: Int, length: Int): Int

    fun close()
}

/** Creates (or truncates) [path] for writing; parent directories must exist. Throws when it cannot. */
expect fun openFileOutput(path: String): SeekableOutput

/** Opens [path] for reading. Throws when it cannot. */
expect fun openFileInput(path: String): SeekableInput
