package com.faceclaw.app

import com.faceclaw.app.GlassesSessionCore.Companion.DASHBOARD_TILE
import com.faceclaw.app.GlassesSessionCore.Companion.safeMessage

/** Bytes of the arm's frame once everything queued for it has run, and what each arm last reported. */
internal class G1ArmState {
    var hello: G1Protocol.Hello? = null
    var battery = -1
    var charge = -1
    var inCase = -1
    var worn = -1

    /** Null: unknown, so the next update is a full frame. */
    var frame: ByteArray? = null

    fun resetLink() {
        hello = null
        battery = -1
        charge = -1
        inCase = -1
        worn = -1
        frame = null
    }
}

/**
 * Even G1 session state ([GlassesSessionCore.g1]); guarded by the core's monitor.
 *
 * A G1 is two independent devices on two BLE links, and neither hears what the other is sent. Each arm has its own
 * deflate stream (cfwTransports) and frame, each message goes to one arm and only that lens ACKs it, and the phone
 * composes each lens: the firmware has no display lists, so the shell scene is drawn here in its settled state.
 * Firmware: scouter_kit's g1v0 (g1_firmware/docs/VM.md §6.11, firmware/src/fc.c).
 */
internal class G1SessionState {
    val arms = arrayOf(G1ArmState(), G1ArmState())
    private var tag = 0
    val replies = HashMap<Int, G1Protocol.Reply>()
    var lastPropsAtMs = 0L

    /** The panel may be blank: the next update ends in PRESENT even with no pixels to send. */
    var presentPending = false

    fun nextTag(): Int {
        tag = tag % 255 + 1
        return tag
    }

    fun resetLink() {
        for (arm in arms) arm.resetLink()
        replies.clear()
        lastPropsAtMs = 0
        presentPending = true
    }
}

internal object G1Timings {
    const val CONTROL_REPLY_MS = 1_500L
    const val CONTROL_TRIES = 4
    /** The OS may be showing its pairing dialog. */
    const val PAIRING_MS = 30_000
    const val PROPS_MS = 60_000L
    const val LENS_LEFT = 1
    const val LENS_RIGHT = 2
}

private val G1_PROPS = intArrayOf(G1Protocol.PROP_BATT_PCT, G1Protocol.PROP_CHARGE, G1Protocol.PROP_IN_CASE, G1Protocol.PROP_WORN)

internal val GlassesSessionCore.isG1: Boolean get() = glassesType == GlassesType.G1

internal val GlassesSessionCore.isG2: Boolean get() = glassesType == GlassesType.G2

/** What the display path takes (fc.c); anything else a shared feature queues never goes out. */
internal fun g1SupportsMessage(message: OutboundMessage): Boolean {
    if (message.sid != CfwTransport.SID || message.message.isEmpty()) return false
    return when (message.message[0].toInt() and CFW_MSG_TYPE_MASK) {
        CFW_MSG_DRAW_CALLS, CFW_MSG_PRESENT, CFW_MSG_BRIGHTNESS -> true
        else -> false
    }
}

private fun GlassesSessionCore.g1ArmAddress(arm: Int): String = if (arm == 0) leftAddress else rightAddress

private fun g1Lens(arm: Int): Int = if (arm == 0) G1Timings.LENS_LEFT else G1Timings.LENS_RIGHT

// ---------------------------------------------------------------------------------------------
// Writes

/** The packets of one queued message, its record from this arm's persistent deflate stream. */
internal fun GlassesSessionCore.g1CfwWrites(message: OutboundMessage, mtu: Int): List<ByteArray> {
    val arm = if (message.isLeftArmMessage) 0 else 1
    val transport = cfwTransports[arm]
    if (message.cfwRetries > 0) transport.reset()
    return G1Protocol.packets(transport.encodeRecord(message.message, g1Lens(arm)), message.magic, mtu)
}

