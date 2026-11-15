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
 * Exactly one request is in flight: a client sends a newline-terminated UTF-8 frame or an HTTP
 * POST /v1/request with a bounded JSON body. Both publish the same request and notify the app through
 * [dispatch] (which must run the callback on the app's UI thread, outside the lock). The session blocks
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
    private val readClock = platform::elapsedRealtimeMs
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
                val request = readRequest(connection) ?: continue
                val id = condition.withLock {
                    if (server !== listener) return
                    requestId = ++nextId
                    deadline = wallClock() + requestTimeoutMs
                    reply = null
                    pending = Json.write(linkedMapOf("id" to requestId, "expiresAt" to deadline, "body" to request.body))
                    requestId
                }
                notifyRequestReady(id)
                val response = condition.withLock {
                    if (server !== listener) return
                    while (reply == null && requestId == id && server === listener && wallClock() < deadline) {
                        condition.awaitMs(maxOf(1L, deadline - wallClock()))
                    }
                    if (server !== listener || requestId != id) return
                    val result = WireResponse(reply ?: TIMEOUT_RESPONSE, reply == null)
                    pending = null
                    reply = null
                    requestId = 0
                    result
                }
                if (request.http) {
                    writeHttp(connection, if (response.timedOut) 504 else 200, response.body)
                } else {
                    connection.write((response.body + "\n").encodeToByteArray())
                }
            } catch (error: HttpError) {
                try { writeHttp(connection, error.status, error.body) } catch (ignored: Exception) {}
            } catch (ignored: Exception) {
                // Never log request bodies: they contain credentials and possibly private text.
            } finally {
                try { connection.close() } catch (ignored: Exception) {}
                condition.withLock { if (server === listener) client = null }
            }
        }
    }

    private data class WireRequest(val body: String, val http: Boolean)
    private data class WireResponse(val body: String, val timedOut: Boolean)

    private class HttpError(val status: Int, code: String, message: String) : Exception() {
        val body = Json.write(linkedMapOf("ok" to false, "error" to code, "message" to message))
    }

    /** Recognize an HTTP request target; existing JSON-line clients keep their exact framing. */
    private fun readRequest(connection: RemoteInputConnection): WireRequest? {
        val readDeadline = readClock() + readTimeoutMs
        val first = ByteSink()
        var http = false
        while (true) {
            val remaining = readDeadline - readClock()
            if (remaining <= 0) {
                if (http) throw incompleteHttp(readDeadline)
                return null
            }
            val b = connection.readByte(remaining)
            if (readClock() >= readDeadline) {
                if (http) throw incompleteHttp(readDeadline)
                return null
            }
            if (b == -1) {
                if (http) throw incompleteHttp(readDeadline)
                return null
            }
            // An HTTP origin-form target starts with "/" (or "*" for OPTIONS). Requiring
            // that target avoids treating an incomplete legacy frame such as "no newline"
            // as HTTP. Detect before LF so the smaller header limit bounds the request line.
            if (!http && (b == '/'.code || b == '*'.code) && first.size() in 2..33) {
                val prefix = first.toByteArray()
                http = prefix.last() == ' '.code.toByte() &&
                    prefix.dropLast(1).all { isHttpToken(it.toInt() and 255) }
            }
            if (b == '\n'.code) break
            if (first.size() >= if (http) MAX_HTTP_HEADER_BYTES - 1 else MAX_FRAME_BYTES) {
                if (http) throw HttpError(431, "headers_too_large", "Request headers are too large.")
                return null
            }
            first.write(b)
        }
        val bytes = first.toByteArray()
        if (!http) {
            return try { WireRequest(bytes.decodeToString(throwOnInvalidSequence = true), false) }
            catch (ignored: Exception) { null }
        }
        if (bytes.isEmpty() || bytes.last() != '\r'.code.toByte() ||
            bytes.dropLast(1).any { it.toInt() !in 32..126 }) {
            throw HttpError(400, "invalid_request", "Use an HTTP request line ending in CRLF.")
        }
        return readHttp(connection, bytes.decodeToString().dropLast(1), bytes.size + 1, readDeadline)
    }

    private fun incompleteHttp(readDeadline: Long): HttpError =
        if (readClock() >= readDeadline) HttpError(408, "read_timeout", "Request was not received in time.")
        else HttpError(400, "incomplete_request", "Request ended before its declared length.")

    private fun readHttp(connection: RemoteInputConnection, requestLine: String, firstBytes: Int, readDeadline: Long): WireRequest {
        val parts = requestLine.split(' ')
        if (parts.size != 3 || parts[0].isEmpty() || !parts[0].all { isHttpToken(it.code) }) {
            throw HttpError(400, "invalid_request", "Invalid HTTP request line.")
        }
        if (parts[2] != "HTTP/1.1" && parts[2] != "HTTP/1.0") {
            throw HttpError(505, "unsupported_version", "Use HTTP/1.1 or HTTP/1.0.")
        }
        if (parts[0] != "POST") throw HttpError(405, "method_not_allowed", "Use POST /v1/request.")
        if (parts[1] != "/v1/request") throw HttpError(404, "not_found", "Unknown input endpoint.")

        var headerBytes = firstBytes
        fun nextByte(): Int {
            val remaining = readDeadline - readClock()
            if (remaining <= 0) throw incompleteHttp(readDeadline)
            val value = connection.readByte(remaining)
            if (readClock() >= readDeadline) throw incompleteHttp(readDeadline)
            if (value == -1) throw incompleteHttp(readDeadline)
            return value
        }
        fun headerByte(): Int {
            if (++headerBytes > MAX_HTTP_HEADER_BYTES) {
                throw HttpError(431, "headers_too_large", "Request headers are too large.")
            }
            return nextByte()
        }
        fun headerLine(): String = buildString {
            while (true) {
                val value = headerByte()
                if (value == '\r'.code) {
                    if (headerByte() != '\n'.code) throw HttpError(400, "invalid_headers", "Headers must end in CRLF.")
                    break
                }
                if (value != '\t'.code && value !in 32..126) {
                    throw HttpError(400, "invalid_headers", "Invalid header character.")
                }
                append(value.toChar())
            }
        }
        val headers = mutableMapOf<String, String>()
        while (true) {
            val line = headerLine()
            if (line.isEmpty()) break
            if (headers.size >= MAX_HTTP_HEADERS) throw HttpError(431, "headers_too_large", "Too many request headers.")
            val colon = line.indexOf(':')
            if (colon <= 0 || !line.take(colon).all { isHttpToken(it.code) }) {
                throw HttpError(400, "invalid_headers", "Invalid header name or folded header.")
            }
            val name = line.take(colon).lowercase()
            if (headers.containsKey(name)) throw HttpError(400, "duplicate_header", "Duplicate headers are not supported.")
            headers[name] = line.substring(colon + 1).trim(' ', '\t')
        }
        // Native phone clients do not send browser-origin headers. Reject even Origin:null;
        // this control endpoint never grants CORS access or supports browser preflight.
        if (headers.containsKey("origin") || headers.keys.any { it.startsWith("sec-fetch-") }) {
            throw HttpError(403, "browser_not_allowed", "Browser requests are not allowed.")
        }
        if (headers.containsKey("transfer-encoding") || headers.containsKey("trailer") || headers.containsKey("upgrade")) {
            throw HttpError(400, "unsupported_framing", "Use one Content-Length body without transfer encoding or upgrades.")
        }
        if (headers.containsKey("expect")) throw HttpError(417, "expectation_failed", "Expect headers are not supported.")
        if (parts[2] == "HTTP/1.1" && headers["host"].isNullOrEmpty()) {
            throw HttpError(400, "missing_host", "HTTP/1.1 requires a Host header.")
        }
        if (headers.containsKey("content-encoding") || !jsonContentType.matches(headers["content-type"]?.lowercase() ?: "")) {
            throw HttpError(415, "unsupported_media_type", "Send uncompressed application/json in UTF-8.")
        }
        val sizeText = headers["content-length"] ?: throw HttpError(411, "length_required", "Content-Length is required.")
        if (sizeText.isEmpty() || !sizeText.all { it in '0'..'9' }) {
            throw HttpError(400, "invalid_length", "Content-Length must be a positive decimal byte count.")
        }
        val size = sizeText.toLongOrNull()
        if (size == null || size > MAX_FRAME_BYTES) throw HttpError(413, "body_too_large", "Request body exceeds 64 KiB.")
        if (size == 0L) throw HttpError(400, "empty_body", "A JSON request body is required.")
        val body = ByteArray(size.toInt()) { nextByte().toByte() }
        val text = try { body.decodeToString(throwOnInvalidSequence = true) }
            catch (ignored: Exception) { throw HttpError(400, "invalid_encoding", "Request body must be valid UTF-8.") }
        return WireRequest(text, true)
    }

    private fun writeHttp(connection: RemoteInputConnection, status: Int, body: String) {
        val bytes = body.encodeToByteArray()
        val phrase = when (status) {
            200 -> "OK"; 400 -> "Bad Request"; 403 -> "Forbidden"; 404 -> "Not Found"
            405 -> "Method Not Allowed"; 408 -> "Request Timeout"; 411 -> "Length Required"
            413 -> "Content Too Large"; 415 -> "Unsupported Media Type"; 417 -> "Expectation Failed"
            431 -> "Request Header Fields Too Large"; 504 -> "Gateway Timeout"; 505 -> "HTTP Version Not Supported"
            else -> "Error"
        }
        val headers = "HTTP/1.1 $status $phrase\r\n" +
            "Content-Type: application/json; charset=utf-8\r\n" +
            "Content-Length: ${bytes.size}\r\n" +
            "Connection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n" +
            (if (status == 405) "Allow: POST\r\n" else "") + "\r\n"
        connection.write(headers.encodeToByteArray() + bytes)
    }

    companion object {
        const val MAX_FRAME_BYTES = 65536
        const val MAX_HTTP_HEADER_BYTES = 8192
        const val MAX_HTTP_HEADERS = 64

        private fun isHttpToken(value: Int): Boolean =
            value in '0'.code..'9'.code || value in 'A'.code..'Z'.code || value in 'a'.code..'z'.code ||
                value.toChar() in "!#$%&'*+-.^_`|~"

        private val jsonContentType = Regex("application/json(?:\\s*;\\s*charset\\s*=\\s*(?:utf-8|\"utf-8\"))?")
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
