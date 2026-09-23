@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.cinterop.ByteVar
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.alloc
import kotlinx.cinterop.allocPointerTo
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.pointed
import kotlinx.cinterop.ptr
import kotlinx.cinterop.usePinned
import kotlinx.cinterop.value
import platform.Foundation.NSTemporaryDirectory
import platform.posix.AI_NUMERICHOST
import platform.posix.AI_NUMERICSERV
import platform.posix.SOCK_STREAM
import platform.posix.addrinfo
import platform.posix.close
import platform.posix.connect
import platform.posix.freeaddrinfo
import platform.posix.getaddrinfo
import platform.posix.recv
import platform.posix.send
import platform.posix.socket

private var nextPort = 43000 + (currentTimeMillis() % 9000).toInt()

/** Binds the next free loopback port; returns the listener and its port. */
private fun bindFreePort(): Pair<RemoteInputListener, Int> {
    repeat(50) {
        val port = nextPort++
        val listener = runCatching { IosLocalServerPort.bind("127.0.0.1", port) }.getOrNull() ?: return@repeat
        return listener to port
    }
    error("no free loopback port")
}

/** Blocking POSIX client: connects to loopback, sends [request], reads until the peer closes. */
private fun loopbackExchange(port: Int, request: ByteArray, readTimeoutMs: Int = 8000): ByteArray = memScoped {
    val hints = alloc<addrinfo>()
    hints.ai_flags = AI_NUMERICHOST or AI_NUMERICSERV
    hints.ai_socktype = SOCK_STREAM
    val resolved = allocPointerTo<addrinfo>()
    check(getaddrinfo("127.0.0.1", port.toString(), hints.ptr, resolved.ptr) == 0)
    val info = resolved.value!!.pointed
    val fd = socket(info.ai_family, SOCK_STREAM, 0)
    check(fd >= 0)
    try {
        check(connect(fd, info.ai_addr, info.ai_addrlen) == 0) { "connect failed" }
        request.usePinned { check(send(fd, it.addressOf(0), request.size.toULong(), 0) == request.size.toLong()) }
        val out = ByteSink()
        val buffer = ByteArray(4096)
        val deadline = IosProtocolPlatform.elapsedRealtimeMs() + readTimeoutMs
        while (IosProtocolPlatform.elapsedRealtimeMs() < deadline) {
            val n = buffer.usePinned { recv(fd, it.addressOf(0), buffer.size.toULong(), 0) }
            if (n <= 0L) break
            out.write(buffer, 0, n.toInt())
            if (out.toByteArray().last() == '\n'.code.toByte()) break
        }
        out.toByteArray()
    } finally {
        freeaddrinfo(resolved.value)
        close(fd)
    }
}

/** Minimal loopback HTTP/1.1 server for the NSURLSession facades; one request per connection. */
private class LoopbackHttpServer(private val handler: (path: String, headers: Map<String, String>) -> Reply) {
    class Reply(val status: Int, val headers: List<Pair<String, String>>, val pieces: List<ByteArray>, val pieceDelayMs: Long = 0)

    private val listener: RemoteInputListener
    val port: Int
    val requests = ArrayList<Map<String, String>>()
    private val lock = IosProtocolPlatform.createLock()

    init {
        val bound = bindFreePort()
        listener = bound.first
        port = bound.second
        startThread("loopback-http", true) {
            while (!listener.isClosed) {
                val connection = listener.accept() ?: continue
                startThread("loopback-http-conn", true) { serve(connection) }
            }
        }
    }

    fun url(path: String) = "http://127.0.0.1:$port$path"

    fun close() = listener.close()

    fun requestsFor(path: String): List<Map<String, String>> = lock.withLock { requests.filter { it["path"] == path } }

    private fun serve(connection: RemoteInputConnection) {
        try {
            val head = ByteSink()
            while (true) {
                val b = connection.readByte(5000)
                if (b < 0) return
                head.write(b)
                val bytes = head.toByteArray()
                val n = bytes.size
                if (n >= 4 && bytes[n - 4] == '\r'.code.toByte() && bytes[n - 3] == '\n'.code.toByte() &&
                    bytes[n - 2] == '\r'.code.toByte() && bytes[n - 1] == '\n'.code.toByte()) break
            }
            val lines = head.toByteArray().decodeToString().split("\r\n").filter { it.isNotEmpty() }
            val path = lines.first().split(' ')[1]
            val headers = lines.drop(1).associate { it.substringBefore(':').trim().lowercase() to it.substringAfter(':').trim() }
            val bodyLength = headers["content-length"]?.toIntOrNull() ?: 0
            repeat(bodyLength) { connection.readByte(5000) }
            lock.withLock { requests.add(headers + ("path" to path)) }
            val reply = handler(path, headers)
            val total = reply.pieces.sumOf { it.size }
            val response = buildString {
                append("HTTP/1.1 ${reply.status} X\r\n")
                for ((name, value) in reply.headers) append("$name: $value\r\n")
                append("Content-Length: $total\r\nConnection: close\r\n\r\n")
            }
            connection.write(response.encodeToByteArray())
            for (piece in reply.pieces) {
                connection.write(piece)
                if (reply.pieceDelayMs > 0) sleepMs(reply.pieceDelayMs)
            }
        } catch (ignored: Exception) {
        } finally {
            connection.close()
        }
    }
}

