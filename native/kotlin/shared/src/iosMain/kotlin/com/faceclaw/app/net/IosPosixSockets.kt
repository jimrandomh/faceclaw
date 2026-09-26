@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package com.faceclaw.app

import kotlin.concurrent.Volatile

import kotlinx.cinterop.ByteVar
import kotlinx.cinterop.CPointer
import kotlinx.cinterop.IntVar
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.alloc
import kotlinx.cinterop.allocArray
import kotlinx.cinterop.allocPointerTo
import kotlinx.cinterop.CFunction
import kotlinx.cinterop.COpaquePointer
import kotlinx.cinterop.COpaquePointerVar
import kotlinx.cinterop.UIntVar
import kotlinx.cinterop.invoke
import kotlinx.cinterop.plus
import kotlinx.cinterop.convert
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.pointed
import kotlinx.cinterop.ptr
import kotlinx.cinterop.reinterpret
import kotlinx.cinterop.sizeOf
import kotlinx.cinterop.toKString
import kotlinx.cinterop.usePinned
import kotlinx.cinterop.value
import platform.Security.SecRandomCopyBytes
import platform.Security.kSecRandomDefault
import platform.posix.AF_INET
import platform.posix.AF_INET6
import platform.posix.AI_NUMERICHOST
import platform.posix.AI_NUMERICSERV
import platform.posix.IFF_LOOPBACK
import platform.posix.IFF_POINTOPOINT
import platform.posix.IFF_UP
import platform.posix.IPPROTO_TCP
import platform.posix.NI_MAXHOST
import platform.posix.NI_NUMERICHOST
import platform.posix.POLLIN
import platform.posix.SHUT_RDWR
import platform.posix.SOCK_STREAM
import platform.posix.SOL_SOCKET
import platform.posix.SO_NOSIGPIPE
import platform.posix.SO_REUSEADDR
import platform.posix.TCP_NODELAY
import platform.posix.accept
import platform.posix.addrinfo
import platform.posix.bind
import platform.posix.close
import platform.posix.dlopen
import platform.posix.dlsym
import platform.posix.RTLD_NOW
import platform.posix.freeaddrinfo
import platform.posix.getaddrinfo
import platform.posix.getnameinfo
import platform.posix.listen
import platform.posix.poll
import platform.posix.pollfd
import platform.posix.recv
import platform.posix.send
import platform.posix.setsockopt
import platform.posix.shutdown
import platform.posix.sockaddr
import platform.posix.socket

/** Numeric host text of a socket address, or null when it is not IPv4/IPv6. */
private fun numericHost(address: CPointer<sockaddr>?): String? {
    if (address == null) return null
    val family = address.pointed.sa_family.toInt()
    if (family != AF_INET && family != AF_INET6) return null
    return memScoped {
        val host = allocArray<ByteVar>(NI_MAXHOST)
        val status = getnameinfo(address, address.pointed.sa_len.convert(), host, NI_MAXHOST.convert(), null, 0u, NI_NUMERICHOST)
        if (status != 0) null else host.toKString()
    }
}

// Kotlin/Native's POSIX library for iOS does not bind <ifaddrs.h>, so the two functions are
// resolved from libSystem at runtime and `struct ifaddrs` is read by its fixed 64-bit layout:
// ifa_next @0, ifa_name @8, ifa_flags @16, ifa_addr @24 (netmask @32, dstaddr @40, data @48).
private typealias GetIfAddrs = CFunction<(CPointer<COpaquePointerVar>) -> Int>
private typealias FreeIfAddrs = CFunction<(COpaquePointer?) -> Unit>

private val libSystem: COpaquePointer? by lazy { dlopen(null, RTLD_NOW) }

private fun CPointer<*>.pointerField(offset: Int): COpaquePointer? =
    (this.reinterpret<ByteVar>() + offset)!!.reinterpret<COpaquePointerVar>().pointed.value

private fun CPointer<*>.uintField(offset: Int): UInt =
    (this.reinterpret<ByteVar>() + offset)!!.reinterpret<UIntVar>().pointed.value

/** Every address assigned to a local interface, as the shared session's [InterfaceAddress]. */
fun iosInterfaceAddresses(): List<InterfaceAddress> {
    val result = ArrayList<InterfaceAddress>()
    val getifaddrs = dlsym(libSystem, "getifaddrs")?.reinterpret<GetIfAddrs>() ?: return result
    val freeifaddrs = dlsym(libSystem, "freeifaddrs")?.reinterpret<FreeIfAddrs>() ?: return result
    memScoped {
        val list = alloc<COpaquePointerVar>()
        if (getifaddrs(list.ptr) != 0) return result
        try {
            var item: COpaquePointer? = list.value
            while (item != null) {
                val host = numericHost(item.pointerField(24)?.reinterpret())
                if (host != null) {
                    val flags = item.uintField(16).toInt()
                    val bare = host.substringBefore('%')
                    val loopbackFlag = flags and IFF_LOOPBACK != 0
                    result.add(InterfaceAddress(
                        interfaceName = item.pointerField(8)?.reinterpret<ByteVar>()?.toKString() ?: "",
                        address = host,
                        up = flags and IFF_UP != 0,
                        pointToPoint = flags and IFF_POINTOPOINT != 0,
                        loopback = loopbackFlag || bare.startsWith("127.") || bare == "::1",
                        linkLocal = bare.startsWith("169.254.") || bare.lowercase().startsWith("fe80:"),
                        anyLocal = bare == "0.0.0.0" || bare == "::",
                    ))
                }
                item = item.pointerField(0)
            }
        } finally {
            freeifaddrs(list.value)
        }
    }
    return result
}

