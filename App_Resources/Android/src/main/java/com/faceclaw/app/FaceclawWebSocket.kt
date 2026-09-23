package com.faceclaw.app

import android.os.Handler
import android.os.Looper
import android.util.Log

import java.util.concurrent.TimeUnit

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString

/**
 * Thin okhttp WebSocket wrapper for the TypeScript side. Sends text frames
 * (JSON protocols) and binary frames (raw audio for Soniox). Listener callbacks are
 * posted to the Looper of the thread that constructed this object, so a JS
 * isolate (main thread or app worker) always receives them on its own
 * thread; a Looper-less constructing thread falls back to the main thread.
 */
class FaceclawWebSocket
// Single constructor (no overloads) so NativeScript constructor resolution
// can never pick a variant that drops the auth header; callers with no
// header pass null/null.
constructor(url: String?, listener: FaceclawWebSocketListener?, headerName: String?, headerValue: String?) {
    private val callbackHandler: Handler
    private val socket: WebSocket
    @Volatile
    private var closeRequested = false

    init {
        if (url == null || url.trim().isEmpty()) {
            throw IllegalArgumentException("url is required")
        }
        if (listener == null) {
            throw IllegalArgumentException("listener is required")
        }
        val looper = Looper.myLooper()
        callbackHandler = Handler(looper ?: Looper.getMainLooper())
        val builder = Request.Builder().url(url.trim())
        if (headerName != null && !headerName.isEmpty() && headerValue != null) {
            builder.addHeader(headerName, headerValue)
        }
        val request = builder.build()
        // Redacted diagnostics: confirm the auth header is actually present on
        // the handshake and carries a plausible value (not empty/truncated).
        val headerLog = StringBuilder()
        for (name in request.headers.names()) {
            val value = request.header(name)
            headerLog.append(name).append('=').append(redact(value)).append(' ')
        }
        Log.i(TAG, "ws connect host=" + request.url.host + request.url.encodedPath
            + " headers=[" + headerLog.toString().trim() + "]")
        socket = getClient().newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                callbackHandler.post {
                    try {
                        listener.onOpen()
                    } catch (t: Throwable) {
                        Log.w(TAG, "listener onOpen failed", t)
                    }
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                callbackHandler.post {
                    try {
                        listener.onTextMessage(text)
                    } catch (t: Throwable) {
                        Log.w(TAG, "listener onTextMessage failed", t)
                    }
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                callbackHandler.post {
                    try {
                        listener.onClosed(code, reason)
                    } catch (t: Throwable) {
                        Log.w(TAG, "listener onClosed failed", t)
                    }
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (closeRequested) {
                    return
                }
                val message = t.toString()
                callbackHandler.post {
                    try {
                        listener.onFailure(message)
                    } catch (inner: Throwable) {
                        Log.w(TAG, "listener onFailure failed", inner)
                    }
                }
            }
        })
    }

    companion object {
        private const val TAG = "FaceclawWebSocket"
        @Volatile
        private var sharedClient: OkHttpClient? = null

        private fun getClient(): OkHttpClient {
            var client = sharedClient
            if (client == null) {
                synchronized(FaceclawWebSocket::class.java) {
                    if (sharedClient == null) {
                        sharedClient = OkHttpClient.Builder()
                            .pingInterval(20, TimeUnit.SECONDS)
                            .addInterceptor(FaceclawHttp.userAgentInterceptor())
                            .build()
                    }
                    client = sharedClient
                }
            }
            return client!!
        }

        private fun redact(value: String?): String {
            if (value == null) {
                return "null"
            }
            val len = value.length
            val prefix = value.substring(0, Math.min(4, len))
            return "len$len:$prefix..."
        }
    }

    fun sendText(message: String?): Boolean {
        return socket.send(message ?: "")
    }

    fun sendBinary(bytes: ByteArray?): Boolean {
        return socket.send((bytes ?: ByteArray(0)).toByteString())
    }

    fun close(code: Int, reason: String?) {
        closeRequested = true
        try {
            if (!socket.close(code, reason)) {
                socket.cancel()
            }
        } catch (t: Throwable) {
            socket.cancel()
        }
    }
}
