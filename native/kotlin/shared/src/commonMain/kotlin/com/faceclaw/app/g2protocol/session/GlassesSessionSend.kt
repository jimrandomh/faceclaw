package com.faceclaw.app

import com.faceclaw.app.GlassesSessionCore.Companion.DASHBOARD_TILE
import com.faceclaw.app.GlassesSessionCore.Companion.COMPASS_MIN_CHANGE_DEGREES
import com.faceclaw.app.GlassesSessionCore.Companion.COMPASS_REPORT_INTERVAL_MS
import com.faceclaw.app.GlassesSessionCore.Companion.FACECLAW_WAKE_LEASE_RENEW_MS
import com.faceclaw.app.GlassesSessionCore.Companion.safeMessage
import com.faceclaw.app.GlassesSessionCore.Companion.timestamp

/*
 * GlassesSessionCore, part 2: the send scheduler (driveSession), the CFW/EvenHub
 * ack window, the desired-image pipeline and the message-queue bookkeeping.
 * Everything here runs on the worker thread or under `monitor` (functions
 * suffixed Locked require the caller to hold it).
 */

internal fun GlassesSessionCore.driveSession(): Long {
    while (true) {
        // Run on the sender thread, outside `monitor`: Bluetooth API calls can
        // wait on the global GATT lock, and callbacks need the session lock.
        // Keep negotiation outside the timed stream. A fixed settling period
        // is only an experiment boundary; HCI must confirm actual parameters.
        var linkMode = -1
        var benchmarkAddresses: Array<String>? = null
        monitor.withLock {
            if (benchmarkActive && benchmarkLinkPending) {
                benchmarkLinkPending = false
                linkMode = benchmarkLinkMode
                benchmarkAddresses = arrayOf(leftAddress, rightAddress)
            }
        }
        val addressesToPrepare = benchmarkAddresses
        if (addressesToPrepare != null) {
            for (address in addressesToPrepare) {
                try {
                    link.prepareBenchmarkLink(address, linkMode)
                } catch (error: RuntimeException) {
                    logLine("benchmark link request failed: " + safeMessage(error))
                }
            }
            monitor.withLock {
                // Cancellation/new-run races leave the new run pending; its
                // own preparation will replace this deadline before sending.
                benchmarkReadyAtMs = now() + 1_000
            }
        }
        var messageToWrite: OutboundMessage? = null
        var messageToPrewrite: OutboundMessage? = null
        val now = now()

        maybeFinishNoChangeDesiredFrame()

        monitor.withLock {
            drainCfwAcknowledgementsLocked()
            if (cfwCleanupDelivered) {
                /* Successful mode 11 must be the last Faceclaw write. Drop
                 * anything a late external producer attempted to enqueue
                 * while DashboardController was closing the transport. */
                clearPendingMessagesLocked("after CFW cleanup")
                return 250
            }
            if (sessionReady
                    && now - lastFaceclawFramebufferLeaseQueuedAtMs >= FACECLAW_WAKE_LEASE_RENEW_MS
                    && !hasPendingOrInflightKindLocked("framebuffer-lease-control")) {
                enqueueFaceclawFramebufferControlLocked(
                    BleProtocol.FACECLAW_FB_OP_ACQUIRE,
                    false
                )
            }
            if (faceclawWakeLeaseEnabled
                    && sessionReady
                    && now - lastFaceclawWakeLeaseQueuedAtMs >= FACECLAW_WAKE_LEASE_RENEW_MS
                    && !hasPendingOrInflightKindLocked("wake-lease-control")) {
                enqueueFaceclawWakeControlLocked(
                    BleProtocol.FACECLAW_WAKE_OP_ACQUIRE,
                    0,
                    false
                )
            }
            if (!inFlightMessages.isEmpty()) {
                val oldest = inFlightMessages.firstOrNull()
                val replay = CfwMessageWindow.replayWindow(inFlightMessages, now)
                if (!replay.isEmpty()) {
                    logLine("CFW recovery: replay " + replay.size
                            + " unresolved message(s) from id=" + replay[0].magic)
                    for (candidate in replay) {
                        if (candidate.cfwRetries >= CfwMessageWindow.MAX_RETRIES) {
                            handleTransportFailure("CFW recovery retry limit")
                            return 0
                        }
                        logLine("CFW replay id=" + candidate.magic + " label=" + candidate.label
                                + " cause=" + (if (candidate.cfwRetryPending) "NACK"
                                    else if (candidate.cfwAckLenses == CfwTransport.BOTH) "ordered tail" else "missing ACK")
                                + " ackedLenses=" + candidate.cfwAckLenses
                                + " ageMs=" + (now - candidate.sentAtMs))
                        inFlightMessages.remove(candidate)
                        magicPool.release(candidate.sid, candidate.magic, candidate.label, "CFW replay")
                        candidate.prepareCfwReplay(magicPool.allocate())
                    }
                    for (i in replay.indices.reversed()) pendingMessages.addFirst(replay[i])
                    return 0
                }
                if (oldest != null && oldest.ackDeadlineAtMs <= now) {
                    logLine("message timed out: " + oldest.label)
                    inFlightMessages.removeFirst()
                    logLine("message timed out: " + oldest.label + " sid=" + oldest.sid
                            + " id=" + oldest.magic + " ackedLenses=" + oldest.cfwAckLenses
                            + " ageMs=" + (now - oldest.sentAtMs))
                    magicPool.release(oldest.sid, oldest.magic, oldest.label, "timeout")
                    if (oldest.sid == CfwTransport.SID)
                        cfwTransports[if (oldest.isLeftArmMessage) 0 else 1].reset()
                    handleAckTimeoutLocked(oldest)
                    return 0
                }
                if (connectionOptions.WINDOW_SIZE <= 1
                        && sessionReady
                        && prewrittenMessage == null
                        && !pendingMessages.isEmpty()
                        && canPrewriteCandidate(pendingMessages.firstOrNull())
                        && !shouldBlockPrewriteForHeartbeatLocked(now)) {
                    // Only the serial (window==1) path pre-sends the all-but-last
                    // packet; with a real window we just send the next message fully.
                    messageToPrewrite = pendingMessages.firstOrNull()
                }
            }

            if (chargingMode) {
                // Glasses are in the case: no display traffic, only battery
                // polls (which also detect the end of charging).
                finishDesiredFrameLocked("discarded: glasses charging")
                if (sessionReady && inFlightMessages.isEmpty() && !pendingMessages.isEmpty()) {
                    messageToWrite = pendingMessages.removeFirst()
                    logLine("sending pending message (charging): " + messageToWrite!!.label)
                } else if (sessionReady && pendingMessages.isEmpty() && inFlightMessages.isEmpty()
                        && now - lastBatteryRefreshAtMs >= ConnectionOptions.CHARGING_BATTERY_POLL_MS) {
                    logLine("Writing charging-mode battery poll")
                    messageToWrite = createBatteryQueryMessageLocked()
                    lastBatteryRefreshAtMs = now
                } else {
                    return 1_000
                }
            } else {
                if (messageToPrewrite == null
                        && !shutdownRequested
                        && !fixedLayoutCreated
                        && pendingMessages.isEmpty()
                        && inFlightMessages.isEmpty()) {
                    logLine("enqueueing create layout")
                    enqueueCreateLayoutLocked()
                } else if (messageToPrewrite != null) {
                    // Prewrite outside the lock; the logical message remains pending until
                    // its final BLE frame is sent after the current protocol ACK.
                }
                if (messageToPrewrite == null && !shutdownRequested && fixedLayoutCreated
                        && (if (firmwareDebugFlagsEnabled) 2 else 1) != firmwareDebugFlagsLastSent
                        && pendingMessages.isEmpty() && inFlightMessages.isEmpty()) {
                    logLine("enqueueing firmware debug flags " + (if (firmwareDebugFlagsEnabled) "show" else "hide"))
                    enqueueFirmwareDebugFlagsLocked()
                }

                if (messageToPrewrite == null && !shutdownRequested && fixedLayoutCreated
                        && (if (compassOwners.isEmpty()) 0 else 1) != compassControlLastSent
                        && pendingMessages.isEmpty() && inFlightMessages.isEmpty()) {
                    val wanted = compassOwners.isNotEmpty()
                    logLine("enqueueing compass " + (if (wanted) "enable" else "disable"))
                    enqueueCompassControlLocked(false, wanted)
                }

                if (benchmarkActive) {
                    maintainBenchmarkLocked(now)
                }
                if (!benchmarkActive) maintainBrightnessLocked(now)

                // Up to WINDOW_SIZE messages may be in flight at once (full
                // pipelining); a slot frees when an ack arrives. An active
                // bandwidth benchmark measures its own selected window instead.
                val windowHasRoom = inFlightMessages.size <
                        maxOf(1, if (benchmarkActive) benchmarkWindowSize else connectionOptions.WINDOW_SIZE)
                // A frame ready to send right now: don't inject a fresh
                // heartbeat in front of it (the image's own ack resets the
                // firmware heartbeat timer, so the heartbeat is redundant).
                // "Ready" covers both a fresh composite still to be planned
                // and a planned image already queued but not yet written --
                // enqueueing sets lastEnqueuedFingerprint, so testing only
                // the desired fingerprint left the queued-but-unwritten
                // window unprotected and a heartbeat that came due there
                // cost the frame a full ack round trip (measured 124ms on
                // frame#232 of the 2026-08-20 02:27 capture).
                // A benchmark run counts as image traffic here for the same
                // reason: its acks reset the firmware heartbeat timer, so a
                // fresh heartbeat in front of it is redundant.
                val imageWaiting = !shutdownRequested && fixedLayoutCreated
                        && !hasPendingOrInflightKindLocked("heartbeat")
                        && (benchmarkActive
                            || (now >= imageRetryAfterMs
                                && (hasPendingImageLocked()
                                    || desiredFingerprintSnapshot() != lastEnqueuedFingerprint)))
                noteImageStallLocked(now, windowHasRoom)
                if (messageToPrewrite == null && handleHeartbeat(imageWaiting)) {
                    return ConnectionOptions.IDLE_SLEEP_MS.toLong()
                }

                if (messageToPrewrite == null && sessionReady && windowHasRoom && !pendingMessages.isEmpty()
                        && CfwMessageWindow.canSend(inFlightMessages, pendingMessages.firstOrNull()!!)) {
                    messageToWrite = pendingMessages.removeFirst()
                    logLine("sending pending message: " + messageToWrite!!.label)
                } else if (messageToPrewrite == null && !shutdownRequested && !benchmarkActive
                        && fixedLayoutCreated
                        && windowHasRoom && !hasPendingImageLocked()
                        && now >= imageRetryAfterMs
                        && desiredFingerprintSnapshot() != lastEnqueuedFingerprint) {
                    // Enqueue the next frame's delta against lastEnqueuedPacked
                    // (what the shadow will be), so it can pipeline behind an
                    // image still awaiting its ack.
                    logLine("Enqueued image update")
                    enqueueDesiredImageLocked()
                    return 0
                } else if (messageToPrewrite == null && shouldPollBatteryLocked(now)) {
                    logLine("Writing battery query")
                    messageToWrite = createBatteryQueryMessageLocked()
                    lastBatteryRefreshAtMs = now
                } else if (messageToPrewrite == null && (!pendingMessages.isEmpty() || !inFlightMessages.isEmpty())) {
                    return ConnectionOptions.IDLE_SLEEP_MS.toLong()
                } else if (messageToPrewrite == null) {
                    return 250
                }
            }
        }

        val prewrite = messageToPrewrite
        if (prewrite != null) {
            if (prewriteMessage(prewrite)) {
                return 0
            }
            return ConnectionOptions.IDLE_SLEEP_MS.toLong()
        }

        val write = messageToWrite!!
        if (!writeMessage(write)) {
            monitor.withLock {
                if (removePreparedMessageLocked(write) || write.magic == 0) {
                    handleTransportFailure("write failed")
                }
            }
            return 0
        }
    }
}

