package com.faceclaw.app

import android.os.Handler
import android.os.Looper
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.NetworkInterface
import java.util.Collections
import org.json.JSONArray
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import org.json.JSONObject

/** Explicit-address, bounded input port. Complete requests notify JS on the main thread. */
class FaceclawRemoteInput {
    companion object {
        private val INSTANCE = FaceclawRemoteInput()
        @JvmStatic fun getInstance(): FaceclawRemoteInput { return INSTANCE }

        @JvmStatic
        fun interfaces(): String {
            val result = JSONArray()
            try {
                for (device in Collections.list(NetworkInterface.getNetworkInterfaces())) {
                    if (!device.isUp) continue
                    for (address in Collections.list(device.inetAddresses)) {
                        if (address.isLoopbackAddress || address.isLinkLocalAddress || address.isAnyLocalAddress) continue
                        result.put(JSONObject().put("name", device.name).put("address", address.hostAddress)
                            .put("pointToPoint", device.isPointToPoint))
                    }
                }
            } catch (ignored: Exception) {}
            return result.toString()
        }

        private fun hex(bytes: ByteArray): String {
            val result = StringBuilder(bytes.size * 2)
            for (b in bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", b.toInt() and 255))
            return result.toString()
        }
    }
    private var server: ServerSocket? = null
    private var client: Socket? = null
    private var pending: String? = null
    private var reply: String? = null
    private var nextId = 0L
    private var requestId = 0L
    private var deadline = 0L
    private val mainHandler = Handler(Looper.getMainLooper())
    private var requestListener: Runnable? = null

    @Synchronized fun setRequestListener(listener: Runnable?) { requestListener = listener }

    private fun notifyRequestReady(id: Long) {
        // Called with this monitor held; posting avoids entering JS on the socket thread.
        mainHandler.post {
            val callback: Runnable?
            synchronized(this) {
                if (requestId != id || pending == null || System.currentTimeMillis() >= deadline) return@post
                callback = requestListener
            }
            callback?.run()
        }
    }

    @Synchronized fun start(port: Int): String { return startAddress(port, "127.0.0.1") }
    @Synchronized fun startAddress(port: Int, address: String): String {
        if (server != null) return ""
        try {
            // Numeric local addresses only; never resolve hostnames or bind a wildcard.
            if (!address.matches(Regex("[0-9.]+|[0-9a-fA-F]*:[0-9a-fA-F:.]*(%[a-zA-Z0-9_.-]+)?"))) return "Invalid local address."
            val local = InetAddress.getByName(address)
            if (local.isAnyLocalAddress || local.isMulticastAddress || NetworkInterface.getByInetAddress(local) == null)
                return "Address is not assigned to a local interface."
            val listener = ServerSocket(port, 8, local)
            server = listener
            val thread = Thread({ serve(listener) }, "FaceclawInput")
            thread.isDaemon = true
            thread.start()
            return ""
        } catch (e: Exception) { return "Could not open local input port $port." }
    }
    @Synchronized fun stop() {
        try { server?.close() } catch (ignored: Exception) {}
        try { client?.close() } catch (ignored: Exception) {}
        server = null; client = null; pending = null; requestId = 0; reply = null
        (this as java.lang.Object).notifyAll()
    }
    @Synchronized fun nextRequest(): String? {
        if (System.currentTimeMillis() >= deadline) { pending = null; return null }
        val result = pending; pending = null; return result
    }
    @Synchronized fun complete(id: Long, value: String?) {
        if (id == requestId && System.currentTimeMillis() < deadline) { reply = value; (this as java.lang.Object).notifyAll() }
    }
    private fun serve(listener: ServerSocket) {
        while (!listener.isClosed) {
            try {
                listener.accept().use { socket ->
                    synchronized(this) { if (server !== listener) return; client = socket }
                    socket.soTimeout = 5000
                    socket.tcpNoDelay = true
                    val readDeadline = System.currentTimeMillis() + 5000
                    val body = ByteArrayOutputStream()
                    var b = -1
                    while (true) {
                        val remaining = readDeadline - System.currentTimeMillis()
                        if (remaining <= 0) throw Exception("Read timeout")
                        socket.soTimeout = remaining.toInt()
                        b = socket.getInputStream().read()
                        if (b == -1 || b == '\n'.code) break
                        if (body.size() >= 65536) throw Exception("Invalid frame")
                        body.write(b)
                    }
                    if (b != '\n'.code) return@use
                    val text = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(body.toByteArray())).toString()
                    val response: String
                    synchronized(this) {
                        if (server !== listener) return
                        requestId = ++nextId
                        deadline = System.currentTimeMillis() + 5000
                        reply = null
                        pending = JSONObject().put("id", requestId).put("expiresAt", deadline)
                            .put("body", text).toString()
                        notifyRequestReady(requestId)
                        while (reply == null && server === listener && System.currentTimeMillis() < deadline) {
                            (this as java.lang.Object).wait(Math.max(1L, deadline - System.currentTimeMillis()))
                        }
                        response = reply ?: "{\"ok\":false,\"error\":\"timeout\",\"message\":\"Faceclaw did not respond in time.\"}"
                        if (server === listener) { pending = null; reply = null; requestId = 0 }
                    }
                    socket.getOutputStream().write((response + "\n").toByteArray(StandardCharsets.UTF_8))
                }
            } catch (ignored: Exception) {
                // Never log request bodies: they contain credentials and possibly private text.
            } finally {
                synchronized(this) { if (server === listener) client = null }
            }
        }
    }
    fun randomSecret(): String {
        val bytes = ByteArray(32); SecureRandom().nextBytes(bytes); return hex(bytes)
    }
    fun hash(value: String): String {
        try { return hex(MessageDigest.getInstance("SHA-256").digest(value.toByteArray(StandardCharsets.UTF_8))) }
        catch (e: Exception) { throw IllegalStateException("SHA-256 unavailable", e) }
    }
}