private fun GlassesSessionCore.g1WriteControl(address: String, op: Int, tag: Int, body: ByteArray): Boolean =
    link.writeFrames(address, G1Ble.CTRL_CHAR_UUID, listOf(G1Protocol.control(op, tag, body)),
        GattWriteMode.WITHOUT_RESPONSE, ConnectionOptions.WRITE_TIMEOUT_MS)

/**
 * A control request and its reply; worker thread, outside the monitor. Writes on a link the arm doesn't yet obey
 * (out of the case, before encryption) are ignored and control requests can be lost, so it asks again.
 */
private fun GlassesSessionCore.g1Control(arm: Int, op: Int, body: ByteArray = ByteArray(0)): G1Protocol.Reply {
    val address = g1ArmAddress(arm)
    repeat(G1Timings.CONTROL_TRIES) {
        val tag = monitor.withLock { g1.nextTag() }
        val key = arm * 256 + tag
        if (!g1WriteControl(address, op, tag, body)) throw IllegalStateException("control $op write failed")
        val deadline = now() + G1Timings.CONTROL_REPLY_MS
        monitor.withLock {
            while (true) {
                g1.replies.remove(key)?.let { return it }
                if (!running || userDisconnectRequested) throw IllegalStateException("stopped while waiting for control $op")
                if (!(if (arm == 0) leftConnected else rightConnected)) throw IllegalStateException("link lost waiting for control $op")
                val remaining = deadline - now()
                if (remaining <= 0) break
                monitor.awaitMs(minOf(remaining, 100L))
            }
        }
    }
    throw IllegalStateException("no reply to control $op from the " + (if (arm == 0) "left" else "right") + " arm")
}

private fun GlassesSessionCore.g1RequestProps(arm: Int) {
    val tag = monitor.withLock { g1.nextTag() }
    g1WriteControl(g1ArmAddress(arm), G1Protocol.OP_PROPS, tag, ByteArray(G1_PROPS.size) { G1_PROPS[it].toByte() })
}

/** Nothing here keeps a lease; this only refreshes the battery. Worker thread, outside the monitor. */
internal fun GlassesSessionCore.g1Maintain() {
    val due = monitor.withLock {
        val now = now()
        val due = sessionReady && now - g1.lastPropsAtMs >= G1Timings.PROPS_MS
        if (due) g1.lastPropsAtMs = now
        due
    }
    if (due) {
        g1RequestProps(0)
        g1RequestProps(1)
    }
}

// ---------------------------------------------------------------------------------------------
// Frames (under the monitor, from enqueueDesiredImageLocked)

/** Whatever was queued is gone, so what the arms' frames will hold is unknown. */
internal fun GlassesSessionCore.g1ForgetFramesLocked() {
    if (!isG1) return
    for (arm in g1.arms) arm.frame = null
    g1.presentPending = true
    for (transport in cfwTransports) transport.reset()
}

/**
 * Compose each lens in the frame's settled state, send what changed against the arm's frame, and end with PRESENT.
 * The two arms' messages alternate so that neither eye runs far ahead, and the PRESENTs go out last and side by side.
 * A blanked frame sends nothing: the panel waits in standby with the last picture in the arm's frame, and the next
 * visible frame is a delta against it.
 */
