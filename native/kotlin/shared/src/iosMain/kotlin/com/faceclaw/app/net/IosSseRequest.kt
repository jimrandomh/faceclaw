package com.faceclaw.app

import kotlin.concurrent.Volatile

import platform.Foundation.NSRecursiveLock
import platform.UIKit.UIApplication
import platform.UIKit.UIBackgroundTaskIdentifier
import platform.UIKit.UIBackgroundTaskInvalid

/**
 * iOS twin of the Android FaceclawSseRequest for app/native/sse.ios.ts: starts a streaming
 * POST immediately and pushes the shared [SseStream] events to [listener] on the main queue,
 * in order. A UIKit background task keeps the stream alive while the app is backgrounded.
 * headersJson is a JSON object of header name to value.
 */
class IosSseRequest internal constructor(
    url: String,
    body: String,
    headersJson: String?,
    private val listener: FaceclawSseListener,
    private val dispatch: (() -> Unit) -> Unit,
    keepAliveInBackground: Boolean,
) {
    constructor(url: String, body: String, headersJson: String?, listener: FaceclawSseListener) :
        this(url, body, headersJson, listener, ::dispatchToMain, true)

    private val stream = SseStream()
    private val lock = NSRecursiveLock()
    private var backgroundTask: UIBackgroundTaskIdentifier = UIBackgroundTaskInvalid
    private var keepAlive = keepAliveInBackground

    @Volatile
    private var cancelled = false
    private val transfer: Cancellable

    init {
        val headers = ArrayList<Pair<String, String>>()
        if (!headersJson.isNullOrBlank()) {
            runCatching { Json.parse(headersJson).asObject() }.getOrNull()?.forEach { (name, value) ->
                val text = value.asString()
                if (name.isNotEmpty() && text != null) headers.add(name to text)
            }
        }
        if (keepAlive) dispatchToMain { beginBackgroundTask() }
        val sink = object : ChunkSink {
            override fun onStatus(code: Int) = stream.onStatus(code)

            override fun onChunk(bytes: ByteArray, offset: Int, length: Int) {
                stream.onChunk(bytes, offset, length)
                drain()
            }

            override fun onComplete() {
                stream.onComplete()
                drain()
            }

            override fun onFailure(message: String) {
                stream.onFailure(message)
                drain()
            }
        }
        transfer = IosStreamingHttp.post(url.trim(), body, headers, sink)
    }

    fun cancel() {
        cancelled = true
        stream.cancel()
        transfer.cancel()
        if (keepAlive) dispatchToMain { endBackgroundTask() }
    }

    /** Hands every queued event to the listener on the main queue, in order. */
    private fun drain() {
        val events = stream.takeEvents()
        if (events.isEmpty()) return
        dispatch {
            for (event in events) {
                if (cancelled) return@dispatch
                try {
                    SseStream.deliver(event, listener)
                } catch (t: Throwable) {
                    PlatformLog.w(TAG, "listener callback failed: ${t.message}")
                }
            }
            if (stream.isFinished && keepAlive) endBackgroundTask()
        }
    }

    // Main queue only.
    private fun beginBackgroundTask() {
        lock.lock()
        try {
            if (cancelled || stream.isFinished || backgroundTask != UIBackgroundTaskInvalid) return
            backgroundTask = UIApplication.sharedApplication.beginBackgroundTaskWithName("Assistant response") {
                stream.onFailure("iOS background time expired. Open Faceclaw and retry.")
                drain()
                endBackgroundTask()
            }
        } finally {
            lock.unlock()
        }
    }

    private fun endBackgroundTask() {
        lock.lock()
        try {
            if (backgroundTask == UIBackgroundTaskInvalid) return
            UIApplication.sharedApplication.endBackgroundTask(backgroundTask)
            backgroundTask = UIBackgroundTaskInvalid
        } finally {
            lock.unlock()
        }
    }

    private companion object {
        const val TAG = "FaceclawSseRequest"
    }
}