/**
 * If the desired image already matches what the glasses display, nothing will
 * ever be enqueued for it, so finish its frame now (otherwise the TS side
 * would block on it until its backpressure timeout).
 */
internal fun GlassesSessionCore.maybeFinishNoChangeDesiredFrame() {
    var frameIdToFinish = 0
    monitor.withLock {
        desiredTilesLock.locked {
            if (desiredFrameId != 0 && lastEnqueuedFingerprint.isNotEmpty() && desiredFingerprint == lastEnqueuedFingerprint) {
                frameIdToFinish = desiredFrameId
                desiredFrameId = 0
            }
        }
    }
    if (frameIdToFinish != 0) {
        finishFrame(frameIdToFinish, "discarded: no change from displayed image")
    }
}

internal fun GlassesSessionCore.shouldBlockPrewriteForHeartbeatLocked(now: Long): Boolean {
    if (shutdownRequested || !fixedLayoutCreated) {
        return false
    }
    return hasPendingOrInflightKindLocked("heartbeat")
            || now - lastHeartbeatAckedAtMs >= ConnectionOptions.HEARTBEAT_READY_MS
}

internal fun GlassesSessionCore.canPrewriteCandidate(message: OutboundMessage?): Boolean {
    if (message == null || message.sid == CfwTransport.SID || !message.isLeftArmMessage) {
        return false
    }
    if ("image" != message.kind) {
        return false
    }
    return message.message.size + 2 > 232
}

