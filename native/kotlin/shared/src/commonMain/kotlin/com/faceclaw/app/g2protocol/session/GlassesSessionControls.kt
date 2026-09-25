package com.faceclaw.app

import com.faceclaw.app.GlassesSessionCore.Companion.DASHBOARD_TILE
import com.faceclaw.app.GlassesSessionCore.Companion.FACECLAW_WAKE_CONTROL_WAIT_MS
import com.faceclaw.app.GlassesSessionCore.Companion.TAG

/*
 * GlassesSessionCore, part 3: CFW lease controls, EvenHub shutdown, the bandwidth
 * benchmark stream, transport-failure handling and the listener emits (all
 * marshalled through SessionHost.postToMain, or a subscriber's own dispatcher
 * for compass events).
 */

// ---------------------------------------------------------------------------
// Bandwidth benchmark

/** Pending + in-flight benchmark no-op messages. */
internal fun GlassesSessionCore.benchmarkOutstandingLocked(): Int {
    var count = 0
    for (message in pendingMessages) {
        if ("bandwidth" == message.kind) count++
    }
    for (message in inFlightMessages) {
        if ("bandwidth" == message.kind) count++
    }
    return count
}

/**
 * Keep the benchmark stream fed: top the pending queue up so the send
 * window never starves, stop enqueueing once the run expires (or a message
 * times out), and finish the run when the last outstanding message drains.
 */
internal fun GlassesSessionCore.maintainBenchmarkLocked(now: Long) {
    if (!sessionReady || !fixedLayoutCreated || shutdownRequested) {
        finishBenchmarkLocked(true, "session no longer ready")
        return
    }
    if (benchmarkLinkPending || now < benchmarkReadyAtMs) {
        return
    }
    if (benchmarkAborted || now >= benchmarkDeadlineAtMs) {
        // The run is over: drop queued-but-unsent no-ops (sending them
        // would stretch the run past its deadline) and finish once the
        // in-flight tail has acked or timed out.
        val pendingIterator = pendingMessages.iterator()
        while (pendingIterator.hasNext()) {
            val queued = pendingIterator.next()
            if ("bandwidth" == queued.kind) {
                pendingIterator.remove()
                magicPool.release(queued.sid, queued.magic, queued.label, "benchmark over")
            }
        }
        if (benchmarkOutstandingLocked() == 0) {
            finishBenchmarkLocked(false, "complete")
        }
        return
    }
    // One more than the window so a fresh message is always ready to write
    // the moment an ack frees a slot.
    var outstanding = benchmarkOutstandingLocked()
    while (outstanding <= benchmarkWindowSize) {
        enqueueBenchmarkMessageLocked()
        outstanding++
    }
}

internal fun GlassesSessionCore.finishBenchmarkLocked(aborted: Boolean, reason: String) {
    if (!benchmarkActive) {
        return
    }
    benchmarkActive = false
    benchmarkAborted = benchmarkAborted or aborted
    // Prefer the last ack as the end time so drain lag after the deadline
    // doesn't dilute the throughput figure.
    benchmarkEndAtMs = if (benchmarkLastAckAtMs != 0L) benchmarkLastAckAtMs else now()
    logLine("bandwidth benchmark " + (if (benchmarkAborted) "aborted" else "finished") + " (" + reason + "): "
        + benchmarkMessagesAcked + "/" + benchmarkMessagesSent + " acked, "
        + benchmarkPayloadBytesAcked + "B payload, " + benchmarkTimeouts + " timeouts")
}

