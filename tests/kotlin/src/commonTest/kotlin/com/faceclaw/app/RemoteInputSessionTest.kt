package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private class FakeConnection(
    input: String,
    private val bytesOverride: ByteArray? = null,
    private val beforeRead: (Int, Long) -> Unit = { _, _ -> },
) : RemoteInputConnection {
    private val bytes = bytesOverride ?: input.encodeToByteArray()
    private var index = 0
    private val written = ByteSink()
    var closed = false
    val output: String get() = written.toByteArray().decodeToString()

    override fun readByte(timeoutMs: Long): Int {
        beforeRead(index, timeoutMs)
        return if (index < bytes.size) bytes[index++].toInt() and 255 else -1
    }

    override fun write(bytes: ByteArray) = written.write(bytes)

    override fun close() { closed = true }
}

private class FakePort(platform: ProtocolPlatform) : LocalServerPort {
    val connections = BlockingQueue<FakeConnection>(platform)
    var localAddresses = setOf("127.0.0.1", "192.168.1.5")
    var bindFails = false
    var listener: FakeListener? = null

    inner class FakeListener : RemoteInputListener {
        override var isClosed = false
        override fun accept(): RemoteInputConnection? {
            while (!isClosed) {
                val next = connections.poll(20)
                if (next != null) return next
            }
            return null
        }
        override fun close() { isClosed = true }
    }

    override fun isLocalUnicastAddress(address: String): Boolean = address in localAddresses

    override fun bind(address: String, port: Int): RemoteInputListener {
        if (bindFails) throw IllegalStateException("in use")
        return FakeListener().also { listener = it }
    }
}

private fun waitFor(timeoutMs: Long = 3000, condition: () -> Boolean): Boolean {
    val platform = testPlatform()
    val deadline = platform.elapsedRealtimeMs() + timeoutMs
    while (platform.elapsedRealtimeMs() < deadline) {
        if (condition()) return true
        sleepMs(5)
    }
    return condition()
}

class RemoteInputSessionTest {
    private val platform = testPlatform()
    private val random = object : RandomSource { override fun nextBytes(count: Int) = ByteArray(count) { it.toByte() } }
    private fun dispatchOnThread(action: () -> Unit) = startThread("remote-input-dispatch", true, action)

    private fun session(port: FakePort, requestTimeoutMs: Long = 5000, readTimeoutMs: Long = 5000) =
        RemoteInputSession(port, random, ::dispatchOnThread, platform, requestTimeoutMs = requestTimeoutMs, readTimeoutMs = readTimeoutMs)

    private fun httpRequest(body: String = "{}", extraHeaders: String = ""): String =
        "POST /v1/request HTTP/1.1\r\nHost: 127.0.0.1:8791\r\n" +
            "Content-Type: application/json\r\nContent-Length: ${body.encodeToByteArray().size}\r\n" +
            extraHeaders + "\r\n" + body

    private fun httpBody(connection: FakeConnection, status: Int): String {
        val response = connection.output
        assertTrue(response.startsWith("HTTP/1.1 $status "), response)
        val split = response.indexOf("\r\n\r\n")
        assertTrue(split >= 0, response)
        val headers = response.substring(0, split).split("\r\n")
        val body = response.substring(split + 4)
        assertTrue("Content-Type: application/json; charset=utf-8" in headers)
        assertTrue("Connection: close" in headers)
        assertTrue("Cache-Control: no-store" in headers)
        assertTrue("Content-Length: ${body.encodeToByteArray().size}" in headers)
        assertFalse(response.contains("Access-Control-", ignoreCase = true))
        return body
    }

