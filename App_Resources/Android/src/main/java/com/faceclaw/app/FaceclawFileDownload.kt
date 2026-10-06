package com.faceclaw.app

import android.os.Handler
import android.os.Looper

import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit

import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * One GET streamed straight to a file on a worker thread. For binary bodies
 * too large to cross into JS through NativeScript's fetch(), which copies the
 * Java byte[] into a Uint8Array one bridge call per byte (a 43MB EvenHub
 * package ran the process out of native memory). JS reads the finished file
 * back with one bulk copy (readBinaryFile).
 */
class FaceclawFileDownload(
    private val url: String,
    private val destPath: String,
    private val timeoutMs: Long,
    listener: FaceclawFileDownloadListener?
) {
    private val callbackHandler = Handler(Looper.myLooper() ?: Looper.getMainLooper())
    private val listener: FaceclawFileDownloadListener =
        listener ?: throw IllegalArgumentException("listener is required")

    @Volatile
    private var call: Call? = null

    @Volatile
    private var cancelled = false

    fun start() {
        Thread({ run() }, "FaceclawFileDl").start()
    }

    /** Aborts the request; no callback follows. */
    fun cancel() {
        cancelled = true
        call?.cancel()
    }

    private fun run() {
        val dest = File(destPath)
        try {
            dest.parentFile?.mkdirs()
            val request = Request.Builder().url(url).build()
            val call = getClient().newCall(request)
            call.timeout().timeout(timeoutMs, TimeUnit.MILLISECONDS)
            this.call = call
            call.execute().use { response ->
                val body = response.body
                val contentLength = body?.contentLength() ?: -1L
                if (response.isSuccessful && body != null) {
                    body.byteStream().use { input ->
                        FileOutputStream(dest).use { output -> input.copyTo(output, 1 shl 16) }
                    }
                }
                if (!cancelled) callbackHandler.post { listener.onDone(response.code, contentLength) }
            }
        } catch (e: Exception) {
            dest.delete()
            if (!cancelled) callbackHandler.post { listener.onFailure(e.message ?: e.toString()) }
        }
    }

    companion object {
        @Volatile
        private var sharedClient: OkHttpClient? = null

        private fun getClient(): OkHttpClient {
            if (sharedClient == null) {
                synchronized(FaceclawFileDownload::class.java) {
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
}
