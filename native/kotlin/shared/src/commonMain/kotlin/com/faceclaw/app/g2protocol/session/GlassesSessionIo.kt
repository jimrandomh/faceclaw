package com.faceclaw.app

import com.faceclaw.app.GlassesSessionCore.Companion.hex
import com.faceclaw.app.GlassesSessionCore.Companion.safeMessage
import kotlin.random.Random

/** Which glasses a session drives. Set before [GlassesSessionCore.start]; see [GlassesSessionCore.useRayNeoIo]. */
enum class GlassesType { G2, RAYNEO_IO }

/**
 * RayNeo iO session state ([GlassesSessionCore.io]); guarded by the core's monitor.
 *
 * The iO is one SoC on ONE BLE link that drives both eyes, so the core runs it with the same
 * address in both arm slots: CFW messages keep going to the "left" arm, per-arm bookkeeping
 * resolves to index 0, and the firmware ACKs each lens of a record separately, exactly what
 * the existing window expects. What differs lives here: the AA55 envelope, the TLV handshake
 * and guest authentication, IDENT-based capability detection, and the page lease
 * (PAGE_OPEN + KEEPALIVE) that stands in for the G2's EvenHub page and framebuffer lease.
 * Wire codecs: [RayNeoIoProtocol]; firmware: faceclaw-rayneo-cfw (docs/FACECLAW.md).
 */
internal class IoSessionState {
    var phoneId = ByteArray(6)
    var phoneName = "Faceclaw"
    var manufacturer = "Android"
    var model = "Android"

    val reassembler = RayNeoIoProtocol.FrameReassembler()
    var messageNumber = Random.nextInt(0, 0x10000)
    var launcherSequence = 0

    var versionReply: RayNeoIoProtocol.VersionReply? = null
    var authReply: ByteArray? = null
    var ident: RayNeoIoProtocol.Ident? = null
    var osVersion = ""
    var maxChunk = RayNeoIoProtocol.DEFAULT_MAX_CHUNK

    /** Last PAGE state the glasses reported: 1 open, 0 closed, -1 none yet this link. */
    var pageState = -1
    var pageReason = 0
    var pageReplies = 0
    /** Whether the phone wants the page open (false while suspended or after the wearer closed it). */
    var pageWanted = true
    var pageRequestSentAtMs = 0L
    var lastKeepaliveAtMs = 0L
    var lastStatusAtMs = 0L
    var refusals = 0

    /** Whether Faceclaw's latest frame is meant to be seen (false for its blanked frames). */
    var displayVisible = false
    var brightnessSentLevel = -1
    var lastBrightnessAtMs = 0L
    /** The light sensor poll interval this page was last asked for ([ioFirmwareOwnsBrightness]), -1 none. */
    var alsIntervalSent = -1
    /** Last `screen_status` push: 1 on, 0 off, -1 unknown. */
    var screenStatus = -1

    /** Whether Faceclaw answers "Hey RayNeo" (null until the dashboard says); what this link was last told. */
    var voiceWakeWanted: Boolean? = null
    var voiceWakeSent = -1
    /** The stock assistant opened a session (wake word): end it, it must not take the display. */
    var voiceAbortPending = false
    /** Ask for the launcher's general settings (logged: the wake-word preferences among them). */
    var settingsRequestPending = true
    /** When a wake was last reported: one phrase can wake twice (fast and second stage). */
    var lastVoiceWakeAtMs = 0L

    /** A capture wants the remote mic stream; whether this link was asked to open it, and when. */
    var micWanted = false
    var micStreamOpen = false
    var micStartSentAtMs = 0L
    var micPackets = 0L
    var lastMicPacketAtMs = 0L

    fun resetLink() {
        reassembler.reset()
        versionReply = null
        authReply = null
        ident = null
        pageState = -1
        pageReason = 0
        pageRequestSentAtMs = 0
        lastKeepaliveAtMs = 0
        lastStatusAtMs = 0
        brightnessSentLevel = -1
        lastBrightnessAtMs = 0
        alsIntervalSent = -1
        screenStatus = -1
        voiceWakeSent = -1
        voiceAbortPending = false
        settingsRequestPending = true
        micStreamOpen = false
        micStartSentAtMs = 0
    }
}

internal object IoTimings {
    const val VERSION_REPLY_MS = 4_000L
    const val AUTH_REPLY_MS = 4_000L
    const val OS_VERSION_MS = 1_500L
    const val IDENT_MS = 3_000L
    const val PAGE_REPLY_MS = 4_000L
    /** Well inside the firmware's 120 s page lease. */
    const val KEEPALIVE_MS = 30_000L
    const val STATUS_MS = 60_000L
    const val PAGE_RETRY_MS = 3_000L
    /** Retry cadence while the glasses refuse this phone id (waiting for pairing mode). */
    const val PAIRING_RETRY_MS = 2_000L
    const val PAGE_REASON_USER = 4
    /** While Faceclaw shows content, re-assert the screen this often (the stock auto-off is short). */
    const val SCREEN_REFRESH_MS = 5_000L
    /** A wanted mic stream that hasn't delivered a packet this long is asked for again. */
    const val MIC_RETRY_MS = 3_000L
    /** Wakes this close to a reported one are the same phrase (fast stage, then second stage). */
    const val VOICE_WAKE_DEDUP_MS = 3_000L
}