    @Test
    fun httpUsesTheSameDispatcherAndPreservesUtf8AndMultilineJson() {
        val port = FakePort(platform)
        val session = session(port)
        val requests = BlockingQueue<Map<String, Any?>>(platform)
        session.setRequestListener {
            val request = Json.parseObject(session.nextRequest()!!)
            requests.put(request)
            session.complete(request["id"].asLong()!!, "{\"ok\":true,\"name\":\"导航\"}")
        }
        assertEquals("", session.start(8791, "127.0.0.1"))
        try {
            val body = "{\n  \"token\": \"secret\",\n  \"text\": \"导航\"\n}"
            val http = FakeConnection(httpRequest(body).replace("application/json", "Application/JSON; charset=\"UTF-8\""))
            port.connections.put(http)
            assertTrue(waitFor { http.closed })
            assertEquals("{\"ok\":true,\"name\":\"导航\"}", httpBody(http, 200))
            assertEquals(body, requests.poll(1000)!!["body"].asString())

            // HTTP has no effect on the existing one-line TCP transport on the same listener.
            val tcp = FakeConnection("{\"op\":\"ping\",\"token\":\"secret\"}\r\n")
            port.connections.put(tcp)
            assertTrue(waitFor { tcp.closed })
            assertEquals("{\"ok\":true,\"name\":\"导航\"}\n", tcp.output)
            assertEquals("{\"op\":\"ping\",\"token\":\"secret\"}\r", requests.poll(1000)!!["body"].asString())
        } finally { session.stop() }
    }

    @Test
    fun httpRejectsBrowserRequestsAndAmbiguousOrUnsupportedFramingBeforeDispatch() {
        val port = FakePort(platform)
        val session = session(port)
        var dispatched = 0
        session.setRequestListener { dispatched++ }
        assertEquals("", session.start(8791, "127.0.0.1"))
        val cases = listOf(
            Triple(httpRequest(extraHeaders = "Origin: null\r\n"), 403, "browser_not_allowed"),
            Triple(httpRequest(extraHeaders = "Origin: https://example.com\r\n"), 403, "browser_not_allowed"),
            Triple(httpRequest(extraHeaders = "Sec-Fetch-Site: same-origin\r\n"), 403, "browser_not_allowed"),
            Triple(httpRequest().replace("POST", "OPTIONS"), 405, "method_not_allowed"),
            Triple(httpRequest().replace("POST", "GET"), 405, "method_not_allowed"),
            Triple(httpRequest().replace("POST", "post"), 405, "method_not_allowed"),
            Triple(httpRequest().replace("/v1/request", "/v1/request?token=secret"), 404, "not_found"),
            Triple(httpRequest().replace("HTTP/1.1", "HTTP/2.0"), 505, "unsupported_version"),
            Triple(httpRequest(extraHeaders = "content-length: 2\r\n"), 400, "duplicate_header"),
            Triple(httpRequest(extraHeaders = "HOST: localhost\r\n"), 400, "duplicate_header"),
            Triple(httpRequest(extraHeaders = "Transfer-Encoding: chunked\r\n"), 400, "unsupported_framing"),
            Triple(httpRequest(extraHeaders = "Transfer-Encoding: identity\r\n"), 400, "unsupported_framing"),
            Triple(httpRequest(extraHeaders = "Upgrade: websocket\r\n"), 400, "unsupported_framing"),
            Triple(httpRequest(extraHeaders = "Trailer: Content-Length\r\n"), 400, "unsupported_framing"),
            Triple(httpRequest(extraHeaders = "Expect: 100-continue\r\n"), 417, "expectation_failed"),
            Triple(httpRequest(extraHeaders = " Folded: value\r\n"), 400, "invalid_headers"),
            Triple(httpRequest(extraHeaders = "Bad Name: value\r\n"), 400, "invalid_headers"),
            Triple(httpRequest().replace("\r\n", "\n"), 400, "invalid_request"),
            Triple(httpRequest().replace("Host: 127.0.0.1:8791\r\n", ""), 400, "missing_host"),
            Triple(httpRequest().replace("application/json", "text/plain"), 415, "unsupported_media_type"),
            Triple(httpRequest(extraHeaders = "Content-Encoding: gzip\r\n"), 415, "unsupported_media_type"),
            Triple(httpRequest().replace("Content-Length: 2\r\n", ""), 411, "length_required"),
            Triple(httpRequest().replace("Content-Length: 2", "Content-Length: -2"), 400, "invalid_length"),
            Triple(httpRequest().replace("Content-Length: 2", "Content-Length: 2, 2"), 400, "invalid_length"),
            Triple(httpRequest(""), 400, "empty_body"),
            Triple(httpRequest().dropLast(1), 400, "incomplete_request"),
        )
        try {
            for ((request, status, error) in cases) {
                val connection = FakeConnection(request)
                port.connections.put(connection)
                assertTrue(waitFor { connection.closed }, "Request did not close: $error")
                val response = httpBody(connection, status)
                assertEquals(error, Json.parseObject(response)["error"].asString())
                assertFalse(response.contains("secret"), "Errors must not echo credentials")
            }
            assertEquals(0, dispatched)
            assertNull(session.nextRequest())
        } finally { session.stop() }
    }