internal fun GlassesSessionCore.handleHeartbeat(imageWaiting: Boolean): Boolean {
    val now = now()
    val heartbeatEligible = !shutdownRequested && fixedLayoutCreated
    val heartbeatPending = heartbeatEligible && hasPendingOrInflightKindLocked("heartbeat")
    val heartbeatElapsedMs = now - lastHeartbeatAckedAtMs
    val heartbeatReady = heartbeatEligible && heartbeatElapsedMs >= ConnectionOptions.HEARTBEAT_READY_MS
    val heartbeatUrgent = heartbeatEligible && heartbeatElapsedMs >= ConnectionOptions.HEARTBEAT_URGENT_MS

    if (heartbeatReady && !heartbeatPending && inFlightMessages.isEmpty()) {
        if (imageWaiting && !heartbeatUrgent) {
            // Defer to the waiting frame: sending it now satisfies the
            // firmware heartbeat deadline (its ack resets the timer), and
            // the heartbeat still fires once we reach the URGENT threshold
            // if rendering goes quiet again. Preserves the pending-heartbeat
            // inter-lens-sync invariant below (that path is untouched).
            return false
        }
        logLine("Writing heartbeat")
        val heartbeatMessage = createHeartbeatMessage()
        lastHeartbeatSentAtMs = now
        writeMessage(heartbeatMessage)
        return true
    } else if (heartbeatUrgent) {
        return true
    } else if (heartbeatPending) {
        // Don't send other message types while a heartbeat is pending because that
        // can lead to inter-lens sync issues
        return true
    }

    return false
}

internal fun GlassesSessionCore.createHeartbeatMessage(): OutboundMessage {
    val message = messageBuilder.heartbeat()
    message.onAck = MessageCallback {
        monitor.withLock {
            lastHeartbeatAckedAtMs = now()
        }
    }
    message.onTimeout = MessageCallback {
        // If a heartbeat fails to ack and we're over the heartbeat deadline, assume the connection is failed and reconnect.
        // Otherwise ignore it, which will cause a retransmission attempt.
        val isPastDeadline: Boolean
        monitor.withLock {
            isPastDeadline = now() - lastHeartbeatSentAtMs >= ConnectionOptions.HEARTBEAT_FAILURE_DEADLINE_MS
        }
        if (isPastDeadline) {
            handleTransportFailure("heartbeat ack timeout")
        }
    }
    return message
}

internal fun GlassesSessionCore.writeMessage(message: OutboundMessage): Boolean {
    val now = now()
    message.writeStartedAtMs = now
    message.sentAtMs = now
    message.ackDeadlineAtMs = now + message.ackTimeoutMs + ConnectionOptions.WRITE_TIMEOUT_MS
    if (message.magic != 0) {
        monitor.withLock {
            inFlightMessages.addLast(message)
        }
    }
    if (message.imageUpdateId > 0 && message.imageMessageNumber == 1) {
        monitor.withLock {
            val stats = imageUpdateStats[message.imageUpdateId]
            if (stats != null && stats.firstWriteStartedAtMs <= 0) {
                stats.firstWriteStartedAtMs = now
            }
        }
    }

    val writeAddress = if (message.isLeftArmMessage) leftAddress else rightAddress
    val frames: List<ByteArray>
    if (prewrittenMessage != null && prewrittenMessage !== message) {
        if (!spoilPrewrittenMessage("before " + message.label)) {
            return false
        }
    }
    if (prewrittenMessage === message) {
        frames = listOf(prewrittenFrames[prewrittenFrames.size - 1])
        prewrittenMessage = null
        prewrittenFrames = emptyList()
    } else if (message.sid == CfwTransport.SID) {
        if (message.cfwRetries > 0) cfwTransports[if (message.isLeftArmMessage) 0 else 1].reset()
        frames = cfwTransports[if (message.isLeftArmMessage) 0 else 1].encode(
                message.message, message.magic, CfwTransport.BOTH,
                link.negotiatedMtu(writeAddress))
    } else {
        frames = BleProtocol.framePb(
            message.message,
            message.sid,
            message.flag,
            nextTransportSeq++
        )
    }
    val result = link.writeFrames(
        writeAddress,
        BleProtocol.WRITE_CHAR_UUID,
        frames,
        ConnectionOptions.WRITE_MODE,
        ConnectionOptions.WRITE_TIMEOUT_MS
    )

    monitor.withLock {
        val sentAtMs = now()
        message.sentAtMs = sentAtMs
        message.ackDeadlineAtMs = sentAtMs + message.ackTimeoutMs
        logImageUpdateSendLandmarkLocked(message)
        val onSent = message.onSent
        if (result && onSent != null) {
            onSent.run()
            monitor.signalAll()
        }
    }

    if (!result && message.sid == CfwTransport.SID)
        cfwTransports[if (message.isLeftArmMessage) 0 else 1].reset()
    return result
}

internal fun GlassesSessionCore.prewriteMessage(message: OutboundMessage): Boolean {
    if (prewrittenMessage === message) {
        return true
    }
    if (prewrittenMessage != null && !spoilPrewrittenMessage("before prewrite " + message.label)) {
        return false
    }
    if (!canPrewriteCandidate(message)) {
        return false
    }

    val frames: List<ByteArray> = BleProtocol.framePb(
        message.message,
        message.sid,
        message.flag,
        nextTransportSeq++
    )
    if (frames.size <= 1) {
        return false
    }

    val writeAddress = if (message.isLeftArmMessage) leftAddress else rightAddress
    val prefixFrames = frames.subList(0, frames.size - 1)
    val result = link.writeFrames(
        writeAddress,
        BleProtocol.WRITE_CHAR_UUID,
        prefixFrames,
        ConnectionOptions.WRITE_MODE,
        ConnectionOptions.WRITE_TIMEOUT_MS
    )
    if (!result) {
        return false
    }

    prewrittenMessage = message
    prewrittenFrames = frames.toList()
    logLine("prewrote " + message.label + " frames=" + prefixFrames.size + "/" + frames.size)
    return true
}

internal fun GlassesSessionCore.spoilPrewrittenMessage(reason: String): Boolean {
    val message = prewrittenMessage
    if (message == null || prewrittenFrames.isEmpty()) {
        prewrittenMessage = null
        prewrittenFrames = emptyList()
        return true
    }
    val finalFrame = prewrittenFrames[prewrittenFrames.size - 1].copyOf()
    if (finalFrame.size > 8) {
        finalFrame[finalFrame.size - 1] = (finalFrame[finalFrame.size - 1].toInt() xor 0xff).toByte()
    }
    prewrittenMessage = null
    prewrittenFrames = emptyList()

    val writeAddress = if (message.isLeftArmMessage) leftAddress else rightAddress
    logLine("spoiling prewritten " + message.label + ": " + reason)
    return link.writeFrames(
        writeAddress,
        BleProtocol.WRITE_CHAR_UUID,
        listOf(finalFrame),
        ConnectionOptions.WRITE_MODE,
        ConnectionOptions.WRITE_TIMEOUT_MS
    )
}

internal fun GlassesSessionCore.removePreparedMessageLocked(message: OutboundMessage?): Boolean {
    if (message == null || message.magic == 0) {
        return false
    }
    val iterator = inFlightMessages.iterator()
    while (iterator.hasNext()) {
        if (iterator.next() === message) {
            iterator.remove()
            magicPool.release(message.sid, message.magic, message.label, "write failed")
            return true
        }
    }
    return false
}