private fun waitUntil(timeoutMs: Long, condition: () -> Boolean): Boolean {
    val deadline = IosProtocolPlatform.elapsedRealtimeMs() + timeoutMs
    while (IosProtocolPlatform.elapsedRealtimeMs() < deadline) {
        if (condition()) return true
        sleepMs(20)
    }
    return condition()
}

private class RecordingSseListener : FaceclawSseListener {
    private val lock = IosProtocolPlatform.createLock()
    val lines = ArrayList<String>()
    var httpError: Pair<Int, String>? = null
    var failure: String? = null
    var completed = false
    val finished: Boolean get() = lock.withLock { completed || httpError != null || failure != null }

    override fun onLine(line: String?) { lock.withLock { lines.add(line ?: "") } }
    override fun onHttpError(code: Int, body: String?) { lock.withLock { httpError = code to (body ?: "") } }
    override fun onComplete() { lock.withLock { completed = true } }
    override fun onFailure(message: String?) { lock.withLock { failure = message ?: "" } }
}

private class RecordingDownloadListener : FaceclawModelDownloaderListener {
    private val lock = IosProtocolPlatform.createLock()
    var progress = 0
    var done: String? = null
    var error: String? = null
    val finished: Boolean get() = lock.withLock { done != null || error != null }

    override fun onProgress(bytesDownloaded: Long, totalBytes: Long) { lock.withLock { progress++ } }
    override fun onDone(path: String?) { lock.withLock { done = path } }
    override fun onError(message: String?) { lock.withLock { error = message } }
}

class IosNetworkingTest {
    private val immediate: (() -> Unit) -> Unit = { it() }

    /** Like the main queue: never runs on the caller's thread, so the session's lock is not re-entered. */
    private val hop: (() -> Unit) -> Unit = { action -> startThread("test-dispatch", true, action) }

    @Test
    fun remoteInputRoundTripsOverLoopbackAndTimesOut() {
        val (probe, port) = bindFreePort()
        probe.close()
        val remote = IosRemoteInput(hop, requestTimeoutMs = 1200)
        val ready = BlockingQueue<String>(IosProtocolPlatform)
        remote.setRequestListener { ready.put("ready") }
        assertEquals("Invalid local address.", remote.startAddress(port, "example.com"))
        assertEquals("Address is not assigned to a local interface.", remote.startAddress(port, "0.0.0.0"))
        assertEquals("", remote.startAddress(port, "127.0.0.1"))
        try {
            val replies = BlockingQueue<ByteArray>(IosProtocolPlatform)
            startThread("remote-client", true) { replies.put(loopbackExchange(port, "hello world\n".encodeToByteArray())) }
            assertEquals("ready", ready.poll(5000))
            val request = Json.parseObject(assertNotNull(remote.nextRequest()))
            assertEquals("hello world", request["body"].asString())
            assertNull(remote.nextRequest())
            remote.complete(request["id"].asLong()!!, "{\"ok\":true}")
            assertEquals("{\"ok\":true}\n", assertNotNull(replies.poll(5000)).decodeToString())

            startThread("remote-client-2", true) { replies.put(loopbackExchange(port, "later\n".encodeToByteArray())) }
            assertEquals("ready", ready.poll(5000))
            assertNotNull(remote.nextRequest())
            assertEquals(RemoteInputSession.TIMEOUT_RESPONSE + "\n", assertNotNull(replies.poll(8000)).decodeToString())

            assertEquals(64, remote.randomSecret().length)
            assertEquals(RemoteInputSession.tokenHash("abc"), remote.tokenDigest("abc"))
            val all = iosInterfaceAddresses()
            assertTrue(all.any { it.loopback && it.address == "127.0.0.1" }, all.toString())
            assertTrue(Json.parseArray(remote.interfaces()).none { it.asObject()!!["address"].asString() == "127.0.0.1" })
            assertTrue(IosLocalServerPort.isLocalUnicastAddress("::1"))
            assertFalse(IosLocalServerPort.isLocalUnicastAddress("224.0.0.1"))
        } finally {
            remote.stop()
        }
    }

