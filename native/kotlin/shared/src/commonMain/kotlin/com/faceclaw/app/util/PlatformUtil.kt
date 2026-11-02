package com.faceclaw.app

/** Incremental SHA-256; [digest] finishes the hash. */
expect class Sha256Digest() {
    fun update(bytes: ByteArray, offset: Int, length: Int)

    fun digest(): ByteArray
}

fun Sha256Digest.update(bytes: ByteArray) = update(bytes, 0, bytes.size)

fun sha256(bytes: ByteArray): ByteArray = Sha256Digest().also { it.update(bytes) }.digest()

fun sha256Hex(bytes: ByteArray): String = BinaryEncoding.bytesToHex(sha256(bytes))

/** Wall-clock milliseconds since the Unix epoch (may jump; use ProtocolPlatform for intervals). */
expect fun currentTimeMillis(): Long

/** Formats [epochMs] in local time with a Unicode/SimpleDateFormat-style [pattern] (e.g. "yyyyMMdd-HHmmss-SSS"). */
expect fun formatLocalTime(epochMs: Long, pattern: String): String

/** The local time zone's offset from UTC at [epochMs], in milliseconds (DST included). */
expect fun localUtcOffsetMs(epochMs: Long): Int

/** The local time zone's identifier (e.g. "America/Los_Angeles"), for logs. */
expect fun localTimeZoneId(): String

expect object PlatformLog {
    fun i(tag: String, message: String)

    fun w(tag: String, message: String)

    fun e(tag: String, message: String, error: Throwable?)
}

fun PlatformLog.e(tag: String, message: String) = e(tag, message, null)