/** Also drain on the worker: a clear/timeout may have removed a blocking
 * head since the last notification. Fully ACKed controls must never reach
 * the generic timeout path just because no further BLE reply arrived. */
internal fun GlassesSessionCore.drainCfwAcknowledgementsLocked() {
    while (true) {
        val first = CfwMessageWindow.acknowledgedHead(inFlightMessages) ?: return
        lastAckAtMs = now()
        resolveAckLocked(first, first.ackPayload)
    }
}

internal fun GlassesSessionCore.resolveAckLocked(sid: Int, magic: Int, pb: ByteArray?) {
    val iterator = inFlightMessages.iterator()
    while (iterator.hasNext()) {
        val message = iterator.next()
        if (message.sid == sid && message.magic == magic) {
            resolveAckLocked(message, pb)
            return
        }
    }
    recordUnexpectedAckLocked(sid, magic)
}

internal fun GlassesSessionCore.resolveAckLocked(message: OutboundMessage, pb: ByteArray?) {
    logLine("Got ACK for " + message.label + "(sid=" + message.sid + ", id=" + message.magic + ")")
    inFlightMessages.remove(message)
    message.ackPayload = pb?.copyOf() ?: ByteArray(0)
    magicPool.release(message.sid, message.magic, message.label, "ack")
    val onAck = message.onAck
    if (onAck != null) {
        onAck.run()
    }
    consecutiveAckTimeouts = 0
    // onAck may have just satisfied a waiter blocked on the monitor (e.g.
    // awaitEvenHubSessionReady polling fixedLayoutCreated/displayedFingerprint
    // after a create-layout or image ack). Without this, that waiter only
    // notices on its own up-to-100ms poll tick, adding avoidable latency to
    // every EvenHub wake. Always called with the monitor held (see call site).
    monitor.signalAll()
}

internal fun GlassesSessionCore.logImageUpdateSendLandmarkLocked(message: OutboundMessage) {
    if (message.imageUpdateId <= 0) {
        return
    }
    val stats = imageUpdateStats[message.imageUpdateId]
    val frameId = if (stats == null) 0 else stats.frameId
    if (message.imageMessageNumber == 1) {
        if (stats != null && stats.firstWriteStartedAtMs <= 0) {
            stats.firstWriteStartedAtMs = if (message.writeStartedAtMs > 0) message.writeStartedAtMs else message.sentAtMs
        }
        frameTimings.log(frameId, "first bluetooth packet sent")
        logImageUpdateLandmarkLocked("first bluetooth message sent", message, message.sentAtMs)
    }
    if (message.imageMessageNumber == message.imageMessageCount) {
        frameTimings.log(frameId,
            "last bluetooth packet sent (message " + message.imageMessageNumber + "/" + message.imageMessageCount + ")")
        logImageUpdateLandmarkLocked("last bluetooth message sent", message, message.sentAtMs)
    }
}

internal fun GlassesSessionCore.logImageUpdateAckLandmarkLocked(message: OutboundMessage) {
    if (message.imageUpdateId <= 0 || message.imageMessageNumber != message.imageMessageCount) {
        return
    }
    val ackedAtMs = now()
    link.recordDisplayFrameSent()
    val stats = imageUpdateStats.remove(message.imageUpdateId)
    if (stats != null && stats.firstWriteStartedAtMs > 0) {
        emitFrameMetrics(stats.paintMs, maxOf(0L, ackedAtMs - stats.firstWriteStartedAtMs).toInt(), stats.tileCount)
    }
    if (stats != null) {
        finishFrame(stats.frameId, "sent")
    }
    logImageUpdateLandmarkLocked("last bluetooth message acked", message, ackedAtMs)
}

/** Remove the stats entry for an image update that will not complete, finishing its frame. */
internal fun GlassesSessionCore.discardImageUpdateStatsLocked(imageUpdateId: Int, reason: String) {
    if (imageUpdateId <= 0) {
        return
    }
    val stats = imageUpdateStats.remove(imageUpdateId)
    if (stats != null) {
        finishFrame(stats.frameId, "discarded: $reason")
    }
}

internal fun GlassesSessionCore.logImageUpdateLandmarkLocked(event: String, message: OutboundMessage, elapsedMs: Long) {
    logLine("image update#" + message.imageUpdateId + " " + event
            + " at " + timestamp(elapsedMs)
            + " message=" + message.imageMessageNumber + "/" + message.imageMessageCount
            + " label=" + message.label)
}

internal fun GlassesSessionCore.enqueueCreateLayoutLocked() {
    brightnessSentVisible = null
    brightnessSentLevel = -1
    brightnessAlsStartedAt = -2000
    brightnessPolicy.resetSamples()
    // New session: re-assert the firmware-debug-flags overlay once
    // the layout is ready (the mode-7 send is gated on this having reset).
    firmwareDebugFlagsLastSent = -1
    val message = messageBuilder.createLayout()
    message.onAck = MessageCallback {
        startupProbePending = false
        clearMessagesOfKindLocked("startup-text-probe")
        fixedLayoutCreated = true
        displayedFingerprint = ""
    }
    message.onTimeout = MessageCallback {
        if (startupProbePending) {
            logLine("create layout timed out while startup text probe is pending")
            if (hasPendingOrInflightKindLocked("startup-text-probe")) {
                return@MessageCallback
            }
            startupProbePending = false
        }
        handleTransportFailure("ack timeout")
    }
    pendingMessages.addLast(message)
    logLine("queue create layout")
}

internal fun GlassesSessionCore.enqueueStartupProbeLocked() {
    enqueueCreateLayoutLocked()

    val message = messageBuilder.startupTextProbe()
    message.onAck = MessageCallback {
        startupProbePending = false
        clearMessagesOfKindLocked("create-layout")
        fixedLayoutCreated = true
        displayedFingerprint = ""
        logLine("existing dashboard layout accepted text probe")
    }
    message.onTimeout = MessageCallback {
        startupProbePending = false
        if (hasPendingOrInflightKindLocked("create-layout")) {
            return@MessageCallback
        }
        handleTransportFailure("ack timeout")
    }
    pendingMessages.addLast(message)
    startupProbePending = true
    logLine("queue startup text probe")
}

/**
 * Send the CFW mode-7 diagnostic-flag control op through the private stream:
 * [7][2] to show the on-glasses debug-flag overlay, [7][1] to hide it. Uses the
 * arbitrary-payload custom path (no bmp/dedup/frame-timing interaction).
 */