/** The glasses hung up at the version request: bound to another phone id, or not in pairing mode. */
internal class IoPairingRefusedException : IllegalStateException("glasses hung up at the version request")

/** CFW message types the iO firmware implements (fc_glue.c + raster cleanup). */
internal fun ioSupportsCfwType(type: Int): Boolean =
    type == CFW_MSG_CLEANUP || type == CFW_MSG_UPLOAD_RESOURCE || type == CFW_MSG_EVICT_RESOURCE ||
        type == CFW_MSG_DRAW_CALLS || type == CFW_MSG_SET_ROOT_DISPLAY_LIST ||
        type == CFW_MSG_PRESENT || type == CFW_MSG_CREATE_SURFACE

internal val GlassesSessionCore.isIo: Boolean get() = glassesType == GlassesType.RAYNEO_IO

/**
 * The firmware runs message 30 and the light sensor (faceclaw-rayneo-cfw bright.c), with the G2's
 * wire formats, so the shared brightness code drives it. Older firmware gets the launcher's
 * brightness command, which is all it has (see [ioMaintain]).
 */
internal val GlassesSessionCore.ioFirmwareOwnsBrightness: Boolean get() = io.ident?.brightnessControl == true

/** Messages the iO cannot take (stock EvenHub/settings traffic, the G2's other hardware CFW modes). */
internal fun GlassesSessionCore.ioSupportsMessage(message: OutboundMessage): Boolean {
    if (message.sid != CfwTransport.SID || message.message.isEmpty()) return false
    val type = message.message[0].toInt() and 255
    return ioSupportsCfwType(type) ||
        (ioFirmwareOwnsBrightness && (type == CFW_MSG_BRIGHTNESS || type == CFW_MSG_AMBIENT_LIGHT))
}

/** A page opened (or reopened): the firmware gave brightness back when the last one closed. */
private fun GlassesSessionCore.ioResetBrightnessLocked() {
    brightnessSentVisible = null
    brightnessSentLevel = -1
    brightnessAlsStartedAt = -2000
    brightnessPolicy.resetSamples()
    io.alsIntervalSent = -1
}

// ---------------------------------------------------------------------------------------------
// Writes

private fun GlassesSessionCore.ioNextMessageNumberLocked(): Int {
    val n = io.messageNumber and 0xffff
    io.messageNumber = (io.messageNumber + 1) and 0xffff
    return n
}

/** One AA55 frame on the iO write characteristic; worker thread, outside the monitor. */
internal fun GlassesSessionCore.ioWriteFrame(business: Int, payload: ByteArray): Boolean {
    val frame = monitor.withLock { RayNeoIoProtocol.encodeFrame(ioNextMessageNumberLocked(), business, payload) }
    return link.writeFrames(
        rightAddress, RayNeoIoBle.WRITE_CHAR_UUID,
        RayNeoIoProtocol.writes(frame, link.negotiatedMtu(rightAddress)),
        GattWriteMode.WITHOUT_RESPONSE, ConnectionOptions.WRITE_TIMEOUT_MS,
    )
}

internal fun GlassesSessionCore.ioWriteControl(ctrl: Int): Boolean =
    ioWriteFrame(RayNeoIoProtocol.BUSINESS_CFW, RayNeoIoProtocol.controlPacket(ctrl))

private fun GlassesSessionCore.ioWriteLauncher(type: Int, json: String): Boolean {
    val sequence = monitor.withLock {
        io.launcherSequence = if (io.launcherSequence >= 0xffff) 1 else io.launcherSequence + 1
        io.launcherSequence
    }
    val envelope = RayNeoIoProtocol.Envelope(type, json, sequence = sequence, mode = RayNeoIoProtocol.MODE_REQUEST)
    return ioWriteFrame(RayNeoIoProtocol.BUSINESS_LAUNCHER, RayNeoIoProtocol.encodeEnvelope(envelope))
}

internal fun GlassesSessionCore.ioRequestStatus(): Boolean =
    ioWriteLauncher(RayNeoIoProtocol.LAUNCHER_GENERAL_STATUS, RayNeoIoProtocol.GENERAL_STATUS_REQUEST)

