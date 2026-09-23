package com.faceclaw.app

import android.os.Handler
import android.os.Looper
import java.io.IOException
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import java.util.Collections

/**
 * Explicit-address, bounded input port. The request state machine lives in the shared
 * [RemoteInputSession]; this adapter supplies java.net sockets, SecureRandom and main-thread
 * delivery, and keeps the JVM API TypeScript calls (app/native/remote-input.ts).
 */
class FaceclawRemoteInput {
    companion object {
        private val INSTANCE = FaceclawRemoteInput()
        @JvmStatic fun getInstance(): FaceclawRemoteInput { return INSTANCE }

        @JvmStatic
        fun interfaces(): String {
            val all = ArrayList<InterfaceAddress>()
            try {
                for (device in Collections.list(NetworkInterface.getNetworkInterfaces())) {
                    for (address in Collections.list(device.inetAddresses)) {
                        all.add(InterfaceAddress(
                            interfaceName = device.name,
                            address = address.hostAddress ?: continue,
                            up = device.isUp,
                            pointToPoint = device.isPointToPoint,
                            loopback = address.isLoopbackAddress,
                            linkLocal = address.isLinkLocalAddress,
                            anyLocal = address.isAnyLocalAddress,
                        ))
                    }
                }
            } catch (ignored: Exception) {}
            return RemoteInputSession.interfacesJson(all)
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val session = RemoteInputSession(
        port = AndroidLocalServerPort,
        random = object : RandomSource {
            private val secureRandom = SecureRandom()
            override fun nextBytes(count: Int): ByteArray = ByteArray(count).also { secureRandom.nextBytes(it) }
        },
        dispatch = { action -> mainHandler.post(action) },
        platform = AndroidProtocolPlatform,
    )

    fun setRequestListener(listener: Runnable?) { session.setRequestListener(listener?.let { { it.run() } }) }

    fun start(port: Int): String { return startAddress(port, "127.0.0.1") }
    fun startAddress(port: Int, address: String): String = session.start(port, address)
    fun stop() = session.stop()
    fun nextRequest(): String? = session.nextRequest()
    fun complete(id: Long, value: String?) = session.complete(id, value)
    fun randomSecret(): String = session.randomSecret()
    fun hash(value: String): String = RemoteInputSession.tokenHash(value)
}

private object AndroidLocalServerPort : LocalServerPort {
    override fun isLocalUnicastAddress(address: String): Boolean {
        return try {
            // Numeric literals only reach here, so getByName never resolves a hostname.
            val local = InetAddress.getByName(address)
            !(local.isAnyLocalAddress || local.isMulticastAddress || NetworkInterface.getByInetAddress(local) == null)
        } catch (e: Exception) {
            false
        }
    }

    override fun bind(address: String, port: Int): RemoteInputListener {
        val server = ServerSocket(port, 8, InetAddress.getByName(address))
        return object : RemoteInputListener {
            override fun accept(): RemoteInputConnection? {
                val socket = try { server.accept() } catch (e: IOException) { return null }
                return AndroidConnection(socket)
            }
            override val isClosed: Boolean get() = server.isClosed
            override fun close() = server.close()
        }
    }
}

private class AndroidConnection(private val socket: Socket) : RemoteInputConnection {
    init {
        socket.soTimeout = 5000
        socket.tcpNoDelay = true
    }

    override fun readByte(timeoutMs: Long): Int {
        return try {
            socket.soTimeout = timeoutMs.coerceIn(1L, Int.MAX_VALUE.toLong()).toInt()
            socket.getInputStream().read()
        } catch (e: IOException) {
            -1
        }
    }

    override fun write(bytes: ByteArray) {
        socket.getOutputStream().write(bytes)
        socket.getOutputStream().flush()
    }

    override fun close() = socket.close()
}
