@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package com.faceclaw.app

import kotlin.concurrent.Volatile

import kotlinx.cinterop.addressOf
import kotlinx.cinterop.convert
import kotlinx.cinterop.usePinned
import platform.Foundation.NSData
import platform.Foundation.NSError
import platform.Foundation.NSFileManager
import platform.Foundation.NSHTTPURLResponse
import platform.Foundation.NSURLResponse
import platform.Foundation.NSURLSession
import platform.Foundation.NSURLSessionConfiguration
import platform.Foundation.NSURLSessionDataDelegateProtocol
import platform.Foundation.NSURLSessionDataTask
import platform.Foundation.NSURLSessionResponseAllow
import platform.Foundation.NSURLSessionResponseDisposition
import platform.Foundation.NSURLSessionTask
import platform.darwin.NSObject
import platform.posix.fclose
import platform.posix.fopen
import platform.posix.fread
import platform.posix.fwrite

/**
 * iOS twin of the Android FaceclawModelDownloader: NSURLSession transport and POSIX
 * storage under the shared [ResumableDownload], run on its own thread with listener
 * callbacks on the main queue. Same constructor/start/cancel shape as Android.
 */
class IosModelDownloader internal constructor(
    url: String,
    destPath: String,
    expectedSha256: String?,
    expectedTotalBytes: Long,
    listener: FaceclawModelDownloaderListener,
    dispatch: (() -> Unit) -> Unit,
) {
    constructor(url: String, destPath: String, expectedSha256: String?, expectedTotalBytes: Long, listener: FaceclawModelDownloaderListener) :
        this(url, destPath, expectedSha256, expectedTotalBytes, listener, ::dispatchToMain)

    private val transport = IosDownloadTransport()
    private val download: ResumableDownload

    init {
        val posted = object : FaceclawModelDownloaderListener {
            override fun onProgress(bytesDownloaded: Long, totalBytes: Long) = dispatch { listener.onProgress(bytesDownloaded, totalBytes) }

            override fun onDone(path: String?) = dispatch { listener.onDone(path) }

            override fun onError(message: String?) = dispatch { listener.onError(message) }
        }
        download = ResumableDownload(url, destPath, expectedSha256, expectedTotalBytes, transport, IosDownloadStorage, posted)
    }

    fun start() = startThread("FaceclawModelDl", true) { download.run() }

    /** Stops the download but keeps the .part file so a later start() resumes. */
    fun cancel() {
        download.cancel()
        transport.cancel()
    }
}

/**
 * Blocking-read view of an NSURLSession data task: the delegate queues body chunks and the
 * reader drains them, suspending the task while too much is buffered.
 */
internal class IosDownloadTransport : DownloadTransport {
    @Volatile
    private var current: Session? = null

    fun cancel() {
        current?.close()
    }

    override fun open(url: String, rangeFrom: Long): DownloadResponse {
        val target = parseUrl(url) ?: error("Invalid download URL")
        val headers = if (rangeFrom > 0) listOf("Range" to "bytes=$rangeFrom-") else emptyList()
        val request = buildRequest(target, "GET", null, headers)
        val configuration = NSURLSessionConfiguration.ephemeralSessionConfiguration
        configuration.timeoutIntervalForRequest = 60.0
        configuration.timeoutIntervalForResource = 7 * 24 * 3600.0
        val session = Session()
        current = session
        session.start(configuration, request)
        if (!session.responded.await(30_000)) {
            session.close()
            error("download timed out waiting for the server")
        }
        session.failure?.let { session.close(); error(it) }
        return session
    }

    /** Body reader; NSURLSession callbacks arrive through [Delegate] on the session's queue. */
    private class Session : DownloadResponse {
        private val platform = IosProtocolPlatform
        val responded = Latch(1, platform)
        private val chunks = BlockingQueue<ByteArray>(platform)
        private val lock = platform.createLock()
        private var queuedBytes = 0L
        private var suspended = false
        private var pending: ByteArray? = null
        private var pendingOffset = 0
        private var ended = false

        @Volatile
        var failure: String? = null
        private var session: NSURLSession? = null
        private var task: NSURLSessionDataTask? = null

        override var code: Int = 0
            private set

        override var contentLength: Long = -1
            private set

        fun start(configuration: NSURLSessionConfiguration, request: platform.Foundation.NSURLRequest) {
            val created = NSURLSession.sessionWithConfiguration(configuration, Delegate(this), delegateQueue = null)
            session = created
            task = created.dataTaskWithRequest(request).also { it.resume() }
        }