internal fun GlassesSessionCore.g1EnqueueFrameLocked(
    packed: ByteArray, width: Int, height: Int, scene: ShellScene, fingerprint: String, paintMs: Int, frameId: Int,
) {
    if (fingerprint.startsWith("blanked:")) {
        lastEnqueuedFingerprint = fingerprint
        displayedFingerprint = fingerprint
        finishFrame(frameId, "blanked: the panel is in standby")
        return
    }
    frameTimings.spanStart(frameId, "compose-lenses")
    val updates: List<List<ByteArray>>
    val composed: Array<ByteArray>
    try {
        val left = scene.composed(packed, width, height, false)
        val right = if (scene.hasStereoDepth) scene.composed(packed, width, height, true) else left
        composed = arrayOf(left, right)
        updates = List(2) { arm -> G1FramePlanner.plan(g1.arms[arm].frame, composed[arm], width, height) }
    } catch (e: Exception) {
        // As in the G2's path: this frame would fail the same way after a reconnect (#42), so drop it.
        lastEnqueuedFingerprint = fingerprint
        logLine("frame plan failed; frame dropped: " + safeMessage(e))
        finishFrame(frameId, "discarded: frame plan failed")
        return
    }
    frameTimings.spanEnd(frameId, "compose-lenses")
    val force = g1.presentPending
    val queues = List(2) { arm ->
        ArrayDeque(updates[arm]).also { if (it.isNotEmpty() || force) it.addLast(byteArrayOf(CFW_MSG_PRESENT.toByte())) }
    }
    g1.presentPending = false
    for (arm in 0..1) g1.arms[arm].frame = composed[arm]
    lastEnqueuedFingerprint = fingerprint
    val messageCount = queues.sumOf { it.size }
    if (messageCount == 0) {
        displayedFingerprint = fingerprint
        finishFrame(frameId, "no change on either lens")
        return
    }
    val updateId = nextImageUpdateId++
    imageUpdateStats[updateId] = BleImageOptimizer.ImageUpdateStats(paintMs, 1, frameId)
    var number = 0
    var payloadBytes = 0
    var arm = 0
    while (queues[0].isNotEmpty() || queues[1].isNotEmpty()) {
        // The other arm's turn once this one is down to its PRESENT, so that both PRESENTs come last.
        val other = 1 - arm
        val waiting = queues[arm].size == 1 && queues[other].size > 1
        if (queues[arm].isEmpty() || waiting) {
            arm = other
            continue
        }
        val payload = queues[arm].removeFirst()
        payloadBytes += payload.size
        number++
        val plan = BleImageOptimizer.TileImagePlan(arm, DASHBOARD_TILE, composed[arm], width, height, nextMapSessionId(), payload)
        enqueueCustomImageLocked(plan, payload, fingerprint, updateId, number, messageCount, arm == 0, g1Lens(arm))
        arm = other
    }
    frameTimings.log(frameId, "queued image update#$updateId messages=$messageCount payload=${payloadBytes}B")
    logLine("queue image update#$updateId fingerprint=$fingerprint messages=$messageCount")
}

/** Message 30 for both arms, its visibility ordered with the frames around it. */
internal fun GlassesSessionCore.g1EnqueueBrightnessLocked(payload: ByteArray, label: String, visibleChanged: Boolean, onTimeout: MessageCallback) {
    for (arm in 0..1) {
        val message = messageBuilder.customMessage("brightness-output", payload, label, -1, arm == 0)
        message.cfwRequiredLenses = g1Lens(arm)
        message.onTimeout = onTimeout
        pendingMessages.addLast(message)
    }
    if (visibleChanged) g1.presentPending = true
}

private fun GlassesSessionCore.g1HidePayload(): ByteArray =
    byteArrayOf(CFW_MSG_BRIGHTNESS.toByte(), 1, brightnessPolicy.target.coerceIn(0, 100).toByte(), 0, 0, 0)

/** Stop drawing, keeping the links and the arms' frames: the panels wait in standby (the EvenHub suspend analogue). */
internal fun GlassesSessionCore.g1Suspend(): Boolean {
    monitor.withLock {
        if (!running || !sessionReady) return false
        val idle = pendingMessages.isEmpty() && inFlightMessages.isEmpty()
        val frames = g1.arms.map { it.frame }
        shutdownRequested = true
        clearAllMessagesLocked("G1 suspend")
        // Nothing was lost, so the arms still hold what the phone thinks and a wake is a delta.
        if (idle) for (arm in 0..1) g1.arms[arm].frame = frames[arm]
        g1EnqueueBrightnessLocked(g1HidePayload(), "suspend: hide", true) { }
        brightnessSentVisible = false
        displayedFingerprint = ""
    }
    interruptibleSleep.interrupt()
    return true
}

