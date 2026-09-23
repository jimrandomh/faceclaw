package com.faceclaw.app

import android.os.Handler
import android.os.Looper
import android.util.Log

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Large-file downloader for on-phone model weights (multi-GB, from Hugging
 * Face). Downloads to "<dest>.part" with HTTP Range resume across app
 * restarts, verifies a pinned sha256 (hashed incrementally, including the
 * resumed prefix), then renames into place. Listener callbacks are posted to
 * the constructing thread's Looper, like the other Faceclaw bridges.
 */
class FaceclawModelDownloader(
    url: String,
    destPath: String,
    expectedSha256: String?,
    expectedTotalBytes: Long,
    listener: FaceclawModelDownloaderListener?
) {
    private val callbackHandler: Handler
    private val url: String
    private val destFile: File
    private val partFile: File
    private val expectedSha256: String
    private val expectedTotalBytes: Long
    private val listener: FaceclawModelDownloaderListener

    @Volatile
    private var cancelled = false
    @Volatile
    private var call: Call? = null
    private var worker: Thread? = null

    init {
        if (listener == null) throw IllegalArgumentException("listener is required")
        val looper = Looper.myLooper()
        this.callbackHandler = Handler(looper ?: Looper.getMainLooper())
        this.url = url
        this.destFile = File(destPath)
        this.partFile = File("$destPath.part")
        this.expectedSha256 = expectedSha256?.lowercase() ?: ""
        this.expectedTotalBytes = expectedTotalBytes
        this.listener = listener
    }

    companion object {
        private const val TAG = "FaceclawModelDl"
        private const val PROGRESS_INTERVAL_MS = 500L

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
        val thread = Thread({ run() }, "FaceclawModelDl")
        worker = thread
        thread.start()
    }

    /** Stops the download but keeps the .part file so a later start() resumes. */
    fun cancel() {
        cancelled = true
        val current = call
        current?.cancel()
    }

    private fun run() {
        try {
            if (destFile.exists() && destFile.length() > 0) {
                post { listener.onDone(destFile.absolutePath) }
                return
            }
            destFile.parentFile.mkdirs()

            var digest = MessageDigest.getInstance("SHA-256")
            var offset = 0L
            if (partFile.exists()) {
                offset = hashExistingPrefix(digest)
                if (cancelled) return
            }

            val builder = Request.Builder().url(url)
            if (offset > 0) builder.header("Range", "bytes=$offset-")
            val newCall = getClient().newCall(builder.build())
            call = newCall

            newCall.execute().use { response ->
                val body = response.body
                if (!response.isSuccessful || body == null) {
                    postError("Model download failed: HTTP " + response.code)
                    return
                }
                val resumed = response.code == 206
                if (offset > 0 && !resumed) {
                    // Server ignored the Range header; start over.
                    offset = 0L
                    digest = MessageDigest.getInstance("SHA-256")
                }
                val total = if (expectedTotalBytes > 0) expectedTotalBytes
                    else (if (body.contentLength() > 0) offset + body.contentLength() else -1L)

                FileOutputStream(partFile, resumed).use { out ->
                    body.byteStream().use { input ->
                        val buffer = ByteArray(1 shl 16)
                        var done = offset
                        var lastProgressAt = 0L
                        var read: Int
                        while (input.read(buffer).also { read = it } != -1) {
                            if (cancelled) return
                            out.write(buffer, 0, read)
                            digest.update(buffer, 0, read)
                            done += read
                            val now = System.currentTimeMillis()
                            if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
                                lastProgressAt = now
                                val doneFinal = done
                                val totalFinal = total
                                post { listener.onProgress(doneFinal, totalFinal) }
                            }
                        }
                    }
                }
            }

            if (expectedTotalBytes > 0 && partFile.length() != expectedTotalBytes) {
                postError("Model download ended early (" + partFile.length() + " of "
                    + expectedTotalBytes + " bytes); try again to resume")
                return
            }
            val actualSha = FaceclawFirmwareUtil.bytesToHex(digest.digest())
            if (!expectedSha256.isEmpty() && actualSha != expectedSha256) {
                partFile.delete()
                postError("Model download was corrupted (checksum mismatch); download it again")
                return
            }
            if (!partFile.renameTo(destFile)) {
                postError("Could not move the downloaded model into place")
                return
            }
            post { listener.onDone(destFile.absolutePath) }
        } catch (e: Exception) {
            if (cancelled) return
            Log.w(TAG, "download failed", e)
            postError("Model download failed: $e")
        }
    }

    /** Hash the already-downloaded prefix so the final digest covers the whole file. */
    @Throws(IOException::class)
    private fun hashExistingPrefix(digest: MessageDigest): Long {
        var hashed = 0L
        FileInputStream(partFile).use { input ->
            val buffer = ByteArray(1 shl 16)
            var read: Int
            while (input.read(buffer).also { read = it } != -1) {
                if (cancelled) return hashed
                digest.update(buffer, 0, read)
                hashed += read
            }
        }
        return hashed
    }

    private fun post(runnable: Runnable) {
        callbackHandler.post(runnable)
    }

    private fun postError(message: String) {
        post { listener.onError(message) }
    }
}
