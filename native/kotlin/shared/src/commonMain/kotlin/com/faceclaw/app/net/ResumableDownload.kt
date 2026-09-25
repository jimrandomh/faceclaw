package com.faceclaw.app

import kotlin.concurrent.Volatile

/** One open HTTP response body; [read] returns bytes read or -1 at end. */
interface DownloadResponse {
    val code: Int

    /** Body length if known, else -1. */
    val contentLength: Long

    fun read(buffer: ByteArray): Int

    fun close()
}

/** Blocking GET; `rangeFrom > 0` asks for `Range: bytes=<rangeFrom>-`. */
interface DownloadTransport {
    fun open(url: String, rangeFrom: Long): DownloadResponse
}

interface FileSink {
    fun write(bytes: ByteArray, offset: Int, length: Int)

    fun close()
}

/** Storage port; paths are platform file paths. Multi-GB files must stream, hence no whole-file reads. */
interface DownloadStorage {
    /** Size in bytes, or -1 when missing. */
    fun length(path: String): Long

    fun prepareParent(path: String)

    fun openWrite(path: String, append: Boolean): FileSink

    /** Streams an existing file through [consumer] (bytes, count); stops early when it returns false. Returns bytes consumed. */
    fun readAll(path: String, consumer: (ByteArray, Int) -> Boolean): Long

    fun rename(from: String, to: String): Boolean

    fun delete(path: String): Boolean
}

/**
 * Large-file download to "<dest>.part" with HTTP Range resume across app restarts, a pinned
 * sha256 hashed incrementally (including the resumed prefix), then a rename into place.
 * [run] blocks on the calling thread; listener callbacks are invoked synchronously on it, so
 * the platform adapter marshals them (Android posts to the constructing Looper).
 */
class ResumableDownload(
    private val url: String,
    private val destPath: String,
    expectedSha256: String?,
    private val expectedTotalBytes: Long,
    private val transport: DownloadTransport,
    private val storage: DownloadStorage,
    private val listener: FaceclawModelDownloaderListener,
    private val now: () -> Long = { currentTimeMillis() },
) {
    private val partPath = "$destPath.part"
    private val expectedSha256 = expectedSha256?.lowercase() ?: ""

    @Volatile
    private var cancelled = false

    @Volatile
    private var response: DownloadResponse? = null

    /** Stops the download but keeps the .part file so a later run resumes. */
    fun cancel() {
        cancelled = true
        try {
            response?.close()
        } catch (ignored: Exception) {
        }
    }

    fun run() {
        try {
            if (storage.length(destPath) > 0) {
                listener.onDone(destPath)
                return
            }
            storage.prepareParent(destPath)

            var digest = Sha256Digest()
            var offset = 0L
            if (storage.length(partPath) >= 0) {
                offset = hashExistingPrefix(digest)
                if (cancelled) return
            }

            val opened = transport.open(url, offset)
            response = opened
            var done: Long
            try {
                if (opened.code < 200 || opened.code >= 300) {
                    listener.onError("Model download failed: HTTP " + opened.code)
                    return
                }
                val resumed = opened.code == 206
                if (offset > 0 && !resumed) {
                    // Server ignored the Range header; start over.
                    offset = 0L
                    digest = Sha256Digest()
                }
                val total =
                    if (expectedTotalBytes > 0) expectedTotalBytes
                    else if (opened.contentLength > 0) offset + opened.contentLength
                    else -1L

                val out = storage.openWrite(partPath, resumed)
                try {
                    val buffer = ByteArray(1 shl 16)
                    done = offset
                    var lastProgressAt = 0L
                    while (true) {
                        val read = opened.read(buffer)
                        if (read < 0) break
                        if (cancelled) return
                        out.write(buffer, 0, read)
                        digest.update(buffer, 0, read)
                        done += read
                        val time = now()
                        if (time - lastProgressAt >= PROGRESS_INTERVAL_MS) {
                            lastProgressAt = time
                            listener.onProgress(done, total)
                        }
                    }
                } finally {
                    out.close()
                }
            } finally {
                try {
                    opened.close()
                } catch (ignored: Exception) {
                }
            }

            val partLength = storage.length(partPath)
            if (expectedTotalBytes > 0 && partLength != expectedTotalBytes) {
                listener.onError("Model download ended early (" + partLength + " of " + expectedTotalBytes + " bytes); try again to resume")
                return
            }
            val actualSha = BinaryEncoding.bytesToHex(digest.digest())
            if (expectedSha256.isNotEmpty() && actualSha != expectedSha256) {
                storage.delete(partPath)
                listener.onError("Model download was corrupted (checksum mismatch); download it again")
                return
            }
            if (!storage.rename(partPath, destPath)) {
                listener.onError("Could not move the downloaded model into place")
                return
            }
            listener.onDone(destPath)
        } catch (e: Exception) {
            if (cancelled) return
            PlatformLog.w(TAG, "download failed: $e")
            listener.onError("Model download failed: $e")
        }
    }

    /** Hash the already-downloaded prefix so the final digest covers the whole file. */
    private fun hashExistingPrefix(digest: Sha256Digest): Long =
        storage.readAll(partPath) { bytes, count ->
            if (cancelled) false
            else {
                digest.update(bytes, 0, count)
                true
            }
        }

    companion object {
        private const val TAG = "FaceclawModelDl"
        const val PROGRESS_INTERVAL_MS = 500L
    }
}
