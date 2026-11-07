package com.faceclaw.app

/**
 * The browser demo has no BLE session, so anything that only exists to feed the glasses link
 * (zlib, condition variables, threads) is left unsupported rather than half-implemented: the
 * compositor and display-list renderer this target exists for never reach it.
 */
private object WebProtocolPlatform : ProtocolPlatform {
    private val noLock = object : ProtocolLock {
        override fun lock() {}

        override fun unlock() {}
    }

    override fun elapsedRealtimeMs(): Long = js("performance.now()").unsafeCast<Double>().toLong()

    // JavaScript is single-threaded; Web Workers don't share this object.
    override fun createLock(): ProtocolLock = noLock

    override fun createDeflater(): ProtocolDeflater = throw UnsupportedOperationException("No deflater in the browser")

    override fun createCondition(): ProtocolCondition = throw UnsupportedOperationException("No blocking waits in the browser")
}

internal actual fun protocolPlatform(): ProtocolPlatform = WebProtocolPlatform

internal actual fun deflateData(bytes: ByteArray): ByteArray = throw UnsupportedOperationException("No zlib in the browser")

internal actual fun inflateData(bytes: ByteArray, size: Int): ByteArray = throw UnsupportedOperationException("No zlib in the browser")

/** Synchronous bundled-file read supplied by the page (app/web/vfs.ts). */
private fun webReadFile(path: String): ByteArray? = js("globalThis.faceclawReadFileSync(path)").unsafeCast<ByteArray?>()

internal actual fun readFileData(path: String): ByteArray = webReadFile(path) ?: error("Cannot read $path")

actual fun writeFileData(path: String, bytes: ByteArray) {
    throw UnsupportedOperationException("No Kotlin file writes in the browser")
}

actual fun fileExists(path: String): Boolean = webReadFile(path) != null

actual fun fileLength(path: String): Long = webReadFile(path)?.size?.toLong() ?: -1L

actual fun deleteFile(path: String): Boolean = false

actual fun renameFile(from: String, to: String): Boolean = false
