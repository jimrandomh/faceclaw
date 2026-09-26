package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SseStreamTest {
    private fun feed(stream: SseStream, vararg chunks: String) {
        for (chunk in chunks) {
            val bytes = chunk.encodeToByteArray()
            stream.onChunk(bytes, 0, bytes.size)
        }
    }

    @Test
    fun splitsLinesAcrossChunksWithBomAndCrlf() {
        val stream = SseStream()
        stream.onStatus(200)
        feed(stream, "﻿event: a\r", "\ndata: {\"x\":1}\n\nda", "ta: tail")
        assertEquals(listOf(SseEvent.Line("event: a"), SseEvent.Line("data: {\"x\":1}"), SseEvent.Line("")), stream.takeEvents())
        stream.onComplete()
        assertEquals(listOf(SseEvent.Line("data: tail"), SseEvent.Complete), stream.takeEvents())
        assertTrue(stream.isFinished)
        feed(stream, "late\n")
        assertEquals(emptyList(), stream.takeEvents())
    }

    @Test
    fun errorBodyIsBufferedAndCapped() {
        val stream = SseStream()
        stream.onStatus(429)
        feed(stream, "{\"error\":", "\"slow down\"}\n")
        assertEquals(emptyList(), stream.takeEvents())
        stream.onComplete()
        assertEquals(listOf(SseEvent.HttpError(429, "{\"error\":\"slow down\"}\n")), stream.takeEvents())

        val capped = SseStream()
        capped.onStatus(500)
        val big = ByteArray(SseStream.ERROR_BODY_LIMIT + 100) { 'x'.code.toByte() }
        capped.onChunk(big, 0, big.size)
        capped.onComplete()
        val event = capped.takeEvents().single() as SseEvent.HttpError
        assertEquals(SseStream.ERROR_BODY_LIMIT, event.body.length)
    }

    @Test
    fun queueOverflowAndOversizedLinesFail() {
        val stream = SseStream()
        stream.onStatus(200)
        val line = "x".repeat(1023) + "\n"
        val block = line.repeat(64).encodeToByteArray()
        var fed = 0L
        while (fed <= SseStream.QUEUE_BYTE_LIMIT + block.size) {
            stream.onChunk(block, 0, block.size)
            fed += block.size
        }
        val events = stream.takeEvents()
        assertEquals(SseEvent.Failure("Streaming response queue overflow"), events.single())

        val long = SseStream()
        long.onStatus(200)
        val huge = ByteArray(SseStream.LINE_LIMIT + 1) { 'y'.code.toByte() }
        long.onChunk(huge, 0, huge.size)
        assertEquals(SseEvent.Failure("Streaming response line too large"), long.takeEvents().single())
    }

    @Test
    fun failureAndCancelAreTerminal() {
        val stream = SseStream()
        stream.onStatus(200)
        feed(stream, "a\n")
        stream.onFailure("boom")
        assertEquals(listOf(SseEvent.Line("a"), SseEvent.Failure("boom")), stream.takeEvents())
        val cancelled = SseStream()
        cancelled.onStatus(200)
        feed(cancelled, "a\n")
        cancelled.cancel()
        cancelled.onComplete()
        assertEquals(emptyList(), cancelled.takeEvents())
    }

    @Test
    fun unpacksFlatHeaderArrays() {
        assertEquals(listOf("A" to "1", "C" to "3"), SseStream.unpackHeaders(arrayOf("A", "1", "", "2", "C", "3", "D")))
        assertEquals(emptyList(), SseStream.unpackHeaders(null))
    }
}