    @Test
    fun httpBoundsHeadersBodiesAndUtf8BeforeDispatch() {
        val port = FakePort(platform)
        val session = session(port)
        var dispatched = 0
        session.setRequestListener { dispatched++ }
        assertEquals("", session.start(8791, "127.0.0.1"))
        val invalidUtf8 = httpRequest().encodeToByteArray().also { it[it.size - 1] = 0xff.toByte() }
        val cases = listOf(
            FakeConnection(httpRequest(extraHeaders = "X-Large: ${"a".repeat(RemoteInputSession.MAX_HTTP_HEADER_BYTES)}\r\n")) to 431,
            FakeConnection("POST /${"a".repeat(RemoteInputSession.MAX_HTTP_HEADER_BYTES)} HTTP/1.1\r\n") to 431,
            FakeConnection(httpRequest(extraHeaders = (1..RemoteInputSession.MAX_HTTP_HEADERS).joinToString("") { "X-$it: a\r\n" })) to 431,
            FakeConnection(httpRequest().replace("Content-Length: 2", "Content-Length: 65537")) to 413,
            FakeConnection(httpRequest().replace("Content-Length: 2", "Content-Length: 999999999999999999999999")) to 413,
            FakeConnection("", invalidUtf8) to 400,
        )
        try {
            for ((connection, status) in cases) {
                port.connections.put(connection)
                assertTrue(waitFor { connection.closed })
                httpBody(connection, status)
            }
            assertEquals(0, dispatched)
        } finally { session.stop() }
    }

    @Test
    fun httpAcceptsBodyLimitAndClosesWithoutDispatchingPipelinedRequests() {
        val port = FakePort(platform)
        val session = session(port)
        val received = BlockingQueue<String>(platform)
        session.setRequestListener {
            val request = Json.parseObject(session.nextRequest()!!)
            received.put(request["body"].asString()!!)
            session.complete(request["id"].asLong()!!, "{\"ok\":false,\"error\":\"unauthorized\"}")
        }
        assertEquals("", session.start(8791, "127.0.0.1"))
        try {
            val body = "{\"text\":\"${"a".repeat(RemoteInputSession.MAX_FRAME_BYTES - 11)}\"}"
            assertEquals(RemoteInputSession.MAX_FRAME_BYTES, body.encodeToByteArray().size)
            val request = httpRequest(body).replace("HTTP/1.1", "HTTP/1.0") + httpRequest()
            val connection = FakeConnection(request)
            port.connections.put(connection)
            assertTrue(waitFor { connection.closed })
            assertEquals("{\"ok\":false,\"error\":\"unauthorized\"}", httpBody(connection, 200))
            assertEquals(body, received.poll(1000))
            assertNull(received.poll(100), "One connection must dispatch only one request")
        } finally { session.stop() }
    }

