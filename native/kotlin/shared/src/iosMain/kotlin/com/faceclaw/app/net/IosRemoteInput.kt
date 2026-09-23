package com.faceclaw.app

import platform.darwin.dispatch_async
import platform.darwin.dispatch_get_main_queue

/** Runs [action] on the main queue, where NativeScript's JavaScript lives. */
internal fun dispatchToMain(action: () -> Unit) {
    dispatch_async(dispatch_get_main_queue()) { action() }
}

/**
 * iOS facade over the shared [RemoteInputSession] for the TypeScript side
 * (app/native/remote-input.ios.ts): POSIX sockets, Security-framework randomness and
 * main-queue request notifications. Mirrors the Android FaceclawRemoteInput API.
 */
class IosRemoteInput internal constructor(
    dispatch: (() -> Unit) -> Unit,
    requestTimeoutMs: Long,
) {
    constructor() : this(::dispatchToMain, RemoteInputSession.REQUEST_TIMEOUT_MS)

    private val session = RemoteInputSession(
        port = IosLocalServerPort,
        random = IosSecureRandom,
        dispatch = dispatch,
        platform = IosProtocolPlatform,
        requestTimeoutMs = requestTimeoutMs,
    )

    /** Called (on the main queue) whenever a request is waiting in [nextRequest]. */
    fun setRequestListener(listener: (() -> Unit)?) = session.setRequestListener(listener)

    fun start(port: Int): String = startAddress(port, "127.0.0.1")

    /** Returns "" on success or a user-facing error. */
    fun startAddress(port: Int, address: String): String = session.start(port, address)

    fun stop() = session.stop()

    fun nextRequest(): String? = session.nextRequest()

    fun complete(id: Long, value: String?) = session.complete(id, value)

    fun randomSecret(): String = session.randomSecret()

    fun tokenDigest(value: String): String = RemoteInputSession.tokenHash(value)

    /** JSON array of {name, address, pointToPoint} for the reachable local interfaces. */
    fun interfaces(): String = RemoteInputSession.interfacesJson(iosInterfaceAddresses())

    companion object {
        val shared: IosRemoteInput by lazy { IosRemoteInput() }
    }
}
