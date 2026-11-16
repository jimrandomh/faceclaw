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

    /** What a PROPS request asked for, by arm and tag: a reply doesn't repeat it. */
    val propRequests = HashMap<Int, IntArray>()
    /** `PROP_SET`s for the worker thread to write: arm to body. */
    val pendingPropSets = ArrayList<Pair<Int, ByteArray>>()
    var lastLightAtMs = 0L
    /** The last reading that made it to the log, in 0.01 lux. */
    var loggedLight = -1
    /** IMU samples are polled this often while someone wants them; 0: nobody does. */
    var imuPeriodMs = 0L
    var lastImuAtMs = 0L
    var micOn = false
    var lastMicRenewAtMs = 0L
    val mic = G1MicAssembler()
    /** The right arm's relay is there and this host listens to it. */
    var ancsRelay = false

    /** When an arm dropped while the session carried on with the other; 0: its link is up. */
    val armDownSinceMs = LongArray(2)
    /** When to ask for a lost arm's link again. */
    val armRetryAtMs = LongArray(2)
    /** How long the session carries on with one arm before it starts over. */
    var armRecoveryMs = G1Timings.ARM_RECOVERY_MS

    fun nextTag(): Int {
        tag = tag % 255 + 1
        return tag
    }

    fun resetLink() {
        for (arm in arms) arm.resetLink()
        replies.clear()
        lastPropsAtMs = 0
        presentPending = true
        propRequests.clear()
        pendingPropSets.clear()
        lastLightAtMs = 0
        lastImuAtMs = 0
        micOn = false
        lastMicRenewAtMs = 0
        mic.reset()
        ancsRelay = false
        armDownSinceMs.fill(0)
        armRetryAtMs.fill(0)
    }
}

internal object G1Timings {
    const val CONTROL_REPLY_MS = 1_500L
    const val CONTROL_TRIES = 4
    /** The OS may be showing its pairing dialog. */
    const val PAIRING_MS = 30_000
    const val PROPS_MS = 60_000L
    /** Well inside the arm's 2 s lease. */
    const val MIC_RENEW_MS = 1_000L
    /** The sensor converts in 800 ms. */
    const val LIGHT_DEMO_MS = 800L
    const val LIGHT_AUTO_MS = 1_000L
    const val LIGHT_MANUAL_MS = 5_000L
    /** The G2's IMU rate is a pace code with no meaning here, and a poll is one round trip. */
    const val IMU_POLL_MS = 50L
    const val IDLE_WAKE_MS = 500L
    const val LENS_LEFT = 1
    const val LENS_RIGHT = 2
    const val ARM_RECOVERY_MS = 15_000L
    const val ARM_RETRY_MS = 1_000L
    /** With the other arm's traffic waiting behind it. */
    const val ARM_RECOVERY_WRITE_MS = 5_000

    /** An arm advertises fast for a minute after a disconnection, so most links are back at once. */
    val RECONNECT_BACKOFF_MS = intArrayOf(500, 1_000, 2_000, 4_000, 8_000)
}

/** An arm bonds only once it knows it's in the case, and a full case only says so about every 5 minutes. */
private const val G1_CASE_DELAY_HINT = "A fully charged arm can take up to 5 minutes to notice it's in the case."

/** What the Install prompt says an arm runs when it isn't g1v0. */
private const val G1_OTHER_FIRMWARE = "Even's firmware"
private val G1_PROPS = intArrayOf(G1Protocol.PROP_BATT_PCT, G1Protocol.PROP_CHARGE, G1Protocol.PROP_IN_CASE, G1Protocol.PROP_WORN)
private val G1_LIGHT = intArrayOf(G1Protocol.PROP_LIGHT)
private val G1_IMU = intArrayOf(G1Protocol.PROP_ACC_X, G1Protocol.PROP_ACC_Y, G1Protocol.PROP_ACC_Z)

internal val GlassesSessionCore.isG1: Boolean get() = glassesType == GlassesType.G1

internal val GlassesSessionCore.isG2: Boolean get() = glassesType == GlassesType.G2