/** From the image path (enqueueBrightnessLocked): a visible frame wakes the screen at once. */
internal fun GlassesSessionCore.ioNoteFrameVisibleLocked(frameVisible: Boolean?) {
    if (frameVisible == null) return
    if (frameVisible && !io.displayVisible) io.lastBrightnessAtMs = 0
    io.displayVisible = frameVisible
}

/**
 * The writes for one queued CFW message: the shared record (persistent deflate context, as
 * on the G2) in `[opt][stream][chunk]` packets, each its own AA55 frame. The stream byte is
 * the message's magic, which the firmware echoes in its per-lens ACKs.
 */
internal fun GlassesSessionCore.ioCfwWrites(message: OutboundMessage, mtu: Int): List<ByteArray> {
    val transport = cfwTransports[0]
    if (message.cfwRetries > 0) transport.reset()
    val record = transport.encodeRecord(message.message, CfwTransport.BOTH)
    return monitor.withLock {
        RayNeoIoProtocol.cfwPackets(record, message.magic, io.maxChunk).flatMap { packet ->
            RayNeoIoProtocol.writes(RayNeoIoProtocol.encodeFrame(ioNextMessageNumberLocked(), RayNeoIoProtocol.BUSINESS_CFW, packet), mtu)
        }
    }
}

/** A message the iO can't run (see [ioSupportsMessage]): never sent, never waited on. */
internal fun GlassesSessionCore.ioDropUnsupported(message: OutboundMessage) {
    monitor.withLock {
        inFlightMessages.remove(message)
        if (message.magic != 0) magicPool.release(message.sid, message.magic, message.label, "unsupported on RayNeo iO")
    }
    logDebug("RayNeo iO: dropped unsupported message " + message.label + " sid=" + message.sid)
}

// ---------------------------------------------------------------------------------------------
// Connect (worker thread)

private fun GlassesSessionCore.ioAwait(timeoutMs: Long, what: String, ready: () -> Boolean) {
    val deadline = now() + timeoutMs
    monitor.withLock {
        while (true) {
            if (ready()) return
            if (!running || userDisconnectRequested) throw IllegalStateException("stopped while waiting for $what")
            if (!rightConnected) throw IoLinkLostException(what)
            val remaining = deadline - now()
            if (remaining <= 0) throw IllegalStateException("$what timed out")
            monitor.awaitMs(minOf(remaining, 100L))
        }
    }
}

private class IoLinkLostException(what: String) : IllegalStateException("link lost while waiting for $what")

