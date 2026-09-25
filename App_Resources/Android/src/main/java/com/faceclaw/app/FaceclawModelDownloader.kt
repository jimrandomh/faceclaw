package com.faceclaw.app

import android.os.Handler
import android.os.Looper

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.util.concurrent.TimeUnit

import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Large-file downloader for on-phone model weights (multi-GB, from Hugging
 * Face). The resume/hash/verify/rename policy is the shared ResumableDownload;
 * this class supplies okhttp, java.io storage, the worker thread, and posts
 * listener callbacks to the constructing thread's Looper, like the other
 * Faceclaw bridges.
 */
class FaceclawModelDownloader(
    url: String,
    destPath: String,
    expectedSha256: String?,
    expectedTotalBytes: Long,
    listener: FaceclawModelDownloaderListener?
) {
    private val callbackHandler: Handler
    private val transport = OkHttpTransport()
    private val download: ResumableDownload
    private var worker: Thread? = null

    init {
        if (listener == null) throw IllegalArgumentException("listener is required")
        val looper = Looper.myLooper()
        this.callbackHandler = Handler(looper ?: Looper.getMainLooper())
        val posted = object : FaceclawModelDownloaderListener {
            override fun onProgress(bytesDownloaded: Long, totalBytes: Long) {
                callbackHandler.post { listener.onProgress(bytesDownloaded, totalBytes) }
            }

            override fun onDone(path: String?) {
                callbackHandler.post { listener.onDone(path) }
            }

            override fun onError(message: String?) {
                callbackHandler.post { listener.onError(message) }
            }
        }
        download = ResumableDownload(url, File(destPath).absolutePath, expectedSha256, expectedTotalBytes, transport, FileStorage, posted)
    }

    companion object {
        @Volatile
        private var sharedClient: OkHttpClient? = null

        private fun getClient(): OkHttpClient {
            if (sharedClient == null) {
                synchronized(FaceclawModelDownloader::class.java) {
                    if (sharedClient == null) {
                        sharedClient = OkHttpClient.Builder()
                            .connectTimeout(30, TimeUnit.SECONDS)
                            .readTimeout(60, TimeUnit.SECONDS)
                            .addInterceptor(FaceclawHttp.userAgentInterceptor())
                            .build()
                    }
                }
            }
            return sharedClient!!
        }
    }

    fun start() {
        val thread = Thread({ download.run() }, "FaceclawModelDl")
        worker = thread
        thread.start()
    }

    /** Stops the download but keeps the .part file so a later start() resumes. */
    fun cancel() {
        download.cancel()
        transport.call?.cancel()
    }

    /** One call at a time per downloader, so cancel() can abort a connect in progress. */
    private class OkHttpTransport : DownloadTransport {
        @Volatile
        var call: Call? = null

        override fun open(url: String, rangeFrom: Long): DownloadResponse {
            val builder = Request.Builder().url(url)
            if (rangeFrom > 0) builder.header("Range", "bytes=$rangeFrom-")
            val call: Call = getClient().newCall(builder.build())
            this.call = call
            val response = call.execute()
            val body = response.body
            val input: InputStream? = body?.byteStream()
            return object : DownloadResponse {
                override val code: Int = response.code
                override val contentLength: Long = body?.contentLength() ?: -1L

                override fun read(buffer: ByteArray): Int = input?.read(buffer) ?: -1

                override fun close() {
                    call.cancel()
                    response.close()
                }
            }
        }
    }

    private object FileStorage : DownloadStorage {
        override fun length(path: String): Long = File(path).let { if (it.exists()) it.length() else -1L }

        override fun prepareParent(path: String) {
            File(path).parentFile?.mkdirs()
        }

        override fun openWrite(path: String, append: Boolean): FileSink {
            val out = FileOutputStream(path, append)
            return object : FileSink {
                override fun write(bytes: ByteArray, offset: Int, length: Int) = out.write(bytes, offset, length)

                override fun close() = out.close()
            }
        }

        override fun readAll(path: String, consumer: (ByteArray, Int) -> Boolean): Long {
            var consumed = 0L
            FileInputStream(path).use { input ->
                val buffer = ByteArray(1 shl 16)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    if (!consumer(buffer, read)) break
                    consumed += read
                }
            }
            return consumed
        }

        override fun rename(from: String, to: String): Boolean = File(from).renameTo(File(to))

        override fun delete(path: String): Boolean = File(path).delete()
    }
}