internal fun GlassesSessionCore.enqueueBenchmarkMessageLocked() {
    // Fresh bytes per message: the transport's persistent compression history
    // would compress even a random payload if we reused it across the run.
    val payload = ByteArray(benchmarkMessageSize)
    kotlin.random.Random.nextBytes(payload)
    payload[0] = CFW_MSG_DIAGNOSTICS.toByte()             // CFW diagnostic-control mode...
    payload[1] = 0x7f.toByte()   // ...with an unused sub-op: acked, no effect
    val message = messageBuilder.imagePayload(
        "bandwidth",
        DASHBOARD_TILE,
        nextMapSessionId(),
        payload,
        "bandwidth no-op " + payload.size + "B",
        connectionOptions.sendImagesToLeft)
    val payloadBytes = payload.size
    // Logical custom-message bytes; excludes length tag and packet framing.
    val wireBytes = message.message.size
    message.onSent = MessageCallback {
        benchmarkMessagesSent++
        if (benchmarkStartAtMs == 0L) {
            benchmarkStartAtMs = now()
            benchmarkDeadlineAtMs = benchmarkStartAtMs + benchmarkDurationMs
        }
    }
    message.onAck = MessageCallback {
        val ackedAtMs = now()
        benchmarkMessagesAcked++
        benchmarkPayloadBytesAcked += payloadBytes
        benchmarkWireBytesAcked += wireBytes
        benchmarkLastAckAtMs = ackedAtMs
        // No-op payloads ride the image path, so the firmware resets its
        // heartbeat timer on them just like real image messages.
        lastHeartbeatAckedAtMs = ackedAtMs
    }
    message.onTimeout = MessageCallback {
        benchmarkTimeouts++
        benchmarkAborted = true
        logLine("bandwidth benchmark ack timeout")
    }
    pendingMessages.addLast(message)
}

// ---------------------------------------------------------------------------
// EvenHub shutdown and audio control waits

internal fun GlassesSessionCore.sendShutdownInternal(exitMode: Int, reconnectOnTimeout: Boolean): Boolean {
    val magic: Int
    val startedAtMs = now()
    monitor.withLock {
        if (!running || !sessionReady) {
            logLine("skip shutdown; session not ready")
            return false
        }
        if (shutdownRequested) {
            return true
        }
        shutdownRequested = true
        // Magic values wrap, so an ACK from a much older suspend must not
        // satisfy this request after enough sleep/wake cycles.
        lastShutdownAckMagic = 0
        clearPendingMessagesLocked("shutdown requested")
        val message = messageBuilder.shutdown(exitMode)
        magic = message.magic
        message.onAck = MessageCallback {
            lastShutdownAckMagic = message.magic
            fixedLayoutCreated = false
            displayedFingerprint = ""
        }
        message.onTimeout = MessageCallback {
            if (reconnectOnTimeout) {
                handleTransportFailure("shutdown ack timeout")
            } else {
                logLine("EvenHub shutdown ack timeout; keeping BLE connected")
            }
        }
        pendingMessages.addFirst(message)
        logLine("queue shutdown")
        // The stock compass keeps the magnetometer sampling independently of
        // the plugin task, so ending the page does not stop it. Force a
        // disable ahead of the shutdown command whenever it may be running:
        // this also covers a disable that was wiped by the queue flush above
        // or whose ack was lost, and the charging-mode/exit paths where the
        // Compass window never got a chance to release it.
        if (compassMaybeOn && fixedLayoutCreated) {
            enqueueCompassControlLocked(true, false)
        }
    }
    interruptibleSleep.interrupt()

    val ackDeadline = now() + ConnectionOptions.ACK_TIMEOUT_MS + 500
    monitor.withLock {
        while (running
                && sessionReady
                && lastShutdownAckMagic != magic
                && lastShutdownExitAtMs < startedAtMs
                && hasPendingOrInflightMagicLocked(magic)) {
            val remaining = ackDeadline - now()
            if (remaining <= 0) {
                break
            }
            monitor.awaitMs(minOf(remaining, 100L))
        }
        val acked = lastShutdownAckMagic == magic
        if (acked) {
            val exitDeadline = now() + ConnectionOptions.ACK_TIMEOUT_MS + 500
            while (running && sessionReady && lastShutdownExitAtMs < startedAtMs) {
                val remaining = exitDeadline - now()
                if (remaining <= 0) {
                    break
                }
                monitor.awaitMs(minOf(remaining, 100L))
            }
        }
        return acked || lastShutdownExitAtMs >= startedAtMs
    }
}

internal fun GlassesSessionCore.waitForAudioControlAck(magic: Int, operation: String): Boolean {
    val deadline = now() + ConnectionOptions.ACK_TIMEOUT_MS + ConnectionOptions.WRITE_TIMEOUT_MS + 500
    monitor.withLock {
        while (running && sessionReady && lastAudioControlAckMagic != magic && hasPendingOrInflightMagicLocked(magic)) {
            val remaining = deadline - now()
            if (remaining <= 0) {
                break
            }
            monitor.awaitMs(minOf(remaining, 100L))
        }
        val acked = lastAudioControlAckMagic == magic
        if (!acked) {
            if ("enable" == operation) {
                audioPacketListener = null
                audioCaptureActive = false
            }
            logLine("G2 mic $operation ack timeout")
        }
        return acked
    }
}