internal fun GlassesSessionCore.ioConnectLoopOnce() {
    monitor.withLock {
        wearState = -1
        io.resetLink()
    }
    setStateDisplay("connecting", "Connecting to the glasses...")
    ConnectionCounters.increment("io.connect-attempt")
    val address = rightAddress
    try {
        if (!link.connect(address, ConnectionOptions.ARM_CONNECT_WINDOW_MS)) {
            handleTransportFailure("glasses not found", "Can't find the glasses. They may be off, in their case, or out of range.")
            return
        }
        link.requestHighPriority(address)
        link.requestMtu(address, RayNeoIoBle.REQUESTED_MTU, ConnectionOptions.CONNECT_TIMEOUT_MS)
        if (!link.discoverServices(address, ConnectionOptions.SERVICES_TIMEOUT_MS)) throw IllegalStateException("discoverServices failed: $address")
        if (!link.enableNotifications(address, RayNeoIoBle.NOTIFY_CHAR_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS)) {
            throw IllegalStateException("enableNotifications failed: $address")
        }
        link.requestLe2mPhy(address)
        monitor.withLock {
            rightConnected = true
            leftConnected = true
        }

        // Version exchange. Glasses bound to another phone id (or not in pairing mode)
        // hang up ~100 ms after this request instead of answering.
        val phone = monitor.withLock { io.phoneId.copyOf() }
        logDebug("RayNeo iO: phone id " + hex(phone))
        if (!ioWriteFrame(RayNeoIoProtocol.BUSINESS_HANDSHAKE,
                RayNeoIoProtocol.versionRequest(phone, io.phoneName, io.manufacturer, io.model))) {
            throw IllegalStateException("version request write failed")
        }
        try {
            ioAwait(IoTimings.VERSION_REPLY_MS, "version reply") { io.versionReply != null }
        } catch (lost: IoLinkLostException) {
            throw IoPairingRefusedException()
        }
        val reply = monitor.withLock { io.versionReply!! }
        if (reply.accountBound) throw IoPairingRefusedException()
        logLine("RayNeo iO: glasses " + hex(reply.glassesId) + " serial " + reply.serial + " protocol " + reply.protocolVersion)

        val random = Random.nextBytes(4)
        if (!ioWriteFrame(RayNeoIoProtocol.BUSINESS_HANDSHAKE, RayNeoIoProtocol.guestAuthRequest(random, phone, reply.glassesId))) {
            throw IllegalStateException("guest auth write failed")
        }
        ioAwait(IoTimings.AUTH_REPLY_MS, "guest auth reply") { io.authReply != null }
        val authReply = monitor.withLock { io.authReply!! }
        if (!RayNeoIoProtocol.verifyGuestAuthReply(authReply, phone, reply.glassesId)) {
            throw IllegalStateException("guest auth proof mismatch")
        }
        monitor.withLock { io.refusals = 0 }

        // Battery and the OS version: answers arrive asynchronously; the version only labels
        // the firmware info, so a missing one is not fatal.
        ioRequestStatus()
        ioWriteFrame(RayNeoIoProtocol.BUSINESS_OTA,
            RayNeoIoProtocol.encodeEnvelope(RayNeoIoProtocol.Envelope(RayNeoIoProtocol.OTA_VERSION, "{}")))
        try {
            ioAwait(IoTimings.OS_VERSION_MS, "OS version") { io.osVersion.isNotEmpty() }
        } catch (e: IoLinkLostException) {
            throw e
        } catch (_: IllegalStateException) {
        }

        // Capability: the custom firmware answers QUERY with IDENT; stock firmware stays silent.
        ioWriteControl(RayNeoIoProtocol.CTRL_QUERY)
        val ident = try {
            ioAwait(IoTimings.IDENT_MS, "IDENT") { io.ident != null }
            monitor.withLock { io.ident }
        } catch (e: IoLinkLostException) {
            throw e
        } catch (_: IllegalStateException) {
            null
        }
        val os = monitor.withLock { io.osVersion.ifEmpty { "RayNeo iO" } }
        val info = BleProtocol.FirmwareInfo(os, os,
            if (ident != null && ident.faceclaw) "Faceclaw/" + ident.faceclawRevision else "")
        logLine("RayNeo iO: " + os + ", " + (if (ident == null) "no IDENT (stock firmware)"
            else ident.name + " " + ident.width + "x" + ident.height + " chunk " + ident.maxChunk
                + " flags 0x" + ident.flags.toString(16) + " faceclaw " + ident.faceclawRevision))
        emitFirmwareInfo(info)
        if (!info.isCompatible(requiredFirmwareRevision)) {
            monitor.withLock {
                // The worker loop halts on this and explains it (handleIncompatibleFirmware).
                incompatibleFirmware = info
            }
            return
        }
        monitor.withLock {
            io.maxChunk = ident!!.maxChunk.coerceIn(16, 4000)
            io.pageWanted = true
            io.pageRequestSentAtMs = now()
        }

        ioWriteControl(RayNeoIoProtocol.CTRL_PAGE_OPEN)
        try {
            ioAwait(IoTimings.PAGE_REPLY_MS, "page open") { io.pageReplies > 0 }
        } catch (e: IoLinkLostException) {
            throw e
        } catch (_: IllegalStateException) {
            // The launcher may be busy; ioMaintain keeps asking.
        }

        monitor.withLock {
            sessionReady = true
            shutdownRequested = false
            customFirmwareDetected = true
            clearAllMessagesLocked("session ready")
            fixedLayoutCreated = io.pageState == 1
            displayedFingerprint = ""
            lastAckAtMs = now()
            lastIncomingAtMs = lastAckAtMs
            lastConnectionOrInputAtMs = lastAckAtMs
            lastSessionReadyAtMs = lastAckAtMs
            imageRetryAfterMs = 0
            consecutiveAckTimeouts = 0
            cfwCleanupDelivered = false
            lastCfwCleanupAckMagic = 0
            for (transport in cfwTransports) transport.reset()
            io.lastKeepaliveAtMs = lastAckAtMs
            io.lastStatusAtMs = lastAckAtMs
            ioResetBrightnessLocked()
        }
        setStateDisplay("connected", "Connected.")
        ConnectionCounters.increment("io.session-ready")
        logLine("RayNeo iO session ready (page " + (if (fixedLayoutCreated) "open" else "pending") + ")")
    } catch (refused: IoPairingRefusedException) {
        val count = monitor.withLock {
            io.refusals++
            reconnectAfterMs = now() + IoTimings.PAIRING_RETRY_MS
            io.refusals
        }
        ConnectionCounters.increment("io.pairing-refused")
        logLine("RayNeo iO refused this phone (" + count + "); waiting for pairing mode")
        link.disconnect(address)
        monitor.withLock {
            rightConnected = false
            leftConnected = false
        }
        setStateDisplay("retrying",
            "The glasses aren't accepting this phone yet. Put them in pairing mode: on the charger, "
                + "hold the button about 5 seconds until the light blinks blue.")
    } catch (t: Throwable) {
        logLine("RayNeo iO connect failed: " + safeMessage(t))
        handleTransportFailure("connect failed")
    }
}