    @Test
    fun sseStreamsLinesRefusesRedirectsAndReportsErrors() {
        val body = "﻿event: a\r\ndata: one\n\ndata: two\r\n".encodeToByteArray()
        val server = LoopbackHttpServer { path, _ ->
            when (path) {
                "/sse" -> LoopbackHttpServer.Reply(200, listOf("Content-Type" to "text/event-stream"),
                    listOf(body.copyOfRange(0, 13), body.copyOfRange(13, body.size)), pieceDelayMs = 50)
                "/limited" -> LoopbackHttpServer.Reply(429, listOf("Content-Type" to "text/plain"), listOf("slow down".encodeToByteArray()))
                else -> LoopbackHttpServer.Reply(302, listOf("Location" to "http://127.0.0.1:1/never"), listOf(ByteArray(0)))
            }
        }
        try {
            val ok = RecordingSseListener()
            IosSseRequest(server.url("/sse"), "{\"q\":1}", "{\"X-Test\":\"yes\"}", ok, immediate, false)
            assertTrue(waitUntil(10_000) { ok.finished }, "sse did not finish: ${ok.failure}")
            assertEquals(listOf("event: a", "data: one", "", "data: two"), ok.lines)
            assertTrue(ok.completed)
            val request = server.requestsFor("/sse").single()
            assertEquals("yes", request["x-test"])
            assertEquals("text/event-stream", request["accept"])
            assertTrue(request["user-agent"]!!.isNotEmpty())

            val limited = RecordingSseListener()
            IosSseRequest(server.url("/limited"), "{}", null, limited, immediate, false)
            assertTrue(waitUntil(10_000) { limited.finished })
            assertEquals(429 to "slow down", limited.httpError)

            val redirected = RecordingSseListener()
            IosSseRequest(server.url("/moved"), "{}", "{}", redirected, immediate, false)
            assertTrue(waitUntil(10_000) { redirected.finished })
            assertEquals(302, redirected.httpError?.first)
            assertTrue(server.requestsFor("/never").isEmpty())
        } finally {
            server.close()
        }
    }

    @Test
    fun downloaderFetchesAndResumesWithRange() {
        val payload = ByteArray(200_000) { (it * 31 + it / 977).toByte() }
        val sha = sha256Hex(payload)
        val server = LoopbackHttpServer { _, headers ->
            val range = headers["range"]
            if (range != null && range.startsWith("bytes=")) {
                val from = range.removePrefix("bytes=").removeSuffix("-").toInt()
                LoopbackHttpServer.Reply(206, listOf("Content-Range" to "bytes $from-${payload.size - 1}/${payload.size}"),
                    listOf(payload.copyOfRange(from, payload.size)))
            } else LoopbackHttpServer.Reply(200, emptyList(), listOf(payload.copyOfRange(0, 70_000), payload.copyOfRange(70_000, payload.size)), pieceDelayMs = 30)
        }
        val dir = NSTemporaryDirectory().trimEnd('/') + "/faceclaw-dl-" + currentTimeMillis()
        val dest = "$dir/model.bin"
        try {
            val first = RecordingDownloadListener()
            IosModelDownloader(server.url("/model.bin"), dest, sha, payload.size.toLong(), first, immediate).start()
            assertTrue(waitUntil(20_000) { first.finished }, "download did not finish: ${first.error}")
            assertEquals(dest, first.done, first.error)
            assertContentEquals(payload, readFileData(dest))
            assertTrue(first.progress >= 1)
            assertNull(server.requestsFor("/model.bin").single()["range"])

            deleteFile(dest)
            writeFileData("$dest.part", payload.copyOfRange(0, 50_000))
            val second = RecordingDownloadListener()
            IosModelDownloader(server.url("/model.bin"), dest, sha, payload.size.toLong(), second, immediate).start()
            assertTrue(waitUntil(20_000) { second.finished }, "resume did not finish: ${second.error}")
            assertEquals(dest, second.done, second.error)
            assertContentEquals(payload, readFileData(dest))
            assertEquals("bytes=50000-", server.requestsFor("/model.bin").last()["range"])
            assertEquals(-1L, fileLength("$dest.part"))
        } finally {
            server.close()
            deleteFile(dest)
            deleteFile("$dest.part")
        }
    }

    @Test
    fun frameTimingsExportsToAFile() {
        val dir = NSTemporaryDirectory().trimEnd('/') + "/faceclaw-ft-" + currentTimeMillis()
        platform.Foundation.NSFileManager.defaultManager.createDirectoryAtPath(dir, true, null, null)
        val timings = IosFrameTimings(IosProtocolPlatform)
        assertNull(timings.exportNow())
        timings.startExport(dir)
        val frame = timings.startFrame("test:frame")
        timings.spanStart(frame, "work")
        timings.log(frame, "hello")
        timings.spanEnd(frame, "work")
        timings.finishFrame(frame, "sent")
        val path = assertNotNull(timings.exportNow())
        assertEquals("$dir/${IosFrameTimings.EXPORT_FILE_NAME}", path)
        val text = readFileData(path).decodeToString()
        assertTrue(text.contains("test:frame"), text)
        assertTrue(text.contains("hello"), text)
        assertNull(timings.exportNow())
        assertTrue(timings.statsSummary().isNotEmpty())
        deleteFile(path)
    }
}