// ---------------------------------------------------------------------------
// CFW wake and framebuffer leases

/**
 * Replace any stale lease control with one right-arm and one left-arm
 * fire-and-forget write. With priority=true the right arm is sent first so
 * CLAIM reaches the lens that originated the deferred wake immediately.
 */
internal fun GlassesSessionCore.enqueueFaceclawWakeControlLocked(operation: Int, nonce: Int, priority: Boolean): Int {
    clearMessagesOfKindLocked("wake-lease-control")
    val generation = ++faceclawWakeControlGeneration
    faceclawWakeControlSentCount = 0
    if (operation == BleProtocol.FACECLAW_WAKE_OP_ACQUIRE) {
        lastFaceclawWakeLeaseQueuedAtMs = now()
    }
    val onSent = MessageCallback {
        if (faceclawWakeControlGeneration == generation) {
            faceclawWakeControlSentCount += 1
        }
    }
    val right = messageBuilder.faceclawWakeControl(operation, nonce, false)
    val left = messageBuilder.faceclawWakeControl(operation, nonce, true)
    right.onSent = onSent
    left.onSent = onSent
    if (priority) {
        pendingMessages.addFirst(left)
        pendingMessages.addFirst(right)
    } else {
        pendingMessages.addLast(right)
        pendingMessages.addLast(left)
    }
    logLine("queue " + right.label + " + L")
    return generation
}

internal fun GlassesSessionCore.waitForFaceclawWakeControlDelivery(generation: Int, timeoutMs: Long): Boolean {
    val deadline = now() + maxOf(0L, timeoutMs)
    monitor.withLock {
        while (running
                && sessionReady
                && faceclawWakeControlGeneration == generation
                && faceclawWakeControlSentCount < 2) {
            val remaining = deadline - now()
            if (remaining <= 0) {
                break
            }
            monitor.awaitMs(minOf(remaining, 100L))
        }
        return faceclawWakeControlGeneration == generation
            && faceclawWakeControlSentCount >= 2
    }
}

/**
 * Acquire/renew or release CFW's independent direct-framebuffer repaint
 * guard on both arms. It is separate from the optional idle-wake lease:
 * every Faceclaw display session needs this guard while its EvenHub layout
 * contains swipe-capturing stock widgets.
 */
internal fun GlassesSessionCore.enqueueFaceclawFramebufferControlLocked(operation: Int, priority: Boolean): Int {
    clearMessagesOfKindLocked("framebuffer-lease-control")
    val generation = ++faceclawFramebufferControlGeneration
    faceclawFramebufferControlSentCount = 0
    if (operation == BleProtocol.FACECLAW_FB_OP_ACQUIRE) {
        lastFaceclawFramebufferLeaseQueuedAtMs = now()
    }
    val onSent = MessageCallback {
        if (faceclawFramebufferControlGeneration == generation) {
            faceclawFramebufferControlSentCount += 1
        }
    }
    val right = messageBuilder.faceclawFramebufferControl(operation, false)
    val left = messageBuilder.faceclawFramebufferControl(operation, true)
    right.onSent = onSent
    left.onSent = onSent
    if (priority) {
        pendingMessages.addFirst(left)
        pendingMessages.addFirst(right)
    } else {
        pendingMessages.addLast(right)
        pendingMessages.addLast(left)
    }
    logLine("queue " + right.label + " + L")
    return generation
}

internal fun GlassesSessionCore.waitForFaceclawFramebufferControlDelivery(generation: Int, timeoutMs: Long): Boolean {
    val deadline = now() + maxOf(0L, timeoutMs)
    monitor.withLock {
        while (running
                && sessionReady
                && faceclawFramebufferControlGeneration == generation
                && faceclawFramebufferControlSentCount < 2) {
            val remaining = deadline - now()
            if (remaining <= 0) {
                break
            }
            monitor.awaitMs(minOf(remaining, 100L))
        }
        return faceclawFramebufferControlGeneration == generation
            && faceclawFramebufferControlSentCount >= 2
    }
}