// ---------------------------------------------------------------------------------------------
// Session upkeep (worker thread, from driveSession, outside the monitor)

/** Page open/close requests, keepalives, status polls and the screen (launcher brightness). */
internal fun GlassesSessionCore.ioMaintain() {
    var ctrl = -1
    var status = false
    var brightness = -1
    var wakeword = -1
    var micRc = -1
    var abortVoice = false
    var settings = false
    monitor.withLock {
        if (!sessionReady) return
        val now = now()
        val wake = io.voiceWakeWanted
        if (wake != null && io.voiceWakeSent != (if (wake) 1 else 0)) {
            wakeword = if (wake) 1 else 0
            io.voiceWakeSent = wakeword
            // Read back what the switch did.
            io.settingsRequestPending = true
        }
        if (io.settingsRequestPending) {
            settings = true
            io.settingsRequestPending = false
        }
        if (io.voiceAbortPending) {
            abortVoice = true
            io.voiceAbortPending = false
        }
        if (io.micWanted && (!io.micStreamOpen
                || (io.lastMicPacketAtMs < io.micStartSentAtMs && now - io.micStartSentAtMs >= IoTimings.MIC_RETRY_MS))) {
            // Not yet asked on this link, a voice session took the recorder, or the ask was lost.
            micRc = RayNeoIoProtocol.VOICE_RC_START
            io.micStreamOpen = true
            io.micStartSentAtMs = now
        } else if (!io.micWanted && io.micStreamOpen) {
            micRc = RayNeoIoProtocol.VOICE_RC_STOP
            io.micStreamOpen = false
        }
        if (io.pageWanted && !fixedLayoutCreated && now - io.pageRequestSentAtMs >= IoTimings.PAGE_RETRY_MS) {
            ctrl = RayNeoIoProtocol.CTRL_PAGE_OPEN
            io.pageRequestSentAtMs = now
        } else if (!io.pageWanted && io.pageState == 1 && now - io.pageRequestSentAtMs >= IoTimings.PAGE_RETRY_MS) {
            ctrl = RayNeoIoProtocol.CTRL_PAGE_CLOSE
            io.pageRequestSentAtMs = now
        } else if (io.pageWanted && fixedLayoutCreated && now - io.lastKeepaliveAtMs >= IoTimings.KEEPALIVE_MS) {
            ctrl = RayNeoIoProtocol.CTRL_KEEPALIVE
            io.lastKeepaliveAtMs = now
        }
        if (now - io.lastStatusAtMs >= IoTimings.STATUS_MS) {
            status = true
            io.lastStatusAtMs = now
        }
        // Faceclaw decides when the display is dark (blanked frames); while it shows
        // content, keep the iO's screen on and at Faceclaw's brightness.
        val showing = fixedLayoutCreated && io.pageWanted && io.displayVisible && !shutdownRequested
        if (ioFirmwareOwnsBrightness) {
            // Repeating message 30 starts no fade; visible=1 is what holds the screen on.
            if (showing && now - io.lastBrightnessAtMs >= IoTimings.SCREEN_REFRESH_MS) {
                io.lastBrightnessAtMs = now
                brightnessSentLevel = -1
                enqueueBrightnessLocked()
            }
        } else {
            val level = RayNeoIoProtocol.brightnessLevel(brightnessPolicy.target)
            if (showing && (level != io.brightnessSentLevel || now - io.lastBrightnessAtMs >= IoTimings.SCREEN_REFRESH_MS)) {
                brightness = level
                io.brightnessSentLevel = level
                io.lastBrightnessAtMs = now
            }
        }
    }
    if (ctrl >= 0) {
        logDebug("RayNeo iO: control $ctrl")
        ioWriteControl(ctrl)
    }
    if (status) ioRequestStatus()
    if (brightness > 0) ioWriteLauncher(RayNeoIoProtocol.LAUNCHER_BRIGHTNESS, RayNeoIoProtocol.launcherBrightness(brightness))
    if (wakeword >= 0) {
        logLine("RayNeo iO: wake word " + (if (wakeword == 1) "on" else "off"))
        ioWriteLauncher(RayNeoIoProtocol.LAUNCHER_AI_VOICE_WAKEUP, RayNeoIoProtocol.launcherSetAiVoiceWakeup(wakeword == 1))
    }
    if (settings) ioWriteLauncher(RayNeoIoProtocol.LAUNCHER_GENERAL_SETTINGS, RayNeoIoProtocol.GENERAL_SETTINGS_REQUEST)
    if (abortVoice) {
        // As Glassly does: decline the stock session, then abort it, so its page goes.
        ioWriteFrame(RayNeoIoProtocol.BUSINESS_VOICE, RayNeoIoProtocol.voiceRc(RayNeoIoProtocol.VOICE_RC, RayNeoIoProtocol.VOICE_RC_STOP))
        ioWriteFrame(RayNeoIoProtocol.BUSINESS_VOICE, RayNeoIoProtocol.voiceRc(RayNeoIoProtocol.VOICE_ABORT, RayNeoIoProtocol.VOICE_RC_START))
    }
    if (micRc > 0) {
        logLine("RayNeo iO mic: " + (if (micRc == RayNeoIoProtocol.VOICE_RC_START) "open" else "close") + " the remote audio stream")
        ioWriteFrame(RayNeoIoProtocol.BUSINESS_VOICE, RayNeoIoProtocol.voiceRc(RayNeoIoProtocol.VOICE_STREAM_CONTROL, micRc))
    }
}

