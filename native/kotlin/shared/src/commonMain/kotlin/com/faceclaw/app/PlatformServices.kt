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