/** What the display path takes (fc.c); anything else a shared feature queues never goes out. */
internal fun g1SupportsMessage(message: OutboundMessage): Boolean {
    if (message.sid != CfwTransport.SID || message.message.isEmpty()) return false
    return when (message.message[0].toInt() and CFW_MSG_TYPE_MASK) {
        CFW_MSG_DRAW_CALLS, CFW_MSG_PRESENT, CFW_MSG_BRIGHTNESS -> true
        // The bandwidth benchmark's no-op: the firmware acknowledges what it doesn't know.
        CFW_MSG_DIAGNOSTICS -> message.kind == "bandwidth"
        else -> false
    }
}

private fun GlassesSessionCore.g1ArmAddress(arm: Int): String = if (arm == 0) leftAddress else rightAddress

private fun g1Side(arm: Int): String = if (arm == 0) "left" else "right"

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
private fun GlassesSessionCore.g1Control(arm: Int, op: Int, body: ByteArray = ByteArray(0), tries: Int = G1Timings.CONTROL_TRIES): G1Protocol.Reply {
    val address = g1ArmAddress(arm)
    repeat(tries) {
        val tag = monitor.withLock { g1.nextTag() }
        val key = arm * 256 + tag
        val written = try {
            g1WriteControl(address, op, tag, body)
        } catch (e: IllegalStateException) {
            false
        }
        if (!written) throw G1ConnectException(g1Side(arm) + " arm dropped", "The " + g1Side(arm) + " arm dropped the connection.")
        val deadline = now() + G1Timings.CONTROL_REPLY_MS
        monitor.withLock {
            while (true) {
                g1.replies.remove(key)?.let { return it }
                if (!running || userDisconnectRequested) throw IllegalStateException("stopped while waiting for control $op")
                if (!(if (arm == 0) leftConnected else rightConnected)) {
                    throw G1ConnectException(g1Side(arm) + " arm dropped", "The " + g1Side(arm) + " arm dropped the connection.")
                }
                val remaining = deadline - now()
                if (remaining <= 0) break
                monitor.awaitMs(minOf(remaining, 100L))
            }
        }
    }
    throw G1ConnectException(g1Side(arm) + " arm silent", "The " + g1Side(arm) + " arm isn't answering.")
}

private fun GlassesSessionCore.g1RequestProps(arm: Int, ids: IntArray) {
    val tag = monitor.withLock {
        val tag = g1.nextTag()
        g1.propRequests[arm * 256 + tag] = ids
        tag
    }
    g1WriteControl(g1ArmAddress(arm), G1Protocol.OP_PROPS, tag, ByteArray(ids.size) { ids[it].toByte() })
}

/**
 * The firmware keeps no session of its own for most of this: the worker polls what it wants to know, keeps the
 * microphone's lease and writes the properties that were asked for. Worker thread, outside the monitor.
 */
internal fun GlassesSessionCore.g1Maintain() {
    g1RecoverArms()
    var status = false
    var mic: Boolean? = null
    var light = false
    var imu = false
    var sets: List<Pair<Int, ByteArray>> = emptyList()
    val up = BooleanArray(2)
    monitor.withLock {
        if (!sessionReady) return
        val now = now()
        for (arm in 0..1) up[arm] = g1.armDownSinceMs[arm] == 0L
        if (now - g1.lastPropsAtMs >= G1Timings.PROPS_MS) {
            status = true
            g1.lastPropsAtMs = now
        }
        // What only the right arm has waits for it to come back, which starts all of it again.
        if (!up[1]) {
            // Nothing to do here.
        } else if (audioCaptureActive) {
            if (now - g1.lastMicRenewAtMs >= G1Timings.MIC_RENEW_MS) {
                mic = true
                g1.micOn = true
                g1.lastMicRenewAtMs = now
            }
        } else if (g1.micOn) {
            mic = false
            g1.micOn = false
        }
        // The sensor only reads while the panel is on; a dark panel keeps the last filtered value.
        val interval = if (brightnessDemoPolling) G1Timings.LIGHT_DEMO_MS
            else if (brightnessPolicy.automatic) G1Timings.LIGHT_AUTO_MS else G1Timings.LIGHT_MANUAL_MS
        if (up[1] && brightnessSentVisible == true && !chargingMode && !shutdownRequested && now - g1.lastLightAtMs >= interval) {
            light = true
            g1.lastLightAtMs = now
        }
        if (up[1] && g1.imuPeriodMs > 0 && now - g1.lastImuAtMs >= g1.imuPeriodMs) {
            imu = true
            g1.lastImuAtMs = now
        }
        if (g1.pendingPropSets.isNotEmpty()) {
            sets = g1.pendingPropSets.filter { up[it.first] }
            g1.pendingPropSets.clear()
        }
    }
    if (status) {
        for (arm in 0..1) if (up[arm]) g1RequestProps(arm, G1_PROPS)
    }
    mic?.let { on ->
        val tag = monitor.withLock { g1.nextTag() }
        g1WriteControl(rightAddress, G1Protocol.OP_MIC, tag, G1Protocol.micRequest(on))
    }
    if (light) g1RequestProps(1, G1_LIGHT)
    if (imu) g1RequestProps(1, G1_IMU)
    for ((arm, body) in sets) {
        val tag = monitor.withLock { g1.nextTag() }
        g1WriteControl(g1ArmAddress(arm), G1Protocol.OP_PROP_SET, tag, body)
    }
}