/**
 * The glasses' mic for a voice capture: the remote audio stream (16 kHz mono Opus packets to
 * [listener]), which needs IDENT_FLAG_MIC firmware. ioMaintain sends the open (and repeats it
 * while no packet comes); a voice session or a call can take the recorder meanwhile.
 */
internal fun GlassesSessionCore.ioStartAudioCapture(listener: FaceclawAudioPacketListener): Boolean {
    monitor.withLock {
        if (!running || !sessionReady || shutdownRequested) {
            logLine("skip RayNeo iO mic: session not ready")
            return false
        }
        if (io.ident?.micStream != true) {
            logLine("skip RayNeo iO mic: the firmware has no remote audio stream (IDENT flag 0x20)")
            return false
        }
        audioPacketListener = listener
        audioCaptureActive = true
        io.micWanted = true
        io.micStreamOpen = false
        io.micPackets = 0
    }
    interruptibleSleep.interrupt()
    return true
}

internal fun GlassesSessionCore.ioStopAudioCapture() {
    monitor.withLock {
        audioPacketListener = null
        audioCaptureActive = false
        io.micWanted = false
    }
    interruptibleSleep.interrupt()
}

/** Whether "Hey RayNeo" should reach Faceclaw (the launcher's wake-word switch). */
internal fun GlassesSessionCore.ioSetVoiceWakeEnabled(enabled: Boolean) {
    monitor.withLock { io.voiceWakeWanted = enabled }
    interruptibleSleep.interrupt()
}

/** Stop drawing and close the page, keeping the BLE link (the EvenHub suspend analogue). */
internal fun GlassesSessionCore.ioSuspend(): Boolean {
    monitor.withLock {
        if (!running || !sessionReady) return false
        shutdownRequested = true
        io.pageWanted = false
        io.pageRequestSentAtMs = 0
        clearAllMessagesLocked("RayNeo iO suspend")
        displayedFingerprint = ""
    }
    interruptibleSleep.interrupt()
    return true
}

/** Reopen the page; the drive loop resends the desired frame once it is open. */
internal fun GlassesSessionCore.ioResume(): Boolean {
    monitor.withLock {
        if (!running || !sessionReady) return false
        shutdownRequested = false
        io.pageWanted = true
        io.pageRequestSentAtMs = 0
        fixedLayoutCreated = false
        clearAllMessagesLocked("RayNeo iO resume")
        displayedFingerprint = ""
        imageRetryAfterMs = 0
    }
    interruptibleSleep.interrupt()
    return true
}

// ---------------------------------------------------------------------------------------------
// Inbound (BLE callback thread)

internal fun GlassesSessionCore.ioOnNotification(address: String, characteristicUuid: String, data: ByteArray) {
    if (RayNeoIoBle.NOTIFY_CHAR_UUID != characteristicUuid || !address.equals(rightAddress, ignoreCase = true)) return
    val frames = monitor.withLock { io.reassembler.ingest(data) }
    for (frame in frames) {
        when (frame.business) {
            RayNeoIoProtocol.BUSINESS_HANDSHAKE -> monitor.withLock {
                val version = RayNeoIoProtocol.parseVersionReply(frame.payload)
                if (version != null) io.versionReply = version
                else if (RayNeoIoProtocol.isGuestAuthReply(frame.payload)) io.authReply = frame.payload
                monitor.signalAll()
            }
            RayNeoIoProtocol.BUSINESS_LAUNCHER -> ioHandleLauncher(frame.payload)
            RayNeoIoProtocol.BUSINESS_VOICE -> ioHandleVoice(frame.payload)
            RayNeoIoProtocol.BUSINESS_OTA -> {
                val envelope = RayNeoIoProtocol.decodeEnvelope(frame.payload) ?: continue
                if (envelope.type != RayNeoIoProtocol.OTA_VERSION) continue
                val os = try { Json.parse(envelope.json).asObject()?.get("OsVersion").asString() } catch (_: Exception) { null }
                if (os != null) monitor.withLock {
                    io.osVersion = os
                    monitor.signalAll()
                }
            }
            RayNeoIoProtocol.BUSINESS_CFW -> ioHandleCfw(address, frame)
        }
    }
}

