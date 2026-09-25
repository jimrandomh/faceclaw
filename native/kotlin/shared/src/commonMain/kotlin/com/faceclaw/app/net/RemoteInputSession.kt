package com.faceclaw.app

import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic

/** One accepted client connection of the local input port. */
interface RemoteInputConnection {
    /** Reads one byte, blocking at most [timeoutMs]; returns -1 on end of stream, timeout or error. */
    fun readByte(timeoutMs: Long): Int

    fun write(bytes: ByteArray)

    fun close()
}

/** A bound, listening socket. */
interface RemoteInputListener {
    /** Blocks for the next client; returns null when the listener is closed or accept fails. */
    fun accept(): RemoteInputConnection?

    val isClosed: Boolean

    fun close()
}

/** OS socket access for [RemoteInputSession]; a POSIX actual is the iOS counterpart. */
interface LocalServerPort {
    /** True when [address] is a unicast address assigned to a local interface (not any/multicast). */
    fun isLocalUnicastAddress(address: String): Boolean

    /** Binds and listens on [address]:[port]; throws when the port cannot be opened. */
    fun bind(address: String, port: Int): RemoteInputListener
}

interface RandomSource {
    fun nextBytes(count: Int): ByteArray
}

/** One network address of a local interface, as enumerated by the platform. */
data class InterfaceAddress(
    val interfaceName: String,
    val address: String,
    val up: Boolean,
    val pointToPoint: Boolean,
    val loopback: Boolean,
    val linkLocal: Boolean,
    val anyLocal: Boolean,
)

/**
 * Explicit-address, bounded local input port shared by Android (java.net) and iOS (POSIX).
 * Exactly one request is in flight: a client sends one newline-terminated UTF-8 frame of at most
 * 64 KiB, the session publishes it as a pending JSON request, notifies the app through
 * [dispatch] (which must run the callback on the app's UI thread, outside the lock), and blocks
 * the serving thread until [complete] supplies the reply or the request deadline passes.
 */