/** The longest the session worker may sleep and keep up with [g1Maintain]. */
internal fun GlassesSessionCore.g1MaxSleepMs(): Long =
    monitor.withLock { if (g1.imuPeriodMs > 0) g1.imuPeriodMs else G1Timings.IDLE_WAKE_MS }

/**
 * The right arm's microphone: 16 kHz mono LC3, in the packets the G2's decoder takes. The arm stops it 2 s after the last
 * renewal and at a disconnection; meanwhile it shows its indicator in a corner of the panel (VM.md §6.5).
 */
internal fun GlassesSessionCore.g1StartAudioCapture(listener: FaceclawAudioPacketListener): Boolean {
    monitor.withLock {
        if (!running || !sessionReady || shutdownRequested) {
            logLine("skip G1 mic: session not ready")
            return false
        }
        if (g1.arms[1].hello?.mic != true) {
            logLine("skip G1 mic: this arm has no capture")
            return false
        }
        g1.mic.reset()
        audioPacketListener = listener
        audioCaptureActive = true
        g1.lastMicRenewAtMs = 0
    }
    interruptibleSleep.interrupt()
    return true
}

internal fun GlassesSessionCore.g1StopAudioCapture() {
    monitor.withLock {
        audioPacketListener = null
        audioCaptureActive = false
    }
    interruptibleSleep.interrupt()
}

/**
 * There is no magnetometer on a G1, only the accelerometer and gyroscope: x, y, z in g, head frame, from the right arm.
 * [enable] raises the sample rate and polls it; [g1MaxSleepMs] follows.
 */
internal fun GlassesSessionCore.g1SetImuReport(enable: Boolean) {
    monitor.withLock {
        g1.imuPeriodMs = if (enable) G1Timings.IMU_POLL_MS else 0
        g1.lastImuAtMs = 0
        g1.pendingPropSets.add(1 to G1Protocol.propSet(G1Protocol.PROP_IMU_RATE,
            if (enable) G1Protocol.IMU_RATE_STREAM else G1Protocol.IMU_RATE_IDLE))
    }
    interruptibleSleep.interrupt()
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
        // An arm that's away gets all of this when it's back: its frame stays unknown until then.
        updates = List(2) { arm ->
            if (g1.armDownSinceMs[arm] != 0L) emptyList() else G1FramePlanner.plan(g1.arms[arm].frame, composed[arm], width, height)
        }
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
        ArrayDeque(updates[arm]).also {
            if (g1.armDownSinceMs[arm] == 0L && (it.isNotEmpty() || force)) it.addLast(byteArrayOf(CFW_MSG_PRESENT.toByte()))
        }
    }
    g1.presentPending = false
    for (arm in 0..1) if (g1.armDownSinceMs[arm] == 0L) g1.arms[arm].frame = composed[arm]
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
        if (g1.armDownSinceMs[arm] != 0L) continue
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

/** The arm has no g1v0 service: it runs Even's firmware. */
private class G1OtherFirmwareException : Exception("not g1v0 firmware")