private fun GlassesSessionCore.ioHandleLauncher(payload: ByteArray) {
    val envelope = RayNeoIoProtocol.decodeEnvelope(payload) ?: return
    val screen = RayNeoIoProtocol.screenStatusFromLauncherJson(envelope.json)
    if (screen >= 0) {
        val changed = monitor.withLock {
            val was = io.screenStatus
            io.screenStatus = screen
            // Woken by the wearer (or the timeout ran out): re-assert promptly if Faceclaw is showing.
            if (screen == 0) io.lastBrightnessAtMs = 0
            was != screen
        }
        if (changed) logLine("RayNeo iO screen " + (if (screen == 1) "on" else "off"))
        return
    }
    val battery = RayNeoIoProtocol.batteryFromLauncherJson(envelope.json)
    if (battery < 0) {
        // Replies to our commands and settings (the wake word's among them): logged for now.
        logLine("RayNeo iO launcher type " + envelope.type + ": " + envelope.json.take(400))
        return
    }
    val charging = if (envelope.json.contains("\"isCharging\":true")) 1 else if (envelope.json.contains("\"isCharging\":false")) 0 else -1
    var changed = false
    monitor.withLock {
        lastIncomingAtMs = now()
        if (battery != headsetBattery || (charging >= 0 && charging != headsetCharging)) {
            headsetBattery = battery
            if (charging >= 0) headsetCharging = charging
            changed = true
        }
    }
    if (changed) emitBatteryState(headsetBattery, headsetCharging)
}

/** The voice channel (business 13): mic packets, and the stock assistant's wake word. */
private fun GlassesSessionCore.ioHandleVoice(payload: ByteArray) {
    val envelope = RayNeoIoProtocol.decodeEnvelope(payload) ?: return
    when (envelope.type) {
        RayNeoIoProtocol.VOICE_STREAM_AUDIO, RayNeoIoProtocol.VOICE_AUDIO -> {
            val opus = envelope.binary ?: return
            val arrivalMs = now()
            var first = false
            val listener = monitor.withLock {
                lastIncomingAtMs = arrivalMs
                io.micPackets++
                first = io.micPackets == 1L
                io.lastMicPacketAtMs = arrivalMs
                if (audioCaptureActive) audioPacketListener else null
            }
            if (first) logLine("RayNeo iO mic: first audio packet (type " + envelope.type + ", " + opus.size + " bytes)")
            if (listener == null) return
            try {
                listener.onAudioPacket(opus, "R", arrivalMs)
            } catch (t: Throwable) {
                logLine("RayNeo iO mic packet listener failed: " + safeMessage(t))
            }
        }
        RayNeoIoProtocol.VOICE_WAKE -> {
            // The stock assistant heard "Hey RayNeo" and opened its session. Faceclaw's own
            // assistant answers instead: end the stock one, and report the wake word as the
            // G2's (sid 0x07 EVEN_AI_WAKE_UP), which the dashboard routes to its wake action.
            var repeat = false
            val forward = monitor.withLock {
                val now = now()
                io.voiceAbortPending = true
                lastIncomingAtMs = now
                lastConnectionOrInputAtMs = now
                repeat = io.lastVoiceWakeAtMs != 0L && now - io.lastVoiceWakeAtMs < IoTimings.VOICE_WAKE_DEDUP_MS
                val wanted = io.voiceWakeWanted == true && sessionReady
                if (wanted && !repeat) {
                    io.lastVoiceWakeAtMs = now
                    ioReclaimPageOnInputLocked()
                }
                wanted && !repeat
            }
            interruptibleSleep.interrupt()
            logLine("RayNeo iO: voice wake " + envelope.json + when {
                forward -> ""
                repeat -> " (same phrase as the last wake)"
                else -> " (not forwarded: wake word off)"
            })
            if (!forward) return
            val event = G2Event("even-ai", "", BleProtocol.EVEN_AI_STATUS_WAKE_UP, 0, 0)
            val frameId = frameTimings.startFrame("input:even-ai wake")
            frameTimings.log(frameId, "wake word from the RayNeo iO's voice channel")
            emitRingEvent(event, frameId)
        }
        RayNeoIoProtocol.VOICE_EXITED -> {
            // A voice session that held the recorder ended: ask for the stream again.
            val reopen = monitor.withLock {
                if (io.micWanted) io.micStreamOpen = false
                io.micWanted
            }
            if (reopen) interruptibleSleep.interrupt()
            logLine("RayNeo iO: voice session exited " + envelope.json + (if (reopen) "; reopening the mic stream" else ""))
        }
        RayNeoIoProtocol.VOICE_VAD -> logDebug("RayNeo iO: voice VAD " + envelope.json)
        else -> logLine("RayNeo iO: voice message type " + envelope.type + " " + envelope.json.take(160))
    }
}

