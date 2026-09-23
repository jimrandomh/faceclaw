package com.faceclaw.app

import android.os.Handler
import android.os.Looper
import android.util.Log

import java.io.BufferedReader
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
 */
class FaceclawSseRequest
/**
 * Starts the request immediately. headers is a flat alternating
 * [name, value, name, value, ...] array (okhttp Headers can't cross the
 * JS bridge, and parallel arrays are easy to build with Array.create).
 */
constructor(url: String?, jsonBody: String?, headers: Array<String?>?, listener: FaceclawSseListener?) {
    private val callbackHandler: Handler
    private val call: Call
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
        val builder = Request.Builder()
            .url(url.trim())
            .post((jsonBody ?: "").toRequestBody(JSON))
        if (headers != null) {
            var i = 0
            while (i + 1 < headers.size) {
                val name = headers[i]
                val value = headers[i + 1]
                if (name != null && !name.isEmpty() && value != null) {
                    builder.addHeader(name, value)
                }
                i += 2
            }
        }
        call = getClient().newCall(builder.build())
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                postFailure(listener, e.toString())
            }

            override fun onResponse(call: Call, response: Response) {
                try {
                    response.body.use { body ->
                        if (!response.isSuccessful) {
                            val code = response.code
                            var errorBody = ""
                            try {
                                errorBody = body?.string() ?: ""
                            } catch (e: IOException) {
                                Log.w(TAG, "error body read failed", e)
                            }
                            val finalBody = errorBody
                            post { listener.onHttpError(code, finalBody) }
                            return
                        }
                        if (body == null) {
                            post { listener.onComplete() }
                            return
                        }
                        val reader = BufferedReader(body.charStream())
                        var line: String?
                        while (reader.readLine().also { line = it } != null) {
                            val finalLine = line
                            post { listener.onLine(finalLine) }
                        }
                        post { listener.onComplete() }
                    }
                } catch (e: IOException) {
                    postFailure(listener, e.toString())
                }
            }
        })
    }

    fun cancel() {
        cancelled = true
        call.cancel()
    }

    private fun post(runnable: Runnable) {
        if (cancelled) {
            return
        }
        callbackHandler.post {
            if (cancelled) {
                return@post
            }
            try {
                runnable.run()
            } catch (t: Throwable) {
                Log.w(TAG, "listener callback failed", t)
            }
        }
    }

    private fun postFailure(listener: FaceclawSseListener, message: String) {
        if (cancelled) {
            return
        }
        post { listener.onFailure(message) }
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
                        sharedClient = OkHttpClient.Builder()
                            .connectTimeout(15, TimeUnit.SECONDS)
                            .readTimeout(180, TimeUnit.SECONDS)
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