private fun setIntOption(fd: Int, level: Int, option: Int, value: Int) {
    memScoped {
        val holder = alloc<IntVar>()
        holder.value = value
        setsockopt(fd, level, option, holder.ptr, sizeOf<IntVar>().convert())
    }
}

/** Canonical numeric text of a literal address, or null when it is not a literal. */
private fun canonicalAddress(address: String): String? =
    memScoped {
        val hints = alloc<addrinfo>()
        hints.ai_flags = AI_NUMERICHOST
        hints.ai_socktype = SOCK_STREAM
        val resolved = allocPointerTo<addrinfo>()
        if (getaddrinfo(address, null, hints.ptr, resolved.ptr) != 0) return null
        try {
            numericHost(resolved.value?.pointed?.ai_addr)
        } finally {
            freeaddrinfo(resolved.value)
        }
    }

/** POSIX sockets for the shared [RemoteInputSession]. */
object IosLocalServerPort : LocalServerPort {
    override fun isLocalUnicastAddress(address: String): Boolean {
        val canonical = canonicalAddress(address) ?: return false
        // Wildcard and multicast addresses are never assigned to an interface.
        return iosInterfaceAddresses().any { it.address == canonical || it.address.substringBefore('%') == canonical }
    }

    override fun bind(address: String, port: Int): RemoteInputListener {
        val fd = memScoped {
            val hints = alloc<addrinfo>()
            hints.ai_flags = AI_NUMERICHOST or AI_NUMERICSERV
            hints.ai_socktype = SOCK_STREAM
            val resolved = allocPointerTo<addrinfo>()
            if (getaddrinfo(address, port.toString(), hints.ptr, resolved.ptr) != 0) error("Invalid address")
            try {
                val info = resolved.value!!.pointed
                val socketFd = socket(info.ai_family, SOCK_STREAM, 0)
                if (socketFd < 0) error("socket failed")
                setIntOption(socketFd, SOL_SOCKET, SO_REUSEADDR, 1)
                if (bind(socketFd, info.ai_addr, info.ai_addrlen) != 0 || listen(socketFd, 8) != 0) {
                    close(socketFd)
                    error("bind failed")
                }
                socketFd
            } finally {
                freeaddrinfo(resolved.value)
            }
        }
        return PosixListener(fd)
    }
}

private class PosixListener(private val fd: Int) : RemoteInputListener {
    @Volatile
    private var closed = false

    override val isClosed: Boolean
        get() = closed

    override fun accept(): RemoteInputConnection? {
        while (!closed) {
            // Polling also guarantees close() is observed where shutdown does not wake accept.
            val ready = memScoped {
                val request = alloc<pollfd>()
                request.fd = fd
                request.events = POLLIN.toShort()
                poll(request.ptr, 1u, 250)
            }
            if (closed) return null
            if (ready <= 0) continue
            val client = accept(fd, null, null)
            if (client < 0) return null
            setIntOption(client, SOL_SOCKET, SO_NOSIGPIPE, 1)
            setIntOption(client, IPPROTO_TCP, TCP_NODELAY, 1)
            return PosixConnection(client)
        }
        return null
    }

    override fun close() {
        if (closed) return
        closed = true
        shutdown(fd, SHUT_RDWR)
        close(fd)
    }
}

private class PosixConnection(private val fd: Int) : RemoteInputConnection {
    @Volatile
    private var closed = false

    override fun readByte(timeoutMs: Long): Int {
        if (closed) return -1
        return memScoped {
            val request = alloc<pollfd>()
            request.fd = fd
            request.events = POLLIN.toShort()
            if (poll(request.ptr, 1u, timeoutMs.coerceIn(0L, Int.MAX_VALUE.toLong()).toInt()) <= 0) return -1
            val byte = alloc<ByteVar>()
            if (recv(fd, byte.ptr, 1u, 0) != 1L) -1 else byte.value.toInt() and 0xff
        }
    }

    override fun write(bytes: ByteArray) {
        if (bytes.isEmpty() || closed) return
        bytes.usePinned { pinned ->
            var offset = 0
            while (offset < bytes.size) {
                val sent = send(fd, pinned.addressOf(offset), (bytes.size - offset).convert(), 0)
                if (sent <= 0L) error("send failed")
                offset += sent.toInt()
            }
        }
    }

    override fun close() {
        if (closed) return
        closed = true
        shutdown(fd, SHUT_RDWR)
        close(fd)
    }
}

/** Cryptographically secure bytes from the Security framework. */
object IosSecureRandom : RandomSource {
    override fun nextBytes(count: Int): ByteArray {
        val bytes = ByteArray(count)
        if (count == 0) return bytes
        val status = bytes.usePinned { SecRandomCopyBytes(kSecRandomDefault, count.convert(), it.addressOf(0)) }
        check(status == 0) { "SecRandomCopyBytes failed: $status" }
        return bytes
    }
}