/**
 * A connection that failed in a way the wearer can be told: [reason] for the log and counters, [display] for the screen.
 * [repairing]: a stale pairing was just removed, and the next attempt makes a new one.
 */
private class G1ConnectException(reason: String, val display: String, val repairing: Boolean = false) : Exception(reason)

/**
 * Subscribes to the arm's events, which is also where its firmware shows. An arm keeps its address across an install, and the
 * OS may remember the services it had before: read them again before believing the table either way.
 */
private fun GlassesSessionCore.g1SubscribeEvents(arm: Int) {
    val address = g1ArmAddress(arm)
    val timeoutMs = ConnectionOptions.SERVICES_TIMEOUT_MS
    if (!link.hasCharacteristic(address, G1Ble.EVT_CHAR_UUID)) {
        logLine("G1 " + g1Side(arm) + " arm: no event characteristic, reading its services again")
        link.refreshServices(address, timeoutMs)
    }
    if (!link.hasCharacteristic(address, G1Ble.EVT_CHAR_UUID)) {
        if (!link.isConnected(address)) throw G1ConnectException(g1Side(arm) + " arm dropped", "The " + g1Side(arm) + " arm dropped the connection.")
        throw G1OtherFirmwareException()
    }
    fun subscribe(): Boolean = try {
        link.enableNotifications(address, G1Ble.EVT_CHAR_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS)
    } catch (e: IllegalStateException) {
        false
    }
    if (subscribe()) return
    if (link.isConnected(address)) {
        // A table that lists it and an arm that refuses: the table may be old in the other direction.
        link.refreshServices(address, timeoutMs)
        if (!link.hasCharacteristic(address, G1Ble.EVT_CHAR_UUID)) throw G1OtherFirmwareException()
        if (subscribe()) return
    }
    throw G1ConnectException(g1Side(arm) + " arm dropped", "The " + g1Side(arm) + " arm dropped the connection.")
}