internal fun GlassesSessionCore.releaseFaceclawFramebufferLease(): Boolean {
    val generation: Int
    monitor.withLock {
        if (!running || !sessionReady) {
            return true
        }
        generation = enqueueFaceclawFramebufferControlLocked(
            BleProtocol.FACECLAW_FB_OP_RELEASE,
            true
        )
    }
    interruptibleSleep.interrupt()
    return waitForFaceclawFramebufferControlDelivery(
        generation,
        FACECLAW_WAKE_CONTROL_WAIT_MS
    )
}

// ---------------------------------------------------------------------------
// Failure handling

/** The address of a configured arm the OS no longer holds a bond for, or null. */
internal fun GlassesSessionCore.firstUnpairedArm(): String? {
    if (!link.isBonded(rightAddress)) return rightAddress
    if (!link.isBonded(leftAddress)) return leftAddress
    return null
}

/**
 * A connect failure while an arm's bond is missing (the pairing was
 * forgotten in the OS settings, or the address was typed in by hand and
 * never paired) will repeat forever, so instead of scheduling a retry,
 * park the worker loop and tell the user to re-pair. Only an explicit
 * connect (which builds a fresh communicator) starts a new attempt.
 */
internal fun GlassesSessionCore.handleUnpairedFailure(address: String) {
    logError("Connect failed and $address is not paired; suspending reconnect")
    monitor.withLock {
        reconnectHalted = true
        sessionReady = false
        fixedLayoutCreated = false
        startupProbePending = false
        shutdownRequested = false
        chargingMode = false
        imageRetryAfterMs = 0
        displayedFingerprint = ""
        faceclawWakePendingNonce = -1
        lastFaceclawWakeLeaseQueuedAtMs = 0
        faceclawWakeControlSentCount = 0
        clearAllMessagesLocked("arm not paired: $address")
        reconnectAfterMs = Long.MAX_VALUE
        link.disconnect(rightAddress)
        link.disconnect(leftAddress)
    }
    if (!userDisconnectRequested) {
        setStateDisplay(
            "unpaired",
            "The glasses (" + address + ") are not paired with this phone."
                + " Use \"Pair glasses\" to pair them again, then connect."
        )
    }
    interruptibleSleep.interrupt()
}

internal fun GlassesSessionCore.handleTransportFailure(reason: String?) {
    logError("Transport failure: $reason")
    monitor.withLock {
        maybeEmitEvenAppConflictLocked(reason)
        finishBenchmarkLocked(true, "transport failure")
        sessionReady = false
        fixedLayoutCreated = false
        startupProbePending = false
        shutdownRequested = false
        chargingMode = false
        imageRetryAfterMs = 0
        displayedFingerprint = ""
        faceclawWakePendingNonce = -1
        lastFaceclawWakeLeaseQueuedAtMs = 0
        faceclawWakeControlSentCount = 0
        clearAllMessagesLocked("transport failure: $reason")
        reconnectAfterMs = now() + ConnectionOptions.RECONNECT_DELAY_MS
        link.disconnect(rightAddress)
        link.disconnect(leftAddress)
    }
    if (!userDisconnectRequested) {
        setStateDisplay("retrying", if (reason == null || reason.isEmpty()) "Reconnecting..." else "Reconnecting after $reason")
    }
    interruptibleSleep.interrupt()
}

internal fun GlassesSessionCore.resetSessionStateLocked() {
    ringBattery = -1
    ringCharging = -1
    sessionReady = false
    shutdownRequested = false
    fixedLayoutCreated = false
    chargingMode = false
    rightConnected = false
    leftConnected = false
    ringConnected = false
    ringNotificationsReady = false
    reconnectAfterMs = 0
    reconnectHalted = false
    ringReconnectAfterMs = 0
    lastAckAtMs = 0
    lastIncomingAtMs = 0
    lastHeartbeatSentAtMs = 0
    lastSessionReadyAtMs = 0
    consecutiveAckTimeouts = 0
    lastAudioControlAckMagic = 0
    audioCaptureActive = false
    audioPacketListener = null
    compassControlLastSent = -1
    // A dead transport orphans any glasses-side compass state; the fresh
    // session re-asserts the desired state once its layout is ready.
    compassMaybeOn = false
    faceclawWakePendingNonce = -1
    lastFaceclawWakeLeaseQueuedAtMs = 0
    faceclawWakeControlSentCount = 0
    cfwCleanupDelivered = false
    for (transport in cfwTransports) transport.reset()
    lastCfwCleanupAckMagic = 0
    wearState = -1
    displayedFingerprint = ""
    // Deliberately not clearing silentMode: it is a property of the glasses,
    // not of our session, and silent mode blocks app launches, so it can be
    // the very cause of the session teardown that got us here.
}

