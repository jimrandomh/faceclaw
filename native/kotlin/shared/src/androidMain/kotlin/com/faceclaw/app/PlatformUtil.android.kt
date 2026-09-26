package com.faceclaw.app

import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

actual class Sha256Digest actual constructor() {
    private val digest = MessageDigest.getInstance("SHA-256")

    actual fun update(bytes: ByteArray, offset: Int, length: Int) = digest.update(bytes, offset, length)

    actual fun digest(): ByteArray = digest.digest()
}

actual fun currentTimeMillis(): Long = System.currentTimeMillis()

actual fun formatLocalTime(epochMs: Long, pattern: String): String =
    SimpleDateFormat(pattern, Locale.US).format(Date(epochMs))

actual fun localUtcOffsetMs(epochMs: Long): Int = java.util.TimeZone.getDefault().getOffset(epochMs)

actual fun localTimeZoneId(): String = java.util.TimeZone.getDefault().id

actual object PlatformLog {
    actual fun i(tag: String, message: String) {
        android.util.Log.i(tag, message)
    }

    actual fun w(tag: String, message: String) {
        android.util.Log.w(tag, message)
    }

    actual fun e(tag: String, message: String, error: Throwable?) {
        if (error != null) android.util.Log.e(tag, message, error) else android.util.Log.e(tag, message)
    }
}

actual fun startThread(name: String, daemon: Boolean, body: () -> Unit) {
    val thread = Thread(body, name)
    thread.isDaemon = daemon
    thread.start()
}

actual fun sleepMs(ms: Long) {
    try {
        Thread.sleep(ms)
    } catch (ignored: InterruptedException) {
        Thread.currentThread().interrupt()
    }
}

actual fun writeFileData(path: String, bytes: ByteArray) = java.io.File(path).writeBytes(bytes)

actual fun fileExists(path: String): Boolean = java.io.File(path).exists()

actual fun fileLength(path: String): Long = java.io.File(path).let { if (it.exists()) it.length() else -1L }

actual fun deleteFile(path: String): Boolean = java.io.File(path).delete()

actual fun renameFile(from: String, to: String): Boolean = java.io.File(from).renameTo(java.io.File(to))
