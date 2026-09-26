package com.faceclaw.app

import kotlin.jvm.JvmStatic

/** Streaming POST transport; the platform (okhttp, NSURLSession) implements it. */
interface StreamingHttp {
    fun post(url: String, body: String, headers: List<Pair<String, String>>, sink: ChunkSink): Cancellable
}

interface Cancellable {
    fun cancel()
}

/** Raw response feed from a [StreamingHttp]; may be called from any thread, one call at a time. */
interface ChunkSink {
    fun onStatus(code: Int)

    fun onChunk(bytes: ByteArray, offset: Int, length: Int)

    fun onComplete()

    fun onFailure(message: String)
}

sealed class SseEvent {
    data class Line(val text: String) : SseEvent()

    data class HttpError(val code: Int, val body: String) : SseEvent()

    object Complete : SseEvent()

    data class Failure(val message: String) : SseEvent()
}

/**
 * Server-sent-events response policy shared by both platforms. Feeds raw bytes in through
 * [ChunkSink] and queues [SseEvent]s for [takeEvents]. Behavior (matching the stricter iOS
 * implementation): a UTF-8 BOM is stripped from the first line; lines split on LF, CR or CRLF;
 * non-2xx responses buffer at most [ERROR_BODY_LIMIT] bytes of body and end in [SseEvent.HttpError];
 * a single line over [LINE_LIMIT] bytes, invalid UTF-8, or more than [QUEUE_BYTE_LIMIT] bytes /
 * [QUEUE_EVENT_LIMIT] events waiting to be taken end the stream with a [SseEvent.Failure].
 * After the terminal event nothing further is queued; [cancel] drops everything.
 */
class SseStream : ChunkSink {
    private val lock = protocolPlatform().createLock()
    private val events = ArrayList<SseEvent>()
    private var queuedBytes = 0L
    private var buffer = ByteArray(4096)
    private var bufferLength = 0
    private var status = 0
    private var firstLine = true
    private var finished = false
    private var cancelled = false

    val isFinished: Boolean
        get() = lock.withLock { finished }

    override fun onStatus(code: Int) {
        lock.withLock { status = code }
    }

    override fun onChunk(bytes: ByteArray, offset: Int, length: Int) {
        lock.withLock {
            if (finished || cancelled || length <= 0) return
            if (status < 200 || status >= 300) {
                val remaining = ERROR_BODY_LIMIT - bufferLength
                append(bytes, offset, minOf(remaining, length))
                return
            }
            append(bytes, offset, length)
            var start = 0
            var i = 0
            while (i < bufferLength) {
                val c = buffer[i]
                if (c != CR && c != LF) {
                    i++
                    continue
                }
                if (c == CR && i + 1 == bufferLength) break
                line(start, i - start)
                if (finished) return
                if (c == CR && buffer[i + 1] == LF) i++
                start = i + 1
                i++
            }
            if (start > 0) {
                buffer.copyInto(buffer, 0, start, bufferLength)
                bufferLength -= start
            }
            if (bufferLength > LINE_LIMIT) finish(SseEvent.Failure("Streaming response line too large"))
        }
    }

    override fun onComplete() {
        lock.withLock {
            if (finished || cancelled) return
            if (status < 200 || status >= 300) {
                finish(SseEvent.HttpError(status, decode(0, bufferLength) ?: ""))
                return
            }
            if (bufferLength > 0) {
                if (buffer[bufferLength - 1] == CR) bufferLength--
                line(0, bufferLength)
                if (finished) return
            }
            finish(SseEvent.Complete)
        }
    }

    override fun onFailure(message: String) {
        lock.withLock { finish(SseEvent.Failure(message)) }
    }

    /** Drains queued events in order. Empty once cancelled. */
    fun takeEvents(): List<SseEvent> =
        lock.withLock {
            if (events.isEmpty()) return emptyList()
            val taken = ArrayList(events)
            events.clear()
            queuedBytes = 0
            taken
        }

    fun cancel() {
        lock.withLock {
            cancelled = true
            events.clear()
            queuedBytes = 0
            bufferLength = 0
        }
    }

    private fun line(start: Int, length: Int) {
        var text = decode(start, length)
        if (text == null) {
            finish(SseEvent.Failure("Invalid UTF-8 in streaming response"))
            return
        }
        if (firstLine && text.startsWith('﻿')) text = text.substring(1)
        firstLine = false
        queuedBytes += length
        if (queuedBytes > QUEUE_BYTE_LIMIT || events.size >= QUEUE_EVENT_LIMIT) {
            events.clear()
            finish(SseEvent.Failure("Streaming response queue overflow"))
            return
        }
        events.add(SseEvent.Line(text))
    }

    private fun decode(start: Int, length: Int): String? =
        try {
            buffer.decodeToString(start, start + length, throwOnInvalidSequence = true)
        } catch (e: CharacterCodingException) {
            null
        }

    private fun finish(event: SseEvent) {
        if (finished || cancelled) return
        finished = true
        events.add(event)
        bufferLength = 0
    }

    private fun append(bytes: ByteArray, offset: Int, length: Int) {
        if (length <= 0) return
        if (bufferLength + length > buffer.size) buffer = buffer.copyOf(maxOf(bufferLength + length, buffer.size * 2))
        bytes.copyInto(buffer, bufferLength, offset, offset + length)
        bufferLength += length
    }

    companion object {
        const val ERROR_BODY_LIMIT = 64 * 1024
        const val LINE_LIMIT = 2 * 1024 * 1024
        const val QUEUE_BYTE_LIMIT = 8L * 1024 * 1024
        const val QUEUE_EVENT_LIMIT = 16384
        private const val CR: Byte = '\r'.code.toByte()
        private const val LF: Byte = '\n'.code.toByte()

        /**
         * Unpacks the flat alternating [name, value, name, value, ...] header array the
         * TypeScript side builds (okhttp Headers cannot cross the JS bridge). Entries with a
         * null/empty name or a null value are skipped, as before.
         */
        @JvmStatic
        fun unpackHeaders(flat: Array<String?>?): List<Pair<String, String>> {
            if (flat == null) return emptyList()
            val result = ArrayList<Pair<String, String>>()
            var i = 0
            while (i + 1 < flat.size) {
                val name = flat[i]
                val value = flat[i + 1]
                if (!name.isNullOrEmpty() && value != null) result.add(name to value)
                i += 2
            }
            return result
        }

        /** Delivers one event to a [FaceclawSseListener]. */
        @JvmStatic
        fun deliver(event: SseEvent, listener: FaceclawSseListener) {
            when (event) {
                is SseEvent.Line -> listener.onLine(event.text)
                is SseEvent.HttpError -> listener.onHttpError(event.code, event.body)
                SseEvent.Complete -> listener.onComplete()
                is SseEvent.Failure -> listener.onFailure(event.message)
            }
        }
    }
}