internal fun GlassesSessionCore.enqueueFirmwareDebugFlagsLocked() {
    val show = firmwareDebugFlagsEnabled
    val sub = if (show) 2 else 1
    val payload = byteArrayOf(CFW_MSG_DIAGNOSTICS.toByte(), sub.toByte())
    val message = messageBuilder.imagePayload(
        DASHBOARD_TILE, nextMapSessionId(), payload,
        "fw-debug-flags " + (if (show) "show" else "hide"),
        connectionOptions.sendImagesToLeft)
    pendingMessages.addLast(message)
    firmwareDebugFlagsLastSent = sub
    logLine("queue firmware debug flags " + (if (show) "show" else "hide"))
}

/**
 * Send CFW image-handler mode 10. Enable uses the configurable form
 * [10][2][interval-ms LE16][minimum-change-degrees LE16]; disable remains [10][0].
 */
internal fun GlassesSessionCore.enqueueCompassControlLocked(priority: Boolean, enable: Boolean) {
    val sentState = if (enable) 1 else 0
    val payload = if (enable)
        byteArrayOf(
            CFW_MSG_COMPASS.toByte(),
            2.toByte(),
            (COMPASS_REPORT_INTERVAL_MS and 0xff).toByte(),
            ((COMPASS_REPORT_INTERVAL_MS shr 8) and 0xff).toByte(),
            (COMPASS_MIN_CHANGE_DEGREES and 0xff).toByte(),
            ((COMPASS_MIN_CHANGE_DEGREES shr 8) and 0xff).toByte(),
        )
    else
        byteArrayOf(CFW_MSG_COMPASS.toByte(), 0.toByte())
    val message = messageBuilder.imagePayload(
        "compass-control",
        DASHBOARD_TILE,
        nextMapSessionId(),
        payload,
        "compass " + (if (enable) "enable" else "disable"),
        connectionOptions.sendImagesToLeft)
    message.onTimeout = MessageCallback {
        compassControlLastSent = -1
        logLine("compass control ack timeout")
    }
    if (enable) {
        compassMaybeOn = true
    } else {
        message.onAck = MessageCallback { compassMaybeOn = false }
    }
    if (priority) pendingMessages.addFirst(message)
    else pendingMessages.addLast(message)
    compassControlLastSent = sentState
    logLine("queue " + message.label)
}

internal fun GlassesSessionCore.enqueueAmbientLightControlLocked(payload: ByteArray, label: String, priority: Boolean) {
    if (!running || !sessionReady || shutdownRequested || !fixedLayoutCreated) {
        logLine("skip $label; display path not ready")
        return
    }
    val message = messageBuilder.imagePayload(
        "als-control",
        DASHBOARD_TILE,
        nextMapSessionId(),
        payload,
        label,
        connectionOptions.sendImagesToLeft)
    message.onTimeout = MessageCallback { logLine("$label ack timeout") }
    if (priority) pendingMessages.addFirst(message)
    else pendingMessages.addLast(message)
    logLine("queue $label")
}

internal fun GlassesSessionCore.enqueueDesiredImageLocked() {
    val fingerprint: String
    val packedSnapshot: ByteArray?
    val width: Int
    val height: Int
    val paintMs: Int
    val frameId: Int
    val draws: Array<SurfaceCompositor.ScreenDraw>?
    val scene: ShellScene
    desiredTilesLock.locked {
        fingerprint = desiredFingerprint
        packedSnapshot = desiredPacked
        width = desiredWidth
        height = desiredHeight
        paintMs = desiredPaintMs
        frameId = desiredFrameId
        draws = desiredDraws
        scene = desiredShellScene
        desiredFrameId = 0
    }
    val packedFrame: ByteArray = packedSnapshot ?: ByteArray(0)
    // Visibility belongs to this immutable composite, not the latest UI request.
    enqueueBrightnessLocked(!fingerprint.startsWith("blanked:"))
    if (customFirmwareDetected && packedFrame.size > 0) {
        val rendered = scenePlanner.plan(packedFrame, width, height, draws, scene, nextImageFrameId,
            connectionOptions.TEXTURE_CACHE_FRAMES, connectionOptions.INCREMENTAL_FRAMES,
            connectionOptions.MULTI_RECT_FRAMES, ConnectionOptions.MULTI_RECT_MAX_RECTS)
        nextImageFrameId = rendered.nextFid
        val commands = rendered.commands
        for (i in 0 until commands.size - 1) enqueueResourceCommandLocked(commands[i])
        val plan = BleImageOptimizer.TileImagePlan(
            0, DASHBOARD_TILE, packedFrame, width, height, nextMapSessionId(), commands[commands.size - 1])
        finishEnqueueDesiredImageLocked(plan, fingerprint, paintMs, frameId)
        return
    }

    frameTimings.spanStart(frameId, "compress-and-plan")
    // Incremental (mode 3 bounding box) update against the last ENQUEUED frame
    // (the base the firmware shadow will hold when this update is applied).
    // lastEnqueuedPacked is cleared whenever the image pipeline is cleared, so
    // a non-empty value means the display base is trusted.
    var incrementalPayload: ByteArray? = null
    var incrementalLog: String? = null
    if (connectionOptions.INCREMENTAL_FRAMES && lastEnqueuedPacked.size > 0
            && lastEnqueuedWidth == width && lastEnqueuedHeight == height) {
        val baseFid = nextImageFrameId
        val single =
            BleImageOptimizer.buildIncrementalImagePayload(lastEnqueuedPacked, packedFrame, width, height, baseFid)
        if (single != null) {
            incrementalPayload = single.payload
            // advance only when a delta is actually emitted, so consecutive
            // deltas carry consecutive ids (CFW skip/reorder detection)
            nextImageFrameId = if (nextImageFrameId >= 0xfffe) 1 else nextImageFrameId + 1
            incrementalLog = "incremental update bbox=" +
                ((single.payload[3].toInt() and 0xff) * 4) + "x" + ((single.payload[4].toInt() and 0xff) * 2) +
                "+" + ((single.payload[1].toInt() and 0xff) * 4) + "+" + ((single.payload[2].toInt() and 0xff) * 2) +
                " changed=" + single.changedBytes + "/" + single.boxBytes + "B" +
                " clusters=" + single.clusterCount

            // When the bounding box spans multiple clusters or is sizeable, try
            // splitting into tight rects (CFW mode-8). Only replace the single
            // box if the multi-rect message is actually smaller on the wire.
            if (connectionOptions.MULTI_RECT_FRAMES
                    && (single.clusterCount > 1 || single.payload.size > ConnectionOptions.MULTI_RECT_MIN_PAYLOAD)) {
                val multi = BleImageOptimizer.buildMultiRectImagePayload(
                    lastEnqueuedPacked, packedFrame, width, height, baseFid, ConnectionOptions.MULTI_RECT_MAX_RECTS)
                if (multi != null && multi.payload.size < single.payload.size) {
                    incrementalPayload = multi.payload
                    nextImageFrameId = multi.nextFid   // rectCount fids consumed
                    incrementalLog = "multi-rect update n=" + multi.rectCount +
                        " covered=" + multi.coveredBytes + "B" +
                        " payload=" + multi.payload.size + "B (vs bbox " + single.payload.size + "B)"
                }
            }
        }
    }
    val plan = if (incrementalPayload != null)
        BleImageOptimizer.TileImagePlan(0, DASHBOARD_TILE, packedFrame, width, height, nextMapSessionId(), incrementalPayload)
    else
        BleImageOptimizer.TileImagePlan(0, DASHBOARD_TILE, packedFrame, width, height, nextMapSessionId())
    frameTimings.spanEnd(frameId, "compress-and-plan")
    if (incrementalLog != null) {
        frameTimings.log(frameId, incrementalLog)
    }
    finishEnqueueDesiredImageLocked(plan, fingerprint, paintMs, frameId)
}

