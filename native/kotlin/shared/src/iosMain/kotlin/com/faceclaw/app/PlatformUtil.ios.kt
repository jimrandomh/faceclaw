@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package com.faceclaw.app

import kotlinx.cinterop.addressOf
import kotlinx.cinterop.alloc
import kotlinx.cinterop.convert
import kotlinx.cinterop.free
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.nativeHeap
import kotlinx.cinterop.ptr
import kotlinx.cinterop.reinterpret
import kotlinx.cinterop.usePinned
import platform.CoreCrypto.CC_SHA256_CTX
import platform.CoreCrypto.CC_SHA256_DIGEST_LENGTH
import platform.CoreCrypto.CC_SHA256_Final
import platform.CoreCrypto.CC_SHA256_Init
import platform.CoreCrypto.CC_SHA256_Update
import platform.Foundation.NSDate
import platform.Foundation.NSDateFormatter
import platform.Foundation.NSLocale
import platform.Foundation.NSLog
import platform.Foundation.NSThread
import platform.Foundation.dateWithTimeIntervalSince1970
import platform.Foundation.timeIntervalSince1970
import platform.posix.F_OK
import platform.posix.access
import platform.posix.fclose
import platform.posix.fopen
import platform.posix.fwrite
import platform.posix.rename
import platform.posix.stat
import platform.posix.unlink
import platform.posix.usleep

actual class Sha256Digest actual constructor() {
    private var context = nativeHeap.alloc<CC_SHA256_CTX>().also { CC_SHA256_Init(it.ptr) }
    private var finished = false

    actual fun update(bytes: ByteArray, offset: Int, length: Int) {
        check(!finished) { "digest already finished" }
        if (length == 0) return
        bytes.usePinned { CC_SHA256_Update(context.ptr, it.addressOf(offset), length.convert()) }
    }

    actual fun digest(): ByteArray {
        check(!finished) { "digest already finished" }
        val out = ByteArray(CC_SHA256_DIGEST_LENGTH)
        out.usePinned { CC_SHA256_Final(it.addressOf(0).reinterpret(), context.ptr) }
        nativeHeap.free(context.ptr)
        finished = true
        return out
    }
}

actual fun currentTimeMillis(): Long = (NSDate().timeIntervalSince1970 * 1000.0).toLong()

actual fun formatLocalTime(epochMs: Long, pattern: String): String {
    val formatter = NSDateFormatter()
    formatter.locale = NSLocale("en_US_POSIX")
    formatter.dateFormat = pattern
    return formatter.stringFromDate(NSDate.dateWithTimeIntervalSince1970(epochMs / 1000.0))
}

actual object PlatformLog {
    // NSLog's vararg bridge cannot take a Kotlin String (it segfaults), so the message becomes
    // the format string itself with '%' escaped.
    private fun emit(text: String) = NSLog(text.replace("%", "%%"))

    actual fun i(tag: String, message: String) = emit("$tag: $message")

    actual fun w(tag: String, message: String) = emit("$tag: [warn] $message")

    actual fun e(tag: String, message: String, error: Throwable?) =
        emit("$tag: [error] $message" + (error?.let { " (${it.message})" } ?: ""))
}

actual fun startThread(name: String, daemon: Boolean, body: () -> Unit) {
    val thread = NSThread(block = body)
    thread.name = name
    thread.start()
}

actual fun sleepMs(ms: Long) {
    if (ms > 0) usleep((ms * 1000).convert())
}

actual fun writeFileData(path: String, bytes: ByteArray) {
    val file = fopen(path, "wb") ?: error("Cannot write $path")
    try {
        if (bytes.isNotEmpty())
            bytes.usePinned {
                check(fwrite(it.addressOf(0), 1u, bytes.size.convert(), file) == bytes.size.convert<platform.posix.size_t>()) { "Short write to $path" }
            }
    } finally {
        fclose(file)
    }
}

actual fun fileExists(path: String): Boolean = access(path, F_OK) == 0

actual fun fileLength(path: String): Long = memScoped {
    val info = alloc<stat>()
    if (stat(path, info.ptr) != 0) -1L else info.st_size
}

actual fun deleteFile(path: String): Boolean = unlink(path) == 0

actual fun renameFile(from: String, to: String): Boolean = rename(from, to) == 0
