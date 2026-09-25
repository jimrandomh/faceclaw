package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ResumableDownloadTest {
    private class Storage : DownloadStorage {
        val files = HashMap<String, ByteArray>()
        override fun length(path: String): Long = files[path]?.size?.toLong() ?: -1L
        override fun prepareParent(path: String) {}
        override fun openWrite(path: String, append: Boolean): FileSink {
            if (!append) files[path] = ByteArray(0)
            return object : FileSink {
                override fun write(bytes: ByteArray, offset: Int, length: Int) {
                    files[path] = (files[path] ?: ByteArray(0)) + bytes.copyOfRange(offset, offset + length)
                }
                override fun close() {}
            }
        }
        override fun readAll(path: String, consumer: (ByteArray, Int) -> Boolean): Long {
            val data = files[path] ?: return 0
            var at = 0L
            for (chunk in data.toList().chunked(7)) {
                val bytes = chunk.toByteArray()
                if (!consumer(bytes, bytes.size)) break
                at += bytes.size
            }
            return at
        }
        override fun rename(from: String, to: String): Boolean { files[to] = files.remove(from) ?: return false; return true }
        override fun delete(path: String): Boolean = files.remove(path) != null
    }

    private class Transport(val content: ByteArray, val honorRange: Boolean = true, val truncateAt: Int = -1) : DownloadTransport {
        var lastRange = -1L
        override fun open(url: String, rangeFrom: Long): DownloadResponse {
            lastRange = rangeFrom
            val start = if (honorRange) rangeFrom.toInt() else 0
            val end = if (truncateAt >= 0) minOf(truncateAt, content.size) else content.size
            val body = content.copyOfRange(start, end)
            var at = 0
            return object : DownloadResponse {
                override val code: Int = if (honorRange && rangeFrom > 0) 206 else 200
                override val contentLength: Long = body.size.toLong()
                override fun read(buffer: ByteArray): Int {
                    if (at >= body.size) return -1
                    val n = minOf(5, body.size - at)
                    body.copyInto(buffer, 0, at, at + n)
                    at += n
                    return n
                }
                override fun close() {}
            }
        }
    }

    private class Events : FaceclawModelDownloaderListener {
        val progress = ArrayList<Pair<Long, Long>>()
        var done: String? = null
        var error: String? = null
        override fun onProgress(bytesDownloaded: Long, totalBytes: Long) { progress.add(bytesDownloaded to totalBytes) }
        override fun onDone(path: String?) { done = path }
        override fun onError(message: String?) { error = message }
    }

    private val content = ByteArray(40) { (it * 3).toByte() }
    private val sha = sha256Hex(content)

    private fun run(storage: Storage, transport: Transport, expectedSha: String? = sha, total: Long = content.size.toLong()): Events {
        val events = Events()
        var clock = 0L
        ResumableDownload("http://x/m", "/dest/model", expectedSha, total, transport, storage, events) { clock += 600; clock }.run()
        return events
    }

    @Test
    fun freshDownloadVerifiesAndRenames() {
        val storage = Storage()
        val transport = Transport(content)
        val events = run(storage, transport)
        assertNull(events.error)
        assertEquals("/dest/model", events.done)
        assertEquals(content.toList(), storage.files["/dest/model"]!!.toList())
        assertEquals(0L, transport.lastRange)
        assertTrue(events.progress.isNotEmpty() && events.progress.last().second == 40L)
        val again = run(storage, transport)
        assertEquals("/dest/model", again.done)
    }

    @Test
    fun resumesFromPartWhenServerHonorsRange() {
        val storage = Storage()
        storage.files["/dest/model.part"] = content.copyOfRange(0, 17)
        val transport = Transport(content)
        val events = run(storage, transport)
        assertEquals(17L, transport.lastRange)
        assertNull(events.error)
        assertEquals(content.toList(), storage.files["/dest/model"]!!.toList())
    }

    @Test
    fun restartsWhenServerIgnoresRange() {
        val storage = Storage()
        storage.files["/dest/model.part"] = ByteArray(17) { 1 }
        val transport = Transport(content, honorRange = false)
        val events = run(storage, transport)
        assertEquals(17L, transport.lastRange)
        assertNull(events.error)
        assertEquals(content.toList(), storage.files["/dest/model"]!!.toList())
    }

    @Test
    fun checksumMismatchDeletesPart() {
        val storage = Storage()
        val events = run(storage, Transport(content), expectedSha = "00".repeat(32))
        assertEquals("Model download was corrupted (checksum mismatch); download it again", events.error)
        assertNull(storage.files["/dest/model.part"])
        assertNull(storage.files["/dest/model"])
    }

    @Test
    fun shortBodyKeepsPartForResume() {
        val storage = Storage()
        val events = run(storage, Transport(content, truncateAt = 30))
        assertEquals("Model download ended early (30 of 40 bytes); try again to resume", events.error)
        assertEquals(30, storage.files["/dest/model.part"]!!.size)
        val resumed = run(storage, Transport(content))
        assertNull(resumed.error)
        assertEquals(content.toList(), storage.files["/dest/model"]!!.toList())
    }

    @Test
    fun httpErrorIsReported() {
        val storage = Storage()
        val transport = object : DownloadTransport {
            override fun open(url: String, rangeFrom: Long): DownloadResponse = object : DownloadResponse {
                override val code = 404
                override val contentLength = -1L
                override fun read(buffer: ByteArray) = -1
                override fun close() {}
            }
        }
        val events = Events()
        ResumableDownload("u", "/dest/model", null, 0, transport, storage, events).run()
        assertEquals("Model download failed: HTTP 404", events.error)
    }
}