/** Queue complete private commands, advance the delta base, and retain frame/ACK bookkeeping. */
internal fun GlassesSessionCore.finishEnqueueDesiredImageLocked(
        plan: BleImageOptimizer.TileImagePlan, fingerprint: String, paintMs: Int, frameId: Int) {
    val updateId = nextImageUpdateId++
    val commands: MutableList<ByteArray> = ArrayList()
    if (plan.payload.size <= CfwTransport.MAX_MESSAGE) {
        commands.add(plan.payload)
    } else {
        // A noisy full frame can exceed the stream record limit. Repaint it
        // with independently decodable RLE bands below the decoded-message limit.
        commands.addAll(BleImageOptimizer.encodeFullFrameBands(
                plan.packed!!, plan.width, plan.height, nextImageFrameId))
        for (i in 0 until commands.size) {
            nextImageFrameId = if (nextImageFrameId >= 0xfffe) 1 else nextImageFrameId + 1
        }
    }
    val messageCount = commands.size
    imageUpdateStats[updateId] = BleImageOptimizer.ImageUpdateStats(paintMs, 1, frameId)
    for (i in 0 until commands.size) {
        enqueueCustomImageLocked(plan, commands[i], fingerprint, updateId, i + 1, messageCount)
    }
    // This frame is now the base for the next delta (it will be the firmware
    // shadow once applied), even though it hasn't been acked yet — that is what
    // lets the next frame pipeline behind it. plan.packed is the full frame;
    // frames are immutable by convention, so referencing it is safe.
    lastEnqueuedPacked = plan.packed!!
    lastEnqueuedWidth = plan.width
    lastEnqueuedHeight = plan.height
    lastEnqueuedFingerprint = fingerprint

    frameTimings.log(frameId, "queued image update#" + updateId
            + " messages=" + messageCount + " payload=" + plan.payload.size + "B")
    logLine("queue image update#" + updateId + " fingerprint=" + fingerprint
            + " messages=" + messageCount)
}

/**
 * Enqueue one resource eviction/upload command ahead of the image message that
 * references its glyphs (the transport is FIFO, so no ack round trip is
 * needed before use). A timeout means the on-glasses cache state is
 * unknown; forget everything phone-side (glyphs re-upload lazily) and let
 * the accompanying image update's own timeout drive the frame resync.
 */
internal fun GlassesSessionCore.enqueueResourceCommandLocked(payload: ByteArray) {
    val message = messageBuilder.imagePayload(
        "resources",
        DASHBOARD_TILE,
        nextMapSessionId(),
        payload,
        "resource command " + payload.size + "B",
        connectionOptions.sendImagesToLeft)
    message.onTimeout = MessageCallback {
        resourceCache.reset()
        logLine("resource command ack timeout; resource cache state reset")
    }
    pendingMessages.addLast(message)
    logLine("queue " + message.label)
}

internal fun GlassesSessionCore.enqueueCustomImageLocked(
    plan: BleImageOptimizer.TileImagePlan,
    payload: ByteArray,
    fingerprint: String,
    updateId: Int,
    messageNumber: Int,
    messageCount: Int
) {
    val message = messageBuilder.customMessage("image", payload,
            "image " + plan.tile.name + "#" + messageNumber, plan.tileIndex, connectionOptions.sendImagesToLeft)
    message.setImageUpdatePosition(updateId, messageNumber, messageCount)
    message.onAck = MessageCallback {
        imageRetryAfterMs = 0
        // Firmware >= 2.2.4.34 resets its heartbeat timer when it receives
        // image messages (not just heartbeats), so an acked image fragment
        // satisfies the heartbeat deadline and heartbeats stop contending
        // with active rendering.
        lastHeartbeatAckedAtMs = now()
        logImageUpdateAckLandmarkLocked(message)
        var imageStillInFlight = false
        for (inFlight in inFlightMessages) {
            if ("image" == inFlight.kind) {
                imageStillInFlight = true
                break
            }
        }
        if (!imageStillInFlight) {
            var imageStillQueued = false
            for (queued in pendingMessages) {
                if ("image" == queued.kind) {
                    imageStillQueued = true
                    break
                }
            }
            if (!imageStillQueued) {
                displayedFingerprint = fingerprint
            }
        }
    }
    message.onTimeout = MessageCallback {
        discardImageUpdateStatsLocked(message.imageUpdateId, "image ack timeout (will retry)")
        clearMessagesOfKindLocked("image")
        displayedFingerprint = ""
        imageRetryAfterMs = now() + ConnectionOptions.IMAGE_RETRY_DELAY_MS
    }
    pendingMessages.addLast(message)
}

internal fun GlassesSessionCore.createAudioControlMessageLocked(enable: Boolean): OutboundMessage {
    val message = messageBuilder.enableOrDisableMic(enable)
    message.onAck = MessageCallback {
        lastAudioControlAckMagic = message.magic
        audioCaptureActive = message.label?.contains("enable") == true
        logLine(if (audioCaptureActive) "G2 mic enabled" else "G2 mic disabled")
    }
    message.onTimeout = MessageCallback {
        handleTransportFailure("audio control ack timeout")
    }
    return message
}

internal fun GlassesSessionCore.shouldPollBatteryLocked(now: Long): Boolean {
    return !shutdownRequested
            && sessionReady
            && pendingMessages.isEmpty()
            && inFlightMessages.isEmpty()
            && now - lastConnectionOrInputAtMs >= ConnectionOptions.BATTERY_INPUT_QUIET_MS
            && (lastBatteryRefreshAtMs == 0L || now - lastBatteryRefreshAtMs >= ConnectionOptions.BATTERY_REFRESH_INTERVAL_MS)
}