// ---------------------------------------------------------------------------
// Listener emits (main thread via the host)

internal fun GlassesSessionCore.emitAmbientLight(body: ByteArray) {
    if (ambientLightListeners.isEmpty()) {
        return
    }
    val copy = body.copyOf()
    host.postToMain {
        for (alsListener in ambientLightListeners) {
            try {
                alsListener.onAmbientLight(copy)
            } catch (t: Throwable) {
                logWarn("ambient light listener failed", t)
            }
        }
    }
}

internal fun GlassesSessionCore.emitMicStatus(body: ByteArray, address: String) {
    if (micStatusListeners.isEmpty()) {
        return
    }
    val arm = if (address.equals(leftAddress, ignoreCase = true)) "L"
        else if (address.equals(rightAddress, ignoreCase = true)) "R" else "?"
    val copy = body.copyOf()
    host.postToMain {
        for (micListener in micStatusListeners) {
            try {
                micListener.onMicStatus(copy, arm)
            } catch (t: Throwable) {
                logWarn("mic status listener failed", t)
            }
        }
    }
}

internal fun GlassesSessionCore.emitRingEvent(event: G2Event, frameId: Int) {
    val current = listener
    if (current == null) {
        frameTimings.finishFrame(frameId, "discarded: no listener attached")
        return
    }
    val containerNameSnapshot = event.containerName
    host.postToMain {
        frameTimings.log(frameId, "dispatching input event on main thread")
        try {
            current.onRingEvent(event.kind, containerNameSnapshot, event.eventType, event.eventSource, event.systemExitReasonCode, frameId,
                    event.ringTick, event.ringType, event.ringAux, event.ringSpeed)
        } catch (t: Throwable) {
            logWarn("listener onRingEvent failed", t)
            frameTimings.finishFrame(frameId, "discarded: listener onRingEvent failed")
        }
    }
}

/** Finish a frame owned by the communicator and tell the TS side, which may be awaiting it. */
internal fun GlassesSessionCore.finishFrame(frameId: Int, outcome: String) {
    if (frameId <= 0) {
        return
    }
    frameTimings.finishFrame(frameId, outcome)
    val current = listener ?: return
    host.postToMain {
        try {
            current.onFrameFinished(frameId, outcome)
        } catch (t: Throwable) {
            logWarn("listener onFrameFinished failed", t)
        }
    }
}

internal fun GlassesSessionCore.emitImuData(x: Double, y: Double, z: Double, eventSource: Int) {
    if (imuListeners.isEmpty()) {
        return
    }
    host.postToMain {
        for (imuListener in imuListeners) {
            try {
                imuListener.onImuData(x, y, z, eventSource)
            } catch (t: Throwable) {
                logWarn("listener onImuData failed", t)
            }
        }
    }
}

internal fun GlassesSessionCore.emitCompassEvent(event: BleProtocol.CompassEvent) {
    if (event.diagnosticFlags >= 0) {
        val sources = arrayOf("unknown", "GRV", "GMRV", "RV")
        host.log(SessionLogLevel.INFO, "FaceclawCompass", "heading=" + event.headingDegrees
            + " magneticAccuracy=" + event.magneticAccuracy
            + " magneticAnomalies=" + event.magneticAnomalies
            + " orientationSource=" + sources[event.orientationSource]
            + " flags=0x" + event.diagnosticFlags.toString(16)
            + " sampleTimeMs=" + event.sampleTimeMs, null)
    }
    for (subscription in compassSubscriptions) {
        subscription.dispatcher.post {
            try {
                subscription.listener.onCompassEvent(event.command, event.headingDegrees,
                    event.magneticAccuracy, event.magneticAnomalies, event.orientationSource,
                    event.diagnosticFlags, event.sampleTimeMs)
            } catch (t: Throwable) {
                logWarn("listener onCompassEvent failed", t)
            }
        }
    }
}