private fun GlassesSessionCore.g1ConnectArm(arm: Int, deadlineMs: Long) {
    val address = g1ArmAddress(arm)
    val timeoutMs = maxOf(deadlineMs - now(), ConnectionOptions.CONNECT_TIMEOUT_MS.toLong())
    if (!link.connect(address, timeoutMs.toInt())) {
        throw ArmUnreachableException(if (arm == 0) "left" else "right", address)
    }
    link.requestHighPriority(address)
    link.requestMtu(address, G1Ble.REQUESTED_MTU, ConnectionOptions.CONNECT_TIMEOUT_MS)
    if (!link.discoverServices(address, ConnectionOptions.SERVICES_TIMEOUT_MS)) {
        throw G1ConnectException(g1Side(arm) + " arm dropped", "The " + g1Side(arm) + " arm dropped the connection.")
    }
    g1SubscribeEvents(arm)
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
private fun GlassesSessionCore.g1Pair(arm: Int, writeTimeoutMs: Int = G1Timings.PAIRING_MS) {
    val address = g1ArmAddress(arm)
    if (!link.isBonded(address)) {
        logLine("G1 " + g1Side(arm) + " arm: asking the OS to pair")
        setStateDisplay("connecting", "Pairing with the glasses...")
        link.requestBond(address)
        val deadline = now() + G1Timings.PAIRING_MS
        while (!link.isBonded(address) && now() < deadline) {
            interruptibleSleep.sleep(200)
            if (!monitor.withLock { running && !userDisconnectRequested }) throw IllegalStateException("stopped while pairing")
        }
    }
    val encrypted = try {
        link.writeFrames(address, G1Ble.PAIR_CHAR_UUID, listOf(byteArrayOf(1)), GattWriteMode.WITH_RESPONSE, writeTimeoutMs)
    } catch (e: IllegalStateException) {
        false
    }
    if (encrypted) return
    if (!link.isConnected(address)) {
        throw G1ConnectException(g1Side(arm) + " arm dropped", "The " + g1Side(arm) + " arm dropped the connection.")
    }
    // The link is up and the arm won't encrypt it. If the OS says this phone is bonded, the arm has lost its half: it has
    // since paired on Even's firmware or with other hosts. Only an arm in the case can pair again, so that's the only time a
    // bond is safe to give up. An unencrypted link gets an answer from nothing else, and this is the only way to ask.
    if (link.isBonded(address) && g1InCaseWithoutEncryption(arm) && link.removeBond(address)) {
        logLine("G1 " + g1Side(arm) + " arm: it lost this phone's pairing; removed it, pairing again")
        throw G1ConnectException(g1Side(arm) + " arm pairing removed", "Pairing with the glasses again.", repairing = true)
    }
    throw G1ConnectException(g1Side(arm) + " arm stale pairing", "The glasses don't recognize this phone's pairing. Put them in their "
        + "charging case with the lid open to pair again; if that doesn't help, remove them from this phone's Bluetooth settings. "
        + G1_CASE_DELAY_HINT)
}

private fun GlassesSessionCore.g1InCaseWithoutEncryption(arm: Int): Boolean = try {
    val hello = G1Protocol.parseHello(g1Control(arm, G1Protocol.OP_HELLO, tries = 1).body)
    hello != null && hello.inCase && !hello.encrypted
} catch (e: G1ConnectException) {
    false
}

/** What an arm needs to hear each time its link comes up. */
private fun GlassesSessionCore.g1StartArm(arm: Int) {
    val events = g1Control(arm, G1Protocol.OP_EVENTS, G1Protocol.eventsRequest(G1Protocol.EVENTS_MASK))
    if (events.status != 0) throw G1ConnectException(g1Side(arm) + " arm refused events", "The " + g1Side(arm) + " arm isn't answering.")
    // The arm counts a boot healthy only after a host has said so (VM.md §6.4, safe mode).
    g1Control(arm, G1Protocol.OP_HEALTH_OK)
    // A limit the last session left, when the other eye's panel guard had capped it.
    g1Control(arm, G1Protocol.OP_PROP_SET, G1Protocol.propSet(G1Protocol.PROP_BRIGHTNESS_MAX, G1Protocol.BRIGHTNESS_LEVEL_MAX))
}

// ---------------------------------------------------------------------------------------------
// One arm lost

/**
 * The arms are independent links, and in crowded 2.4 GHz one often drops alone. Carry on with the other, and bring this one
 * back by itself, instead of dropping both and showing the wearer a reconnect for a blip. Whatever was on its way to this
 * arm is gone, and so is what the phone knew about its frame. False: the session can't go on without it. Under the monitor,
 * on the BLE callback thread.
 */
internal fun GlassesSessionCore.g1CarryOnWithoutArmLocked(address: String): Boolean {
    val arm = armIndex(address)
    if (arm < 0 || !running || !sessionReady || userDisconnectRequested) return false
    val otherUp = g1.armDownSinceMs[1 - arm] == 0L && (if (arm == 0) rightConnected else leftConnected)
    if (!otherUp) return false
    // The relay's client has to be told to start again, and only a new session tells it.
    if (arm == 1 && g1.ancsRelay) return false
    if (benchmarkActive) finishBenchmarkLocked(true, "an arm dropped")
    g1.armDownSinceMs[arm] = now()
    g1.armRetryAtMs[arm] = 0
    g1DropArmMessagesLocked(arm)
    logLine("G1 " + g1Side(arm) + " arm dropped: carrying on with the other while it comes back")
    ConnectionCounters.increment("g1.arm-drop.carried-on")
    return true
}

private fun GlassesSessionCore.g1DropArmMessagesLocked(arm: Int) {
    val left = arm == 0
    val reason = "the " + g1Side(arm) + " arm dropped"
    val pending = pendingMessages.iterator()
    while (pending.hasNext()) {
        val message = pending.next()
        if (message.sid != CfwTransport.SID || message.isLeftArmMessage != left) continue
        pending.remove()
        discardPrewriteIfMatchesLocked(message)
        discardImageUpdateStatsLocked(message.imageUpdateId, reason)
        magicPool.release(message.sid, message.magic, message.label, reason)
    }
    val inFlight = inFlightMessages.iterator()
    while (inFlight.hasNext()) {
        val message = inFlight.next()
        if (message.sid != CfwTransport.SID || message.isLeftArmMessage != left) continue
        inFlight.remove()
        discardImageUpdateStatsLocked(message.imageUpdateId, reason)
        magicPool.release(message.sid, message.magic, message.label, reason)
    }
    cfwTransports[arm].reset()
    g1.arms[arm].frame = null
    g1.presentPending = true
    // What's displayed is no longer what the drive loop thinks; it gets another look.
    lastEnqueuedFingerprint = ""
    displayedFingerprint = ""
}

/** A message for an arm that's away would only fail the write or wait for an ACK that can't come. */
internal fun GlassesSessionCore.g1ArmIsAway(message: OutboundMessage): Boolean =
    monitor.withLock { g1.armDownSinceMs[if (message.isLeftArmMessage) 0 else 1] != 0L }

/** Worker thread, outside the monitor. Blocks the other arm's traffic only for the setup, not while waiting for a link. */
private fun GlassesSessionCore.g1RecoverArms() {
    for (arm in 0..1) {
        val address = g1ArmAddress(arm)
        var downSince = 0L
        var retryAt = 0L
        var limit = 0L
        monitor.withLock {
            downSince = if (sessionReady) g1.armDownSinceMs[arm] else 0L
            retryAt = g1.armRetryAtMs[arm]
            limit = g1.armRecoveryMs
        }
        if (downSince == 0L) continue
        val now = now()
        if (now - downSince >= limit) {
            handleTransportFailure(g1Side(arm) + " arm lost", "Can't reach the " + g1Side(arm) + " arm of the glasses.")
            return
        }
        if (!link.isConnected(address)) {
            if (now >= retryAt) {
                monitor.withLock { g1.armRetryAtMs[arm] = now + G1Timings.ARM_RETRY_MS }
                link.beginConnect(address, false)
            }
            continue
        }
        try {
            // A missing bond isn't a blip: that goes to the full connect, which knows what to say and can wait for the OS.
            if (!link.isBonded(address)) throw G1ConnectException(g1Side(arm) + " arm not bonded", "The glasses aren't paired.")
            g1ConnectArm(arm, now + ConnectionOptions.CONNECT_TIMEOUT_MS)
            g1Pair(arm, G1Timings.ARM_RECOVERY_WRITE_MS)
            val hello = G1Protocol.parseHello(g1Control(arm, G1Protocol.OP_HELLO).body)
                ?: throw G1ConnectException(g1Side(arm) + " arm bad hello", "The " + g1Side(arm) + " arm isn't answering.")
            g1StartArm(arm)
            monitor.withLock {
                g1.arms[arm].hello = hello
                logLine("G1 " + g1Side(arm) + " arm back after " + (now() - downSince) + " ms")
                ConnectionCounters.increment("g1.arm-recovered")
                g1.armDownSinceMs[arm] = 0
                g1.armRetryAtMs[arm] = 0
                cfwTransports[arm].reset()
                g1.presentPending = true
                // It's had no frames: all of it again, the brightness too. The drive loop sends the desired frame.
                brightnessSentLevel = -1
                brightnessSentVisible = null
                displayedFingerprint = ""
                lastEnqueuedFingerprint = ""
                imageRetryAfterMs = 0
                g1.lastPropsAtMs = 0
                if (arm == 1) {
                    g1.lastLightAtMs = 0
                    g1.lastMicRenewAtMs = 0
                    g1.mic.reset()
                    g1.lastImuAtMs = 0
                    if (g1.imuPeriodMs > 0) g1.pendingPropSets.add(1 to G1Protocol.propSet(G1Protocol.PROP_IMU_RATE, G1Protocol.IMU_RATE_STREAM))
                }
                monitor.signalAll()
            }
            interruptibleSleep.interrupt()
        } catch (t: Exception) {
            logLine("G1 " + g1Side(arm) + " arm not back yet: " + (t.message ?: t.toString()))
            monitor.withLock { g1.armRetryAtMs[arm] = now() + G1Timings.ARM_RETRY_MS }
            try {
                link.disconnect(address)
            } catch (ignored: Exception) {
            }
        }
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
            val hello = G1Protocol.parseHello(reply.body)
                ?: throw G1ConnectException(g1Side(arm) + " arm bad hello", "The " + g1Side(arm) + " arm isn't answering.")
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
            compatible = compatible && fcVersion >= 1 && G1Ble.firmwareAtLeast(hello.version)
        }
        // Not the G2 custom firmware's revision: this firmware has its own version, compared here, and TS compares this.
        val firmware = BleProtocol.FirmwareInfo(versions[0], versions[1],
            if (compatible) BleProtocol.FirmwareInfo.FACECLAW_EXTENSION_PREFIX + requiredFirmwareRevision else "")
        emitFirmwareInfo(firmware)
        if (!compatible) {
            monitor.withLock { incompatibleFirmware = firmware }
            return
        }
        for (arm in 0..1) g1StartArm(arm)
        g1ListenToAncsRelay()
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
    } catch (t: G1OtherFirmwareException) {
        logLine("G1: an arm runs Even's firmware")
        val firmware = BleProtocol.FirmwareInfo(G1_OTHER_FIRMWARE, G1_OTHER_FIRMWARE, "")
        emitFirmwareInfo(firmware)
        monitor.withLock { incompatibleFirmware = firmware }
    } catch (t: Throwable) {
        // The ways this is expected to fail have a reason of their own; the stack is for what isn't expected.
        logLine("G1 connect failed: " + (if (t is G1ConnectException) t.message else safeMessage(t)))
        val unpaired = if (t is G1ConnectException && t.repairing) null else firstUnpairedArm()
        if (unpaired != null) {
            logError("G1 connect failed and $unpaired is not paired; suspending reconnect")
            ConnectionCounters.increment("g1.unpaired")
            monitor.withLock { haltReconnectLocked("arm not paired: $unpaired") }
            if (!userDisconnectRequested) {
                setStateDisplay("unpaired", "The glasses are not paired with this phone. Put them in their charging case"
                    + " with the lid open, then connect: they only pair in the case. " + G1_CASE_DELAY_HINT)
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
        } else if (t is G1ConnectException) {
            handleTransportFailure(t.message, t.display)
        } else {
            handleTransportFailure("connect failed", "Couldn't connect to the glasses.")
        }
    }
}

/**
 * Only a host with a relay client listens, and the arm does nothing until that client says START. An arm updated just now
 * may still look old to the OS, which keeps the GATT layout it last saw until it hears otherwise: not worth failing the
 * session, and the next connection sees it.
 */
private fun GlassesSessionCore.g1ListenToAncsRelay() {
    val wanted = rawFrameTap != null && monitor.withLock { g1.arms[1].hello?.ancs == true }
    val listening = wanted && link.hasCharacteristic(rightAddress, G1Ble.ANCS_CHAR_UUID)
        && link.enableNotifications(rightAddress, G1Ble.ANCS_CHAR_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS)
    if (wanted && !listening) logWarn("G1: the right arm has a notification relay, but subscribing to it failed")
    monitor.withLock { g1.ancsRelay = listening }
}

// ---------------------------------------------------------------------------------------------
// Inbound (BLE callback thread)

internal fun GlassesSessionCore.g1OnNotification(address: String, characteristicUuid: String, data: ByteArray) {
    if (G1Ble.ANCS_CHAR_UUID == characteristicUuid) {
        val tap = rawFrameTap
        if (tap != null && data.size >= 2 && data[0] == GlassesSessionCore.RELAY_TAG_A && data[1] == GlassesSessionCore.RELAY_TAG_N
                && address.equals(rightAddress, ignoreCase = true)) {
            monitor.withLock { lastIncomingAtMs = now() }
            tap(data.copyOf())
        }
        return
    }
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
        G1Protocol.EV_MIC_DATA -> g1HandleMicData(address, data)
        G1Protocol.EV_NOTICE -> g1HandleNotice(arm, G1Protocol.parseNotice(data) ?: return)
        else -> if (type >= 0x80) {
            val reply = G1Protocol.parseReply(data) ?: return
            if (reply.op == G1Protocol.OP_PROPS) {
                val ids = monitor.withLock { g1.propRequests.remove(arm * 256 + reply.tag) } ?: return
                val values = if (reply.status == 0) G1Protocol.parseProps(reply.body, ids.size) else null
                if (values != null) g1HandlePropsReply(arm, ids, values)
                return
            }
            if (reply.op == G1Protocol.OP_MIC) {
                if (reply.status != 0) g1MicRefused(reply.status)
                return
            }
            if (reply.op == G1Protocol.OP_PROP_SET && reply.status != 0) {
                logLine("G1 PROP_SET refused: " + reply.status + " (firmware before 0.5.63?)")
            }
            monitor.withLock {
                lastIncomingAtMs = now()
                g1.replies[arm * 256 + reply.tag] = reply
                monitor.signalAll()
            }
        }
    }
}