class RemoteInputSession(
    private val port: LocalServerPort,
    private val random: RandomSource,
    private val dispatch: (() -> Unit) -> Unit,
    platform: ProtocolPlatform = protocolPlatform(),
    private val wallClock: () -> Long = ::currentTimeMillis,
    private val requestTimeoutMs: Long = REQUEST_TIMEOUT_MS,
    private val readTimeoutMs: Long = READ_TIMEOUT_MS,
) {
    private val condition = platform.createCondition()
    private var server: RemoteInputListener? = null
    private var client: RemoteInputConnection? = null
    private var pending: String? = null
    private var reply: String? = null
    private var nextId = 0L
    private var requestId = 0L
    private var deadline = 0L
    private var requestListener: (() -> Unit)? = null

    fun setRequestListener(listener: (() -> Unit)?) {
        condition.withLock { requestListener = listener }
    }

    /** Returns "" on success or a user-facing error. Never resolves hostnames or binds a wildcard. */
    fun start(port: Int, address: String): String {
        condition.withLock {
            if (server != null) return ""
            if (!isNumericLocalAddress(address)) return "Invalid local address."
            if (!this.port.isLocalUnicastAddress(address)) return "Address is not assigned to a local interface."
            val listener = try {
                this.port.bind(address, port)
            } catch (e: Exception) {
                return "Could not open local input port $port."
            }
            server = listener
            startThread("FaceclawInput", true) { serve(listener) }
            return ""
        }
    }

    fun stop() {
        condition.withLock {
            try { server?.close() } catch (ignored: Exception) {}
            try { client?.close() } catch (ignored: Exception) {}
            server = null
            client = null
            pending = null
            requestId = 0
            reply = null
            condition.signalAll()
        }
    }

    /** The pending request JSON (id, expiresAt, body), consumed once; null when none or expired. */
    fun nextRequest(): String? {
        condition.withLock {
            if (wallClock() >= deadline) {
                pending = null
                return null
            }
            val result = pending
            pending = null
            return result
        }
    }

    fun complete(id: Long, value: String?) {
        condition.withLock {
            if (id == requestId && wallClock() < deadline) {
                reply = value
                condition.signalAll()
            }
        }
    }

    fun randomSecret(): String = BinaryEncoding.bytesToHex(random.nextBytes(32))

    private fun notifyRequestReady(id: Long) {
        // Called WITHOUT the condition held (ProtocolCondition is not reentrant on iOS, and a
        // dispatcher may run the closure inline); the closure re-checks the request under the lock.
        dispatch {
            val callback = condition.withLock {
                if (requestId != id || pending == null || wallClock() >= deadline) null else requestListener
            }
            callback?.invoke()
        }
    }

    private fun serve(listener: RemoteInputListener) {
        while (!listener.isClosed) {
            val connection = listener.accept() ?: continue
            try {
                condition.withLock {
                    if (server !== listener) return
                    client = connection
                }
                val text = readFrame(connection) ?: continue
                val id = condition.withLock {
                    if (server !== listener) return
                    requestId = ++nextId
                    deadline = wallClock() + requestTimeoutMs
                    reply = null
                    pending = Json.write(linkedMapOf("id" to requestId, "expiresAt" to deadline, "body" to text))
                    requestId
                }
                notifyRequestReady(id)
                val response: String = condition.withLock {
                    if (server !== listener) return
                    while (reply == null && requestId == id && server === listener && wallClock() < deadline) {
                        condition.awaitMs(maxOf(1L, deadline - wallClock()))
                    }
                    val result = reply ?: TIMEOUT_RESPONSE
                    if (server === listener) {
                        pending = null
                        reply = null
                        requestId = 0
                    }
                    result
                }
                connection.write((response + "\n").encodeToByteArray())
            } catch (ignored: Exception) {
                // Never log request bodies: they contain credentials and possibly private text.
            } finally {
                try { connection.close() } catch (ignored: Exception) {}
                condition.withLock { if (server === listener) client = null }
            }
        }
    }

    /** One newline-terminated frame, or null when the client hung up, stalled or overflowed. */
    private fun readFrame(connection: RemoteInputConnection): String? {
        val readDeadline = wallClock() + readTimeoutMs
        val body = ByteSink()
        while (true) {
            val remaining = readDeadline - wallClock()
            if (remaining <= 0) return null
            val b = connection.readByte(remaining)
            if (b == -1) return null
            if (b == '\n'.code) break
            if (body.size() >= MAX_FRAME_BYTES) return null
            body.write(b)
        }
        return try {
            body.toByteArray().decodeToString(throwOnInvalidSequence = true)
        } catch (e: Exception) {
            null
        }
    }

    companion object {
        const val MAX_FRAME_BYTES = 65536
        const val REQUEST_TIMEOUT_MS = 5000L
        const val READ_TIMEOUT_MS = 5000L

        @JvmField
        val TIMEOUT_RESPONSE = "{\"ok\":false,\"error\":\"timeout\",\"message\":\"Faceclaw did not respond in time.\"}"

        private val numericAddress = Regex("[0-9.]+|[0-9a-fA-F]*:[0-9a-fA-F:.]*(%[a-zA-Z0-9_.-]+)?")

        /** Numeric IPv4/IPv6 literals only (optionally zone-scoped); hostnames are rejected. */
        @JvmStatic fun isNumericLocalAddress(address: String): Boolean = numericAddress.matches(address)

        /** Addresses a remote client could reach: up interfaces, minus loopback, link-local and wildcard. */
        @JvmStatic
        fun reachableAddresses(all: List<InterfaceAddress>): List<InterfaceAddress> =
            all.filter { it.up && !it.loopback && !it.linkLocal && !it.anyLocal }

        /** JSON array of {name, address, pointToPoint} consumed by app/remote/listeners.ts. */
        @JvmStatic
        fun interfacesJson(all: List<InterfaceAddress>): String =
            Json.write(reachableAddresses(all).map {
                linkedMapOf("name" to it.interfaceName, "address" to it.address, "pointToPoint" to it.pointToPoint)
            })

        /** Lowercase hex SHA-256 of the UTF-8 token; the stored form of remote-input tokens. */
        @JvmStatic fun tokenHash(value: String): String = sha256Hex(value.encodeToByteArray())
    }
}