private fun GlassesSessionCore.ioHandleCfw(address: String, frame: RayNeoIoProtocol.Frame) {
    val payload = frame.payload
    if (payload.isEmpty()) return
    when (payload[0].toInt() and 255) {
        RayNeoIoProtocol.KIND_ACK, RayNeoIoProtocol.KIND_NACK -> {
            val ack = RayNeoIoProtocol.parseCfwAck(payload) ?: return
            monitor.withLock {
                acceptCfwAcksLocked(address, arrayOf(ack), frame.messageNumber and 255, payload)
            }
            interruptibleSleep.interrupt()
        }
        RayNeoIoProtocol.KIND_IDENT -> monitor.withLock {
            io.ident = RayNeoIoProtocol.parseIdent(payload)
            monitor.signalAll()
        }
        RayNeoIoProtocol.KIND_ALS -> {
            val body = RayNeoIoProtocol.parseAlsReport(payload) ?: return
            monitor.withLock {
                lastIncomingAtMs = now()
                brightnessPolicy.sample(body, lastIncomingAtMs)
            }
            emitAmbientLight(body)
            interruptibleSleep.interrupt()
        }
        RayNeoIoProtocol.KIND_PAGE -> ioHandlePage(payload)
        RayNeoIoProtocol.KIND_GESTURE -> ioHandleGesture(RayNeoIoProtocol.parseGesture(payload) ?: return)
        else -> logDebug("RayNeo iO: CFW reply kind " + (payload[0].toInt() and 255) + " " + hex(payload.copyOf(minOf(payload.size, 24))))
    }
}

private fun GlassesSessionCore.ioHandlePage(payload: ByteArray) {
    val state = RayNeoIoProtocol.parsePageState(payload)
    val reason = if (payload.size >= 3) payload[2].toInt() and 255 else 0
    var lost = false
    monitor.withLock {
        io.pageState = state
        io.pageReason = reason
        io.pageReplies++
        lastIncomingAtMs = now()
        if (state == 1) {
            if (io.pageWanted && !fixedLayoutCreated && sessionReady) {
                // (Re)opened: the drive loop resends the desired frame from scratch.
                fixedLayoutCreated = true
                displayedFingerprint = ""
                imageRetryAfterMs = 0
                io.lastKeepaliveAtMs = now()
                io.lastBrightnessAtMs = 0
                ioResetBrightnessLocked()
            }
        } else if (state == 0 && fixedLayoutCreated) {
            // The page closed under us (lease, the wearer's long press): the firmware freed
            // this session's resources, so start over once it reopens.
            lost = true
            fixedLayoutCreated = false
            clearAllMessagesLocked("RayNeo iO page closed (reason $reason)")
            displayedFingerprint = ""
            if (reason == IoTimings.PAGE_REASON_USER) io.pageWanted = false
            io.pageRequestSentAtMs = now()
        }
        monitor.signalAll()
    }
    if (lost) logLine("RayNeo iO page closed by the glasses (reason $reason)")
    interruptibleSleep.interrupt()
}

/**
 * The wearer gave input (a temple touch, or the R1's) after closing our page:
 * take it back. Caller holds `monitor`.
 */
internal fun GlassesSessionCore.ioReclaimPageOnInputLocked() {
    if (io.pageWanted || !sessionReady) return
    io.pageWanted = true
    shutdownRequested = false
    io.pageRequestSentAtMs = 0
}

private fun GlassesSessionCore.ioHandleGesture(gesture: RayNeoIoProtocol.Gesture) {
    val event: G2Event? = when (gesture.eventType) {
        // Same numbering as the G2's OsEventTypeList; head up wakes like the G2 CFW's forward.
        BleProtocol.EVENT_HEAD_UP -> G2Event("display-wake", "", BleProtocol.EVENT_HEAD_UP, BleProtocol.EVENT_SOURCE_GLASSES_R, 0)
        BleProtocol.EVENT_HEAD_DOWN -> null
        else -> G2Event("sys-event", "", gesture.eventType, BleProtocol.EVENT_SOURCE_GLASSES_R, 0)
    }
    monitor.withLock {
        lastIncomingAtMs = now()
        if (event != null) lastConnectionOrInputAtMs = lastIncomingAtMs
        if (event != null && "sys-event" == event.kind) ioReclaimPageOnInputLocked()
    }
    logLine("RayNeo iO gesture type=" + gesture.eventType + " source=" + gesture.source + (if (event == null) " (ignored)" else ""))
    if (event == null) return
    val frameId = frameTimings.startFrame("input:" + event.kind + " type=" + event.eventType + " src=" + event.eventSource)
    frameTimings.log(frameId, "input event decoded from RayNeo iO notification")
    emitRingEvent(event, frameId)
}