private fun GlassesSessionCore.g1HandleMicData(address: String, data: ByteArray) {
    val (first, count, start) = G1Protocol.micFrames(data) ?: return
    val packets = ArrayList<ByteArray>(1)
    monitor.withLock { g1.mic.ingest(first, count, data, start) { packets.add(it) } }
    for (packet in packets) handleRenderNotification(address, packet)
}

private fun GlassesSessionCore.g1MicRefused(status: Int) {
    logWarn("G1 mic refused: status $status (12: no capture, or the link isn't encrypted)")
    monitor.withLock {
        audioCaptureActive = false
        audioPacketListener = null
        g1.micOn = false
    }
}

private fun GlassesSessionCore.g1HandleNotice(arm: Int, notice: G1Protocol.Notice) {
    when (notice.kind) {
        G1Protocol.NOTICE_MIC_STOPPED -> {
            val reason = if (notice.body.isNotEmpty()) notice.body[0].toInt() and 255 else 0
            logLine("G1 mic stopped by the arm: reason $reason")
            if (reason == G1Protocol.MIC_STOPPED_LEASE) {
                // A renewal came late: ask again, the capture still wants it.
                monitor.withLock { g1.lastMicRenewAtMs = 0 }
                interruptibleSleep.interrupt()
            } else {
                g1MicRefused(reason)
            }
        }
        G1Protocol.NOTICE_GUARD -> {
            if (notice.body.isEmpty()) return
            // This arm's panel guard capped its level (a mostly white screen): keep the eyes matched.
            val cap = notice.body[0].toInt() and 255
            logLine("G1 panel guard on the " + (if (arm == 0) "left" else "right") + " arm: cap $cap")
            monitor.withLock { g1.pendingPropSets.add((1 - arm) to G1Protocol.propSet(G1Protocol.PROP_BRIGHTNESS_MAX, cap)) }
            interruptibleSleep.interrupt()
        }
    }
}