    @Test
    fun httpReadDeadlineCoversHeadersAndBodyAndServingContinuesAfterTimeout() {
        val port = FakePort(platform)
        val session = session(port, readTimeoutMs = 80)
        var dispatched = 0
        session.setRequestListener { dispatched++ }
        assertEquals("", session.start(8791, "127.0.0.1"))
        try {
            val request = httpRequest()
            for (stallIndex in listOf(8, request.indexOf("Host:"), request.length - 1)) {
                val connection = FakeConnection(request, beforeRead = { index, timeout ->
                    if (index == stallIndex) sleepMs(timeout + 10)
                })
                port.connections.put(connection)
                assertTrue(waitFor { connection.closed })
                assertEquals("read_timeout", Json.parseObject(httpBody(connection, 408))["error"].asString())
            }
            assertEquals(0, dispatched)
        } finally { session.stop() }
    }

    @Test
    fun httpDispatcherDeadlineAndStopUseTheExistingSessionLifecycle() {
        val port = FakePort(platform)
        val expiringSession = session(port, requestTimeoutMs = 100)
        assertEquals("", expiringSession.start(8791, "127.0.0.1"))
        try {
            val timeout = FakeConnection(httpRequest())
            port.connections.put(timeout)
            assertTrue(waitFor { timeout.closed })
            assertEquals(RemoteInputSession.TIMEOUT_RESPONSE, httpBody(timeout, 504))
            assertNull(expiringSession.nextRequest())
        } finally { expiringSession.stop() }

        val pendingPort = FakePort(platform)
        val session = session(pendingPort)
        assertEquals("", session.start(8791, "127.0.0.1"))
        try {
            var dispatched = 0
            session.setRequestListener { dispatched++ }
            val pending = FakeConnection(httpRequest())
            pendingPort.connections.put(pending)
            assertTrue(waitFor { dispatched == 1 })
            session.stop()
            assertTrue(waitFor { pending.closed })
            assertEquals("", pending.output)
            assertNull(session.nextRequest())
        } finally { session.stop() }
    }

    @Test
    fun startValidatesAddressesAndBindFailures() {
        val port = FakePort(platform)
        val session = session(port)
        assertEquals("Invalid local address.", session.start(7000, "localhost"))
        assertEquals("Address is not assigned to a local interface.", session.start(7000, "10.0.0.9"))
        port.bindFails = true
        assertEquals("Could not open local input port 7000.", session.start(7000, "127.0.0.1"))
        port.bindFails = false
        assertEquals("", session.start(7000, "127.0.0.1"))
        assertEquals("", session.start(7000, "127.0.0.1"), "second start is a no-op")
        session.stop()
        assertTrue(waitFor { port.listener!!.isClosed })
        assertTrue(RemoteInputSession.isNumericLocalAddress("fe80::1%en0"))
        assertFalse(RemoteInputSession.isNumericLocalAddress("example.com"))
    }

    @Test
    fun requestIsPublishedAnsweredAndWrittenBack() {
        val port = FakePort(platform)
        val session = session(port)
        var notified = 0
        session.setRequestListener { notified++ }
        assertEquals("", session.start(7000, "127.0.0.1"))
        val connection = FakeConnection("{\"token\":\"t\",\"text\":\"hi\"}\n")
        port.connections.put(connection)
        assertTrue(waitFor { notified == 1 })
        val pending = Json.parseObject(session.nextRequest()!!)
        assertEquals(1L, pending["id"].asLong())
        assertEquals("{\"token\":\"t\",\"text\":\"hi\"}", pending["body"].asString())
        assertTrue(pending["expiresAt"].asLong()!! > currentTimeMillis())
        assertNull(session.nextRequest(), "consumed once")
        session.complete(99L, "{\"ok\":false}")
        assertFalse(waitFor(100) { connection.output.isNotEmpty() }, "wrong id is ignored")
        session.complete(1L, "{\"ok\":true}")
        assertTrue(waitFor { connection.output == "{\"ok\":true}\n" })
        assertTrue(waitFor { connection.closed })
        session.stop()
    }