        fun onResponse(response: NSURLResponse) {
            code = (response as? NSHTTPURLResponse)?.statusCode?.toInt() ?: 0
            contentLength = response.expectedContentLength
            responded.countDown()
        }

        fun onData(data: NSData, dataTask: NSURLSessionDataTask) {
            val bytes = data.byteArray()
            if (bytes.isEmpty()) return
            chunks.put(bytes)
            lock.withLock {
                queuedBytes += bytes.size
                if (queuedBytes > HIGH_WATER && !suspended) {
                    suspended = true
                    dataTask.suspend()
                }
            }
        }

        fun onFinished(error: NSError?) {
            if (error != null) failure = error.localizedDescription
            responded.countDown()
            chunks.put(END)
        }

        override fun read(buffer: ByteArray): Int {
            var source = pending
            if (source == null) {
                if (ended) return -1
                val next = chunks.poll(60_000) ?: error("download stalled")
                if (next === END) {
                    ended = true
                    failure?.let { error(it) }
                    return -1
                }
                source = next
                pendingOffset = 0
            }
            val count = minOf(buffer.size, source.size - pendingOffset)
            source.copyInto(buffer, 0, pendingOffset, pendingOffset + count)
            pendingOffset += count
            if (pendingOffset >= source.size) {
                pending = null
                lock.withLock {
                    queuedBytes -= source.size
                    if (suspended && queuedBytes < LOW_WATER) {
                        suspended = false
                        task?.resume()
                    }
                }
            } else pending = source
            return count
        }

        override fun close() {
            session?.invalidateAndCancel()
            session = null
            chunks.put(END)
        }
    }

    private class Delegate(private val owner: Session) : NSObject(), NSURLSessionDataDelegateProtocol {
        override fun URLSession(
            session: NSURLSession,
            dataTask: NSURLSessionDataTask,
            didReceiveResponse: NSURLResponse,
            completionHandler: (NSURLSessionResponseDisposition) -> Unit,
        ) {
            owner.onResponse(didReceiveResponse)
            completionHandler(NSURLSessionResponseAllow)
        }

        override fun URLSession(session: NSURLSession, dataTask: NSURLSessionDataTask, didReceiveData: NSData) =
            owner.onData(didReceiveData, dataTask)

        override fun URLSession(session: NSURLSession, task: NSURLSessionTask, didCompleteWithError: NSError?) {
            owner.onFinished(didCompleteWithError)
            session.finishTasksAndInvalidate()
        }
    }
}

private val END = ByteArray(0)
private const val HIGH_WATER = 4L * 1024 * 1024
private const val LOW_WATER = 1L * 1024 * 1024

/** POSIX file storage for downloads; multi-GB files stream through fixed buffers. */
internal object IosDownloadStorage : DownloadStorage {
    override fun length(path: String): Long = fileLength(path)

    override fun prepareParent(path: String) {
        val parent = path.substringBeforeLast('/', "")
        if (parent.isNotEmpty()) NSFileManager.defaultManager.createDirectoryAtPath(parent, true, null, null)
    }

    override fun openWrite(path: String, append: Boolean): FileSink {
        val file = fopen(path, if (append) "ab" else "wb") ?: error("Cannot write $path")
        return object : FileSink {
            override fun write(bytes: ByteArray, offset: Int, length: Int) {
                if (length <= 0) return
                bytes.usePinned {
                    check(fwrite(it.addressOf(offset), 1u, length.convert(), file) == length.convert<platform.posix.size_t>()) { "Short write to $path" }
                }
            }

            override fun close() {
                fclose(file)
            }
        }
    }

    override fun readAll(path: String, consumer: (ByteArray, Int) -> Boolean): Long {
        val file = fopen(path, "rb") ?: return 0
        var consumed = 0L
        try {
            val buffer = ByteArray(1 shl 16)
            while (true) {
                val read = buffer.usePinned { fread(it.addressOf(0), 1u, buffer.size.convert(), file) }.toInt()
                if (read <= 0) break
                if (!consumer(buffer, read)) break
                consumed += read
            }
        } finally {
            fclose(file)
        }
        return consumed
    }

    override fun rename(from: String, to: String): Boolean = renameFile(from, to)

    override fun delete(path: String): Boolean = deleteFile(path)
}