internal fun GlassesSessionCore.createBatteryQueryMessageLocked(): OutboundMessage {
    val message = messageBuilder.batteryQuery()
    message.onAck = MessageCallback {
        val ring = BleProtocol.parseRingBattery(message.ackPayload)
        // Old firmware and missing/malformed extensions must clear any prior reading.
        ringBattery = if (ring == null) -1 else ring.battery
        ringCharging = if (ring == null) -1 else ring.charging
        val snapshot = BleProtocol.parseSettingsBattery(message.ackPayload)
        if (snapshot != null) {
            headsetBattery = snapshot.battery
            headsetCharging = snapshot.charging
            emitBatteryState(headsetBattery, headsetCharging)
            if (snapshot.silentMode >= 0) {
                // Backstop for the push in onNotification: the firmware is
                // confirmed to push silent-mode-on, but the off transition is
                // not, so re-read the authoritative value on every poll.
                updateSilentModeLocked(snapshot.silentMode > 0)
            }
            updateChargingModeLocked(snapshot.charging > 0, snapshot.battery)
        }
        val firmwareInfo = BleProtocol.parseSettingsFirmwareInfo(message.ackPayload)
        if (firmwareInfo != null) {
            customFirmwareDetected = firmwareInfo.isFaceclawFirmware()
            emitFirmwareInfo(firmwareInfo)
        }
    }
    message.onTimeout = MessageCallback {
        logLine("Battery query timed out")
    }
    return message
}

/**
 * Track silent mode, which the wearer toggles by long-pressing both
 * touchpads at once. While it is on the firmware refuses input events and
 * app launches and powers the display down, so the glasses look dead even
 * though the BLE session is healthy; the phone UI says so explicitly.
 */
internal fun GlassesSessionCore.updateSilentModeLocked(silent: Boolean) {
    val next = if (silent) 1 else 0
    if (silentMode == next) {
        return
    }
    silentMode = next
    logLine(if (silent) "glasses entered silent mode" else "glasses left silent mode")
    emitSilentMode(silent)
}

/**
 * Track whether the glasses are in the charging case. Charging means nobody
 * is wearing them: display communication pauses (no heartbeats, so the
 * firmware tears down its EvenHub context on its own) and only battery polls
 * continue. When charging stops, tear the transport down and let the normal
 * reconnect loop rebuild the session, layout, and first frame.
 */
internal fun GlassesSessionCore.updateChargingModeLocked(charging: Boolean, battery: Int) {
    if (charging == chargingMode) {
        if (chargingMode) {
            setStateDisplay("charging", GlassesSessionCore.chargingStatusText(battery))
        }
        return
    }
    if (charging) {
        chargingMode = true
        clearAllMessagesLocked("glasses charging")
        fixedLayoutCreated = false
        startupProbePending = false
        displayedFingerprint = ""
        finishDesiredFrameLocked("discarded: glasses charging")
        logLine("glasses are charging; pausing display communication")
        setStateDisplay("charging", GlassesSessionCore.chargingStatusText(battery))
    } else {
        chargingMode = false
        logLine("glasses removed from charger; reconnecting")
        handleTransportFailure("charging ended")
    }
}

/**
 * Record, into the frame that is waiting, why it did not go out on this
 * pass of the send loop. Without this the export shows a bare multi-second
 * jump between "image submitted as desired frame" and the first BLE
 * packet, with no hint whether we were blocked on a heartbeat, the
 * BLE window, or another message queued ahead. Deduped on (frame, reason),
 * so a frame stalled for seconds gets one line per state change rather
 * than one per loop pass.
 */
internal fun GlassesSessionCore.noteImageStallLocked(now: Long, windowHasRoom: Boolean) {
    var frameId: Int
    desiredTilesLock.locked {
        frameId = desiredFrameId
    }
    val reason: String?
    if (frameId != 0 && desiredFingerprintSnapshot() != lastEnqueuedFingerprint) {
        reason = describeEnqueueBlockerLocked(now, windowHasRoom)
    } else {
        // Nothing waiting to be planned; an already-planned image may still
        // be queued behind other traffic.
        val queuedImage = firstPendingImageLocked()
        frameId = if (queuedImage == null) 0 else imageUpdateFrameIdLocked(queuedImage.imageUpdateId)
        reason = if (queuedImage == null) null else describeWriteBlockerLocked(now, windowHasRoom, queuedImage)
    }
    if (frameId == 0 || reason == null) {
        stallFrameId = 0
        stallReason = ""
        return
    }
    if (frameId == stallFrameId && reason == stallReason) {
        return
    }
    stallFrameId = frameId
    stallReason = reason
    frameTimings.log(frameId, "waiting to send: $reason")
}

/** Why the desired composite has not been turned into wire messages yet, or null. */
internal fun GlassesSessionCore.describeEnqueueBlockerLocked(now: Long, windowHasRoom: Boolean): String? {
    if (shutdownRequested) {
        return "shutdown requested"
    }
    if (!sessionReady) {
        return "BLE session not ready"
    }
    if (!fixedLayoutCreated) {
        return "display layout not created yet"
    }
    if (now < imageRetryAfterMs) {
        return "image retry backoff (" + (imageRetryAfterMs - now) + "ms left)"
    }
    if (hasPendingImageLocked()) {
        return "an earlier image is still queued"
    }
    if (!windowHasRoom) {
        return "BLE window full (" + inFlightMessages.size + " message(s) in flight)"
    }
    if (hasPendingOrInflightKindLocked("heartbeat")) {
        return "heartbeat in flight"
    }
    if (!pendingMessages.isEmpty()) {
        return pendingMessages.size.toString() + " message(s) queued ahead, next " +
            pendingMessages.firstOrNull()?.label
    }
    return null
}

/** Why a planned image message has not been written to BLE yet, or null. */
internal fun GlassesSessionCore.describeWriteBlockerLocked(now: Long, windowHasRoom: Boolean, queuedImage: OutboundMessage): String? {
    if (!sessionReady) {
        return "BLE session not ready"
    }
    if (!windowHasRoom) {
        return "BLE window full (" + inFlightMessages.size + " message(s) in flight)"
    }
    if (hasPendingOrInflightKindLocked("heartbeat")) {
        return "heartbeat in flight"
    }
    // handleHeartbeat is a barrier: while one is due it holds back every
    // other write, so a frame queued at the wrong moment waits a heartbeat
    // round trip. Reported explicitly because it is otherwise invisible --
    // heartbeats belong to no frame.
    val heartbeatElapsedMs = now - lastHeartbeatAckedAtMs
    if (fixedLayoutCreated && !shutdownRequested
            && heartbeatElapsedMs >= ConnectionOptions.HEARTBEAT_READY_MS) {
        return "heartbeat due (" + heartbeatElapsedMs + "ms since the last one acked)"
    }
    val head = pendingMessages.firstOrNull()
    if (head != null && head !== queuedImage) {
        return "queued behind " + head.label
    }
    return null
}

internal fun GlassesSessionCore.firstPendingImageLocked(): OutboundMessage? {
    for (message in pendingMessages) {
        if (message.imageUpdateId > 0) {
            return message
        }
    }
    return null
}

internal fun GlassesSessionCore.imageUpdateFrameIdLocked(imageUpdateId: Int): Int {
    val stats = imageUpdateStats[imageUpdateId]
    return if (stats == null) 0 else stats.frameId
}

internal fun GlassesSessionCore.finishDesiredFrameLocked(outcome: String) {
    val frameIdToFinish: Int
    desiredTilesLock.locked {
        frameIdToFinish = desiredFrameId
        desiredFrameId = 0
    }
    finishFrame(frameIdToFinish, outcome)
}