/** The drive loop resends the desired frame; its PRESENT brings the panels back. */
internal fun GlassesSessionCore.g1Resume(): Boolean {
    monitor.withLock {
        if (!running || !sessionReady) return false
        shutdownRequested = false
        displayedFingerprint = ""
        lastEnqueuedFingerprint = ""
        imageRetryAfterMs = 0
        g1.presentPending = true
    }
    interruptibleSleep.interrupt()
    return true
}

/**
 * At the end of a session: the panels off now rather than 30 s from now, when the firmware's own rule would do it.
 * A raw record that resets the stream, not waited on; nothing follows it.
 */
internal fun GlassesSessionCore.g1HideBeforeDisconnect() {
    val message = g1HidePayload()
    val record = CfwTransport.record(message, CfwTransport.crc(message), CfwTransport.BOTH or CfwTransport.RESET_CONTEXT)
    for (arm in 0..1) {
        val address = g1ArmAddress(arm)
        if (!link.isConnected(address)) continue
        try {
            link.writeFrames(address, G1Ble.FC_CHAR_UUID, G1Protocol.packets(record, 0, link.negotiatedMtu(address)),
                GattWriteMode.WITHOUT_RESPONSE, ConnectionOptions.WRITE_TIMEOUT_MS)
        } catch (t: Throwable) {
            logLine("G1 hide failed: " + safeMessage(t))
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Connect (worker thread)

private fun GlassesSessionCore.g1ConnectArm(arm: Int, deadlineMs: Long) {
    val address = g1ArmAddress(arm)
    val timeoutMs = maxOf(deadlineMs - now(), ConnectionOptions.CONNECT_TIMEOUT_MS.toLong())
    if (!link.connect(address, timeoutMs.toInt())) {
        throw ArmUnreachableException(if (arm == 0) "left" else "right", address)
    }
    link.requestHighPriority(address)
    link.requestMtu(address, G1Ble.REQUESTED_MTU, ConnectionOptions.CONNECT_TIMEOUT_MS)
    if (!link.discoverServices(address, ConnectionOptions.SERVICES_TIMEOUT_MS)) {
        throw IllegalStateException("discoverServices failed: $address")
    }
    if (!link.enableNotifications(address, G1Ble.EVT_CHAR_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS)) {
        throw IllegalStateException("no event characteristic on $address: not g1v0 firmware?")
    }
    link.requestLe2mPhy(address)
    monitor.withLock {
        if (arm == 0) leftConnected = true else rightConnected = true
    }
}

/**
 * A write with response to PAIR needs an encrypted link. A bonded arm gets one at once; an arm in the case bonds here,
 * through whatever the OS does (Android's dialog, iOS's); out of the case the arm refuses a new bond and the write fails.
 * Either way this is where the link is known to be encrypted, so the arm obeys everything that follows.
 */
private fun GlassesSessionCore.g1Pair(arm: Int) {
    val address = g1ArmAddress(arm)
    if (!link.isBonded(address)) {
        logLine("G1 " + (if (arm == 0) "left" else "right") + " arm: asking the OS to pair")
        setStateDisplay("connecting", "Pairing with the glasses...")
        link.requestBond(address)
        val deadline = now() + G1Timings.PAIRING_MS
        while (!link.isBonded(address) && now() < deadline) {
            interruptibleSleep.sleep(200)
            if (!monitor.withLock { running && !userDisconnectRequested }) throw IllegalStateException("stopped while pairing")
        }
    }
    if (!link.writeFrames(address, G1Ble.PAIR_CHAR_UUID, listOf(byteArrayOf(1)), GattWriteMode.WITH_RESPONSE, G1Timings.PAIRING_MS)) {
        throw IllegalStateException("no encrypted link to the " + (if (arm == 0) "left" else "right") + " arm")
    }
}

internal fun GlassesSessionCore.g1ConnectLoopOnce() {
    monitor.withLock {
        wearState = -1
        g1.resetLink()
    }
    setStateDisplay("connecting", "Connecting to the glasses...")
    ConnectionCounters.increment("g1.connect-attempt")
    try {
        val deadlineMs = now() + ConnectionOptions.ARM_CONNECT_WINDOW_MS
        link.beginConnect(rightAddress, false)
        link.beginConnect(leftAddress, false)
        // The left first, as the arms were installed; each stands alone.
        g1ConnectArm(0, deadlineMs)
        g1ConnectArm(1, deadlineMs)
        g1Pair(0)
        g1Pair(1)

        val versions = arrayOf("", "")
        var compatible = true
        for (arm in 0..1) {
            val reply = g1Control(arm, G1Protocol.OP_HELLO)
            val hello = G1Protocol.parseHello(reply.body) ?: throw IllegalStateException("bad HELLO from arm $arm")
            monitor.withLock { g1.arms[arm].hello = hello }
            versions[arm] = "g1v0 " + hello.version + (if (hello.safeMode) " (safe mode)" else "")
            if (hello.leftArm != (arm == 0)) {
                logWarn("G1: the arm paired as " + (if (arm == 0) "left" else "right") + " says it is the other one; its lens gets the other eye's frame")
            }
            val info = g1Control(arm, G1Protocol.OP_FC_INFO)
            val fcVersion = if (info.status == 0) G1Protocol.parseFcVersion(info.body) else -1
            logLine("G1 " + (if (arm == 0) "left" else "right") + " arm: " + versions[arm]
                + " display path " + fcVersion + " encrypted=" + hello.encrypted + " inCase=" + hello.inCase
                + " panelOk=" + hello.panelOk + " phy=" + link.describePhy(g1ArmAddress(arm)))
            compatible = compatible && fcVersion >= 1
        }
        // The firmware's own number, not the G2 custom firmware's: the path has one version so far, and TS compares this.
        val firmware = BleProtocol.FirmwareInfo(versions[0], versions[1],
            if (compatible) BleProtocol.FirmwareInfo.FACECLAW_EXTENSION_PREFIX + requiredFirmwareRevision else "")
        emitFirmwareInfo(firmware)
        if (!compatible) {
            monitor.withLock { incompatibleFirmware = firmware }
            return
        }
        for (arm in 0..1) {
            val events = g1Control(arm, G1Protocol.OP_EVENTS, G1Protocol.eventsRequest(G1Protocol.EVENTS_MASK))
            if (events.status != 0) throw IllegalStateException("EVENTS refused: " + events.status)
            // The arm counts a boot healthy only after a host has said so (VM.md §6.4, safe mode).
            g1Control(arm, G1Protocol.OP_HEALTH_OK)
        }
        monitor.withLock {
            sessionReady = true
            shutdownRequested = false
            customFirmwareDetected = true
            clearAllMessagesLocked("session ready")
            fixedLayoutCreated = true
            displayedFingerprint = ""
            lastAckAtMs = now()
            lastIncomingAtMs = lastAckAtMs
            lastConnectionOrInputAtMs = lastAckAtMs
            lastSessionReadyAtMs = lastAckAtMs
            imageRetryAfterMs = 0
            consecutiveAckTimeouts = 0
            cfwCleanupDelivered = false
            lastCfwCleanupAckMagic = 0
            g1.lastPropsAtMs = 0
            monitor.signalAll()
        }
        setStateDisplay("connected", "Connected.")
        interruptibleSleep.interrupt()
    } catch (t: Throwable) {
        logLine("G1 connect failed: " + safeMessage(t))
        val unpaired = firstUnpairedArm()
        if (unpaired != null) {
            logError("G1 connect failed and $unpaired is not paired; suspending reconnect")
            ConnectionCounters.increment("g1.unpaired")
            monitor.withLock { haltReconnectLocked("arm not paired: $unpaired") }
            if (!userDisconnectRequested) {
                setStateDisplay("unpaired", "The glasses are not paired with this phone. Put them in their charging case"
                    + " with the lid open, then connect: they only pair in the case.")
            }
            interruptibleSleep.interrupt()
        } else if (t is ArmUnreachableException) {
            val other = if (t.side == "left") rightAddress else leftAddress
            if (link.isConnected(other)) {
                handleTransportFailure(t.side + " arm not found", "Can't reach the " + t.side + " arm of the glasses."
                    + " It may be connected to another device, or be off or out of range.")
            } else {
                handleTransportFailure("glasses not found", "Can't find the glasses. They may be off or out of range.")
            }
        } else {
            handleTransportFailure("connect failed")
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Inbound (BLE callback thread)

internal fun GlassesSessionCore.g1OnNotification(address: String, characteristicUuid: String, data: ByteArray) {
    if (G1Ble.EVT_CHAR_UUID != characteristicUuid) return
    val arm = armIndex(address)
    if (arm < 0) return
    when (val type = G1Protocol.eventType(data)) {
        G1Protocol.EV_FC_ACK -> {
            val ack = G1Protocol.parseFcAck(data) ?: return
            monitor.withLock { acceptCfwAcksLocked(address, arrayOf(ack), 0, data) }
            interruptibleSleep.interrupt()
        }
        G1Protocol.EV_INPUT -> g1HandleInput(arm, G1Protocol.parseInput(data) ?: return)
        else -> if (type >= 0x80) {
            val reply = G1Protocol.parseReply(data) ?: return
            if (reply.op == G1Protocol.OP_PROPS) {
                if (reply.status == 0) G1Protocol.parseProps(reply.body, G1_PROPS.size)?.let { g1HandleProps(arm, it) }
                return
            }
            monitor.withLock {
                lastIncomingAtMs = now()
                g1.replies[arm * 256 + reply.tag] = reply
                monitor.signalAll()
            }
        }
    }
}

private fun GlassesSessionCore.g1HandleInput(arm: Int, input: G1Protocol.Input) {
    when (input.trigger) {
        G1Protocol.TRIGGER_TOUCH -> g1HandleGesture(arm, input.value)
        G1Protocol.TRIGGER_BATTERY -> g1HandleProps(arm, intArrayOf(input.value, G1Protocol.UNKNOWN, G1Protocol.UNKNOWN, G1Protocol.UNKNOWN), true)
        G1Protocol.TRIGGER_WEAR -> g1HandleProps(arm, intArrayOf(G1Protocol.UNKNOWN, G1Protocol.UNKNOWN, G1Protocol.UNKNOWN, input.value))
        G1Protocol.TRIGGER_CASE -> g1HandleProps(arm, intArrayOf(G1Protocol.UNKNOWN, G1Protocol.UNKNOWN, input.value and 1, G1Protocol.UNKNOWN))
    }
}

private fun GlassesSessionCore.g1HandleGesture(arm: Int, gesture: Int) {
    val leftArm = arm == 0
    val dark = monitor.withLock { shutdownRequested || brightnessSentVisible == false }
    val eventType = G1Protocol.gestureEventType(gesture, leftArm, dark)
    monitor.withLock {
        lastIncomingAtMs = now()
        if (eventType != null) lastConnectionOrInputAtMs = lastIncomingAtMs
    }
    logLine("G1 gesture " + gesture + " on the " + (if (leftArm) "left" else "right") + " arm" + (if (eventType == null) " (ignored)" else ""))
    if (eventType == null) return
    val source = if (leftArm) BleProtocol.EVENT_SOURCE_GLASSES_L else BleProtocol.EVENT_SOURCE_GLASSES_R
    // As the G2's firmware reports its own double tap on a dark display: it can only wake, whatever the delay.
    val event = if (dark && gesture == G1Protocol.GESTURE_DOUBLE_TAP) G2Event("display-wake", "", eventType, 0, 0)
        else G2Event("sys-event", "", eventType, source, 0)
    val frameId = frameTimings.startFrame("input:" + event.kind + " type=$eventType src=$source")
    frameTimings.log(frameId, "input event decoded from G1 notification")
    emitRingEvent(event, frameId)
    interruptibleSleep.interrupt()
}

/**
 * New values in the order of [G1_PROPS], [G1Protocol.UNKNOWN] for those it doesn't say. The pair's battery is the lower
 * arm's, the pair is charging if either arm is, worn if either arm says so, and in the case when both are.
 * [batteryChanged]: a BATTERY event, which may also mean CHARGE changed, so that is read again.
 */
private fun GlassesSessionCore.g1HandleProps(arm: Int, values: IntArray, batteryChanged: Boolean = false) {
    var batteryEmit = false
    var wearEmit = -1
    var putOn = false
    val state = g1.arms[arm]
    monitor.withLock {
        lastIncomingAtMs = now()
        if (values[0] != G1Protocol.UNKNOWN) state.battery = values[0]
        if (values[1] != G1Protocol.UNKNOWN) state.charge = values[1]
        if (values[2] != G1Protocol.UNKNOWN) state.inCase = values[2]
        if (values[3] != G1Protocol.UNKNOWN) state.worn = values[3]

        val batteries = g1.arms.map { it.battery }.filter { it >= 0 }
        val battery = if (batteries.isEmpty()) -1 else batteries.min()
        val charging = if (g1.arms.any { it.charge == G1Protocol.CHARGE_CHARGING }) 1 else if (g1.arms.all { it.charge < 0 }) -1 else 0
        if (battery != headsetBattery || charging != headsetCharging) {
            headsetBattery = battery
            headsetCharging = charging
            batteryEmit = true
        }
        val worn = if (g1.arms.any { it.worn == 1 }) 1 else if (g1.arms.all { it.worn < 0 }) -1 else 0
        if (worn >= 0 && worn != wearState) {
            putOn = chargingMode && wearState == 0 && worn == 1
            wearState = worn
            wearEmit = worn
        }
        if (sessionReady) {
            val inCase = g1.arms.all { it.inCase == 1 }
            if (putOn) {
                endChargingModeLocked("glasses put on")
            } else if (inCase != chargingMode && g1.arms.all { it.inCase >= 0 }) {
                g1SetInCaseLocked(inCase, battery)
            }
        }
    }
    if (batteryEmit) emitBatteryState(headsetBattery, headsetCharging)
    if (wearEmit >= 0) emitWearState(wearEmit == 1)
    if (batteryChanged) g1RequestPropsLater()
    interruptibleSleep.interrupt()
}

private fun GlassesSessionCore.g1RequestPropsLater() {
    monitor.withLock { g1.lastPropsAtMs = 0 }
}

/**
 * In the case nobody can see the panels, and lit pixels disturb the case's charging link: they go dark and frames stop.
 * Leaving the case reconnects, as on a G2, which also picks up a firmware the arms got meanwhile.
 */
private fun GlassesSessionCore.g1SetInCaseLocked(inCase: Boolean, battery: Int) {
    if (inCase) {
        chargingMode = true
        clearAllMessagesLocked("glasses in the case")
        fixedLayoutCreated = false
        displayedFingerprint = ""
        g1EnqueueBrightnessLocked(g1HidePayload(), "in the case: hide", true) { }
        finishDesiredFrameLocked("discarded: glasses in the case")
        logLine("glasses are in the case; pausing display communication")
        setStateDisplay("charging", GlassesSessionCore.chargingStatusText(battery))
    } else {
        endChargingModeLocked("glasses out of the case")
    }
}