private fun GlassesSessionCore.g1HandlePropsReply(arm: Int, ids: IntArray, values: IntArray) {
    when {
        ids === G1_PROPS -> g1HandleProps(arm, values)
        ids === G1_LIGHT -> if (values[0] != G1Protocol.UNKNOWN) g1HandleLight(values[0])
        ids === G1_IMU -> if (values.none { it == G1Protocol.UNKNOWN }) {
            emitImuData(values[0] / 1000.0, values[1] / 1000.0, values[2] / 1000.0, BleProtocol.EVENT_SOURCE_GLASSES_R)
        }
    }
}

/** A reading in the shape of the G2's report, so the brightness policy and the Developer app need nothing new. */
private fun GlassesSessionCore.g1HandleLight(centilux: Int) {
    val report = monitor.withLock {
        val logged = g1.loggedLight
        if (logged < 0 || kotlin.math.abs(centilux - logged) > maxOf(100, logged / 2)) {
            g1.loggedLight = centilux
            logLine("G1 light: " + centilux / 100 + " lux")
        }
        val report = G1Protocol.alsReport(centilux, brightnessPolicy.target, now())
        lastIncomingAtMs = now()
        brightnessPolicy.sample(report, lastIncomingAtMs)
        report
    }
    emitAmbientLight(report)
    interruptibleSleep.interrupt()
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
        if (values[3] != G1Protocol.UNKNOWN) {
            if (values[3] != state.worn) logLine("G1 " + (if (arm == 0) "left" else "right") + " arm: worn " + values[3])
            state.worn = values[3]
        }

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
