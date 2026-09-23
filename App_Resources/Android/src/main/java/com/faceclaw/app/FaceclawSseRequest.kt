package com.faceclaw.app

import android.os.Handler
import android.os.Looper
import android.util.Log

import java.io.IOException
import java.util.concurrent.TimeUnit

import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * Streaming HTTP POST for the TypeScript side, used for server-sent-events
 * APIs (e.g. the Anthropic Messages API with stream=true). The response body
 * is delivered line by line as it arrives, so the JS side can parse SSE
 * events incrementally. Like FaceclawWebSocket, listener callbacks are posted
 * to the Looper of the thread that constructed this object.
 *
 * The line splitting, error-body and overflow policy live in the shared
 * SseStream; this class only supplies okhttp as the transport and the Handler
 * delivery.
 */
class FaceclawSseRequest
/**
 * Starts the request immediately. headers is a flat alternating
 * [name, value, name, value, ...] array (okhttp Headers can't cross the
 * JS bridge, and parallel arrays are easy to build with Array.create).
 */
constructor(url: String?, jsonBody: String?, headers: Array<String?>?, listener: FaceclawSseListener?) {
    private val callbackHandler: Handler
    private val stream = SseStream()
    private val transfer: Cancellable
    @Volatile
    private var cancelled = false

    init {
        if (url == null || url.trim().isEmpty()) {
            throw IllegalArgumentException("url is required")
        }
        if (listener == null) {
            throw IllegalArgumentException("listener is required")
        }
        val looper = Looper.myLooper()
        callbackHandler = Handler(looper ?: Looper.getMainLooper())
        val sink = object : ChunkSink {
            override fun onStatus(code: Int) {
                stream.onStatus(code)
            }

            override fun onChunk(bytes: ByteArray, offset: Int, length: Int) {
                stream.onChunk(bytes, offset, length)
                drain(listener)
            }

            override fun onComplete() {
                stream.onComplete()
                drain(listener)
            }

            override fun onFailure(message: String) {
                stream.onFailure(message)
                drain(listener)
            }
        }
        transfer = OkHttpStreaming.post(url.trim(), jsonBody ?: "", SseStream.unpackHeaders(headers), sink)
    }

    fun cancel() {
        cancelled = true
        stream.cancel()
        transfer.cancel()
    }

    /** Hands every queued event to the listener on the constructing thread, in order. */
    private fun drain(listener: FaceclawSseListener) {
        val events = stream.takeEvents()
        if (events.isEmpty()) return
        post {
            for (event in events) {
                if (cancelled) return@post
                try {
                    SseStream.deliver(event, listener)
                } catch (t: Throwable) {
                    Log.w(TAG, "listener callback failed", t)
                }
            }
        }
    }

    private fun post(runnable: Runnable) {
        if (cancelled) {
            return
        }
        callbackHandler.post {
            if (cancelled) {
                return@post
            }
            runnable.run()
        }
    }

    /** okhttp transport: enqueues the call and feeds the body to the sink in chunks. */
    private object OkHttpStreaming : StreamingHttp {
        override fun post(url: String, body: String, headers: List<Pair<String, String>>, sink: ChunkSink): Cancellable {
            val builder = Request.Builder()
                .url(url)
                .post(body.toRequestBody(JSON))
            for ((name, value) in headers) builder.addHeader(name, value)
            val call = getClient().newCall(builder.build())
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    sink.onFailure(e.toString())
                }

                override fun onResponse(call: Call, response: Response) {
                    try {
                        response.use {
                            sink.onStatus(response.code)
                            val input = response.body?.byteStream()
                            if (input != null) {
                                val buffer = ByteArray(8192)
                                while (true) {
                                    val read = input.read(buffer)
                                    if (read < 0) break
                                    if (read > 0) sink.onChunk(buffer, 0, read)
                                }
                            }
                            sink.onComplete()
                        }
                    } catch (e: IOException) {
                        sink.onFailure(e.toString())
                    }
                }
            })
            return object : Cancellable {
                override fun cancel() = call.cancel()
            }
        }
    }

    companion object {
        private const val TAG = "FaceclawSseRequest"
        private val JSON: MediaType = "application/json; charset=utf-8".toMediaType()
        @Volatile
        private var sharedClient: OkHttpClient? = null

        private fun getClient(): OkHttpClient {
            var client = sharedClient
            if (client == null) {
                synchronized(FaceclawSseRequest::class.java) {
                    if (sharedClient == null) {
                        // Streaming responses can pause between events (e.g. while
                        // the model thinks), so the read timeout is generous. The
                        // Anthropic API sends periodic ping events well within it.
                        // Redirects are not followed: provider credentials in the
                        // headers must never be forwarded to another endpoint (a
                        // 3xx surfaces to the listener as an HTTP error instead).
                        sharedClient = OkHttpClient.Builder()
                            .connectTimeout(15, TimeUnit.SECONDS)
                            .readTimeout(180, TimeUnit.SECONDS)
                            .followRedirects(false)
                            .followSslRedirects(false)
                            .addInterceptor(FaceclawHttp.userAgentInterceptor())
                            .build()
                    }
                    client = sharedClient
                }
            }
            return client!!
        }
    }
}
