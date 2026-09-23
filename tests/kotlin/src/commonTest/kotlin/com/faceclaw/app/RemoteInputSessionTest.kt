package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private class FakeConnection(input: String, private val bytesOverride: ByteArray? = null) : RemoteInputConnection {
    private val bytes = bytesOverride ?: input.encodeToByteArray()
    private var index = 0
    private val written = ByteSink()
    var closed = false
    val output: String get() = written.toByteArray().decodeToString()

    override fun readByte(timeoutMs: Long): Int = if (index < bytes.size) bytes[index++].toInt() and 255 else -1

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