internal fun GlassesSessionCore.emitSilentMode(silent: Boolean) {
    val current = listener ?: return
    host.postToMain {
        try {
            current.onSilentMode(silent)
        } catch (t: Throwable) {
            logWarn("listener onSilentMode failed", t)
        }
    }
}

internal fun GlassesSessionCore.emitWearState(wearing: Boolean) {
    val current = listener ?: return
    host.postToMain {
        try {
            current.onWearState(wearing)
        } catch (t: Throwable) {
            logWarn("listener onWearState failed", t)
        }
    }
}

internal fun GlassesSessionCore.emitPhoneLockStateIfChanged(force: Boolean) {
    val locked: Boolean
    monitor.withLock {
        val now = now()
        if (!force && now - lastPhoneLockCheckAtMs < 1_000) return
        lastPhoneLockCheckAtMs = now
        locked = host.isPhoneLocked()
        val value = if (locked) 1 else 0
        if (!force && value == phoneLockState) return
        phoneLockState = value
    }
    val current = listener ?: return
    host.postToMain {
        try {
            current.onPhoneLockState(locked)
        } catch (t: Throwable) {
            logWarn("listener onPhoneLockState failed", t)
        }
    }
}

internal fun GlassesSessionCore.emitBatteryState(headsetBattery: Int, headsetCharging: Int) {
    val reportedRingBattery = ringBattery
    val reportedRingCharging = ringCharging
    val current = listener ?: return
    host.postToMain {
        try {
            current.onBatteryState(headsetBattery, headsetCharging, reportedRingBattery, reportedRingCharging)
        } catch (t: Throwable) {
            logWarn("listener onBatteryState failed", t)
        }
    }
}

internal fun GlassesSessionCore.emitFirmwareInfo(info: BleProtocol.FirmwareInfo) {
    val current = listener ?: return
    host.postToMain {
        try {
            current.onFirmwareInfo(info.leftVersion, info.rightVersion, info.extension)
        } catch (t: Throwable) {
            logWarn("listener onFirmwareInfo failed", t)
        }
    }
}

internal fun GlassesSessionCore.emitFrameMetrics(paintMs: Int, transmitMs: Int, tileCount: Int) {
    val current = listener ?: return
    host.postToMain {
        try {
            current.onFrameMetrics(paintMs, transmitMs, tileCount)
        } catch (t: Throwable) {
            logWarn("listener onFrameMetrics failed", t)
        }
    }
}

internal fun GlassesSessionCore.maybeEmitEvenAppConflictLocked(reason: String?) {
    if ("write failed" != reason) {
        return
    }
    val now = now()
    if (lastSessionReadyAtMs <= 0 || now - lastSessionReadyAtMs > ConnectionOptions.EVEN_APP_WRITE_FAILURE_WINDOW_MS) {
        return
    }
    if (lastEvenAppConflictAtMs > 0 && now - lastEvenAppConflictAtMs < 60_000) {
        return
    }
    if (!host.isEvenAppActive()) {
        return
    }
    lastEvenAppConflictAtMs = now
    emitEvenAppConflict("The Even Realities app still appears to be running. It can hold the glasses BLE link and cause Faceclaw write failures. Open its app settings and force stop it, then reconnect Faceclaw.")
}

internal fun GlassesSessionCore.emitEvenAppConflict(message: String?) {
    val current = listener ?: return
    val messageSnapshot = message ?: ""
    host.postToMain {
        try {
            current.onEvenAppConflict(messageSnapshot)
        } catch (t: Throwable) {
            logWarn("listener onEvenAppConflict failed", t)
        }
    }
}

internal fun GlassesSessionCore.setStateDisplay(nextPhase: String, nextStatus: String) {
    monitor.withLock {
        phase = nextPhase
        status = nextStatus
    }
    emitState()
}

internal fun GlassesSessionCore.emitState() {
    val current = listener ?: return
    val phaseSnapshot: String
    val statusSnapshot: String
    monitor.withLock {
        phaseSnapshot = phase
        statusSnapshot = status
    }
    host.postToMain {
        try {
            current.onStateChange(phaseSnapshot, statusSnapshot)
        } catch (t: Throwable) {
            logWarn("listener onStateChange failed", t)
        }
    }
}
