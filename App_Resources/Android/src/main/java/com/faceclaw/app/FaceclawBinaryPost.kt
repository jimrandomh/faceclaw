package com.faceclaw.app

import android.os.Handler
import android.os.Looper

import java.io.IOException
import java.nio.ByteBuffer
import java.util.concurrent.TimeUnit

import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * One POST of a binary body (a Whisper server WAV upload), sent by start().
 * NativeScript's http module hands an ArrayBuffer body to Java one bridge call
 * per byte, which for a ~1 MB upload stalls the JS thread; here the body
 * arrives as a direct ByteBuffer (copyToJavaByteBuffer) and is copied in bulk.
 * headers is a flat [name, value, ...] array, as for FaceclawSseRequest, and
 * may carry the Content-Type. The response text and status reach the listener
 * on the constructing thread's Looper.
 */
class FaceclawBinaryPost(
    url: String?,
    body: ByteBuffer?,
    headers: Array<String?>?,
    timeoutMs: Long,
    listener: FaceclawBinaryPostListener?
) {
    private val callbackHandler = Handler(Looper.myLooper() ?: Looper.getMainLooper())
    private val listener: FaceclawBinaryPostListener =
        listener ?: throw IllegalArgumentException("listener is required")
    private val call: Call

    @Volatile
    private var cancelled = false

    init {
        if (url == null || url.trim().isEmpty()) {
            throw IllegalArgumentException("url is required")
        }
        val bytes = ByteArray(body?.remaining() ?: 0)
        body?.duplicate()?.get(bytes)
        // No media type on the body, so okhttp keeps the caller's Content-Type header.
        val builder = Request.Builder().url(url.trim()).post(bytes.toRequestBody())
        for ((name, value) in SseStream.unpackHeaders(headers)) builder.addHeader(name, value)
        call = getClient().newCall(builder.build())
        call.timeout().timeout(timeoutMs, TimeUnit.MILLISECONDS)
    }

    fun start() {
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                post { listener.onFailure(e.message ?: e.toString()) }
            }

            override fun onResponse(call: Call, response: Response) {
                val text = try {
                    response.use { it.body?.string() ?: "" }
                } catch (e: IOException) {
                    post { listener.onFailure(e.message ?: e.toString()) }
                    return
                }
                post { listener.onResponse(response.code, text) }
            }
        })
    }

    /** Aborts the request; no callback follows. */
    fun cancel() {
        cancelled = true
        call.cancel()
    }

    private fun post(runnable: () -> Unit) {
        callbackHandler.post {
            if (!cancelled) runnable()
        }
    }

    companion object {
        @Volatile
        private var sharedClient: OkHttpClient? = null

        private fun getClient(): OkHttpClient {
            if (sharedClient == null) {
                synchronized(FaceclawBinaryPost::class.java) {
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