    @Test
    fun timeoutRepliesWithTheTimeoutResponse() {
        val port = FakePort(platform)
        val session = session(port, requestTimeoutMs = 150)
        assertEquals("", session.start(7000, "127.0.0.1"))
        val connection = FakeConnection("slow\n")
        port.connections.put(connection)
        assertTrue(waitFor { connection.output == RemoteInputSession.TIMEOUT_RESPONSE + "\n" })
        assertNull(session.nextRequest(), "expired request is dropped")
        session.stop()
    }

    @Test
    fun oversizedAndIncompleteFramesGetNoReply() {
        val port = FakePort(platform)
        val session = session(port)
        var notified = 0
        session.setRequestListener { notified++ }
        assertEquals("", session.start(7000, "127.0.0.1"))
        val huge = FakeConnection("", ByteArray(RemoteInputSession.MAX_FRAME_BYTES + 2) { 'a'.code.toByte() }.also { it[it.size - 1] = '\n'.code.toByte() })
        port.connections.put(huge)
        assertTrue(waitFor { huge.closed })
        assertEquals("", huge.output)
        val partial = FakeConnection("no newline")
        port.connections.put(partial)
        assertTrue(waitFor { partial.closed })
        assertEquals("", partial.output)
        val invalidUtf8 = FakeConnection("", byteArrayOf(0xff.toByte(), 0xfe.toByte(), '\n'.code.toByte()))
        port.connections.put(invalidUtf8)
        assertTrue(waitFor { invalidUtf8.closed })
        assertEquals("", invalidUtf8.output)
        assertEquals(0, notified)
        assertNull(session.nextRequest())
        session.stop()
    }

    @Test
    fun stopWhilePendingReleasesTheServingThread() {
        val port = FakePort(platform)
        val session = session(port)
        var notified = 0
        session.setRequestListener { notified++ }
        assertEquals("", session.start(7000, "127.0.0.1"))
        val connection = FakeConnection("pending\n")
        port.connections.put(connection)
        assertTrue(waitFor { notified == 1 })
        session.stop()
        assertTrue(waitFor { connection.closed })
        assertNull(session.nextRequest())
        assertEquals("", session.start(7001, "127.0.0.1"), "restart after stop")
        session.stop()
    }

    @Test
    fun helpersFilterInterfacesAndHashTokens() {
        val all = listOf(
            InterfaceAddress("lo0", "127.0.0.1", up = true, pointToPoint = false, loopback = true, linkLocal = false, anyLocal = false),
            InterfaceAddress("wlan0", "192.168.1.5", up = true, pointToPoint = false, loopback = false, linkLocal = false, anyLocal = false),
            InterfaceAddress("wlan0", "fe80::1%wlan0", up = true, pointToPoint = false, loopback = false, linkLocal = true, anyLocal = false),
            InterfaceAddress("tun0", "100.64.0.2", up = true, pointToPoint = true, loopback = false, linkLocal = false, anyLocal = false),
            InterfaceAddress("eth0", "10.0.0.2", up = false, pointToPoint = false, loopback = false, linkLocal = false, anyLocal = false),
            InterfaceAddress("any", "0.0.0.0", up = true, pointToPoint = false, loopback = false, linkLocal = false, anyLocal = true),
        )
        assertEquals(
            "[{\"name\":\"wlan0\",\"address\":\"192.168.1.5\",\"pointToPoint\":false},{\"name\":\"tun0\",\"address\":\"100.64.0.2\",\"pointToPoint\":true}]",
            RemoteInputSession.interfacesJson(all),
        )
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", RemoteInputSession.tokenHash("abc"))
        val session = session(FakePort(platform))
        assertEquals("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", session.randomSecret())
    }
}