internal fun GlassesSessionCore.hasPendingOrInflightKindLocked(kind: String): Boolean {
    for (queued in pendingMessages) {
        if (kind == queued.kind) {
            return true
        }
    }
    for (inFlight in inFlightMessages) {
        if (kind == inFlight.kind) {
            return true
        }
    }
    return false
}

internal fun GlassesSessionCore.hasPendingOrInflightMagicLocked(magic: Int): Boolean {
    for (queued in pendingMessages) {
        if (queued.magic == magic) {
            return true
        }
    }
    for (inFlight in inFlightMessages) {
        if (inFlight.magic == magic) {
            return true
        }
    }
    return false
}

internal fun GlassesSessionCore.hasPendingMagicLocked(sid: Int, magic: Int): Boolean {
    for (queued in pendingMessages) {
        if (queued.sid == sid && queued.magic == magic) {
            return true
        }
    }
    return false
}

internal fun GlassesSessionCore.handleAckTimeoutLocked(message: OutboundMessage) {
    consecutiveAckTimeouts += 1

    val onTimeout = message.onTimeout
    if (onTimeout != null) {
        onTimeout.run()
    }

    if (consecutiveAckTimeouts > ConnectionOptions.MAX_CONSECUTIVE_ACK_TIMEOUTS) {
        handleTransportFailure("too many ack timeouts")
    }
}

internal fun GlassesSessionCore.clearMessagesOfKindLocked(kind: String) {
    val pendingIterator = pendingMessages.iterator()
    while (pendingIterator.hasNext()) {
        val message = pendingIterator.next()
        if (kind == message.kind) {
            pendingIterator.remove()
            discardPrewriteIfMatchesLocked(message)
            if ("image" == kind) {
                discardImageUpdateStatsLocked(message.imageUpdateId, "pending messages cleared ($kind)")
            }
            magicPool.release(message.sid, message.magic, message.label, "cleared pending $kind")
        }
    }
    val inFlightIterator = inFlightMessages.iterator()
    while (inFlightIterator.hasNext()) {
        val message = inFlightIterator.next()
        if (kind == message.kind) {
            inFlightIterator.remove()
            if ("image" == kind) {
                discardImageUpdateStatsLocked(message.imageUpdateId, "inflight messages cleared ($kind)")
            }
            magicPool.release(message.sid, message.magic, message.label, "cleared inflight $kind")
        }
    }
    if ("image" == kind) {
        // The image pipeline was flushed (e.g. ack timeout -> keyframe resync):
        // drop the pipelined delta base so the next image is a full keyframe.
        lastEnqueuedPacked = ByteArray(0)
        lastEnqueuedFingerprint = ""
    }
}

internal fun GlassesSessionCore.clearAllMessagesLocked(reason: String) {
    brightnessSentVisible = null
    brightnessSentLevel = -1
    brightnessAlsStartedAt = -2000
    clearPendingMessagesLocked(reason)
    clearInFlightMessagesLocked(reason)
    // The image pipeline is gone: drop the pipelined delta base so the next
    // image is a full keyframe rather than a delta onto a stale base.
    lastEnqueuedPacked = ByteArray(0)
    lastEnqueuedFingerprint = ""
    // Queued resource commands (if any) were dropped with the rest, and the
    // session churn behind a full clear may have freed the on-glasses
    // cache; forget it phone-side so glyphs re-upload lazily.
    resourceCache.reset()
}

/**
 * A custom wake queues CLAIM before NativeScript asks for a resume. Keep
 * that private control while flushing stale EvenHub traffic around the
 * direct prelude write.
 */
internal fun GlassesSessionCore.clearAllMessagesPreservingWakeLeaseLocked(reason: String) {
    brightnessSentVisible = null
    brightnessSentLevel = -1
    brightnessAlsStartedAt = -2000
    val pendingIterator = pendingMessages.iterator()
    while (pendingIterator.hasNext()) {
        val message = pendingIterator.next()
        if ("wake-lease-control" == message.kind) {
            continue
        }
        pendingIterator.remove()
        discardPrewriteIfMatchesLocked(message)
        discardImageUpdateStatsLocked(
            message.imageUpdateId,
            "pending messages cleared: $reason"
        )
        magicPool.release(
            message.sid,
            message.magic,
            message.label,
            "cleared pending: $reason"
        )
    }
    clearInFlightMessagesLocked(reason)
    lastEnqueuedPacked = ByteArray(0)
    lastEnqueuedFingerprint = ""
    resourceCache.reset()
}

/** Any image update whose fragments are still queued (not yet sent). */
internal fun GlassesSessionCore.hasPendingImageLocked(): Boolean {
    for (message in pendingMessages) {
        if ("image" == message.kind) {
            return true
        }
    }
    return false
}

internal fun GlassesSessionCore.clearPendingMessagesLocked(reason: String) {
    while (!pendingMessages.isEmpty()) {
        val message = pendingMessages.removeFirst()
        discardPrewriteIfMatchesLocked(message)
        discardImageUpdateStatsLocked(message.imageUpdateId, "pending messages cleared: $reason")
        magicPool.release(message.sid, message.magic, message.label, "cleared pending: $reason")
    }
}

internal fun GlassesSessionCore.clearInFlightMessagesLocked(reason: String) {
    while (!inFlightMessages.isEmpty()) {
        val message = inFlightMessages.removeFirst()
        discardImageUpdateStatsLocked(message.imageUpdateId, "inflight messages cleared: $reason")
        magicPool.release(message.sid, message.magic, message.label, "cleared inflight: $reason")
    }
}

internal fun GlassesSessionCore.discardPrewriteIfMatchesLocked(message: OutboundMessage?) {
    if (message != null && message === prewrittenMessage) {
        prewrittenMessage = null
        prewrittenFrames = emptyList()
    }
}

internal fun GlassesSessionCore.recordUnexpectedAckLocked(sid: Int, magic: Int) {
    if (magic < BleMagicPool.MIN_MAGIC || magic > BleMagicPool.MAX_MAGIC) {
        return
    }
    val previous = magicPool.getReleaseRecord(sid, magic)
    if (previous == null) {
        val pendingNote = if (hasPendingMagicLocked(sid, magic)) " while that magic is only pending locally" else ""
        logLine("unexpected ACK sid=" + sid + " magic=" + magic + pendingNote
                + "; possible Even app BLE contention")
        return
    }
    if ("timeout" == previous.reason) {
        logLine("late ACK after timeout sid=" + sid + " magic=" + magic
                + " label=" + previous.label
                + "; ACK timeout may be too short")
        return
    }
    if ("ack" == previous.reason) {
        logLine("duplicate ACK for already-acked message sid=" + sid + " magic=" + magic
                + " label=" + previous.label
                + "; possible Even app BLE contention")
        return
    }
    logLine("late ACK for released message sid=" + sid + " magic=" + magic
            + " label=" + previous.label
            + " release=" + previous.reason)
}
