package com.faceclaw.app

import kotlin.concurrent.Volatile

/**
 * The stock-firmware request/reply plumbing that the device-info probe, the flash prompt and
 * the OTA flasher all need on top of a [StockLink]: connect + subscribe, envelope sequence and
 * magic allocation, frame demux, ack matching keyed by (sid, magic), the bond-aware security
 * auth exchange (only the firmware's SUCCESS satisfies it), the unsolicited settings capture,
 * async-event and disconnect hooks, and the OTA ack queue. Blocking calls run on the owning
 * flow's worker thread; notifications arrive on the platform's callback thread.
 */
class StockLinkSession(
    private val link: StockLink,
    private val log: (String) -> Unit,
    private val timings: StockFlowTimings = StockFlowTimings(),
    magicStart: Int = 100,
    private val magicEnd: Int = 255,
    seqStart: Int = 0x40,
    /** Log every parsed control frame with a payload prefix (the probe's 2.2.9 diagnostics). */
    private val traceFrames: Boolean = false,
    private val platform: ProtocolPlatform = protocolPlatform(),
) : StockLinkListener {
    enum class AuthResult {
        SUCCESS,
        UNCONFIRMED,
        LINK_DROPPED,
    }

    private val lock = platform.createLock()
    private val magicStart = magicStart
    private var nextMagic = magicStart
    private var nextSeq = seqStart
    private val pendingAcks = HashMap<String, Latch>()
    private val ackPayloads = HashMap<String, ByteArray>()
    private val authMagics = HashSet<Int>()
    private var authLatch: Latch? = null

    /** Latest sid-0x09 frame carrying firmware versions, whatever magic it came with. */
    @Volatile
    var unsolicitedSettingsPb: ByteArray? = null
        private set

    /** OTA acks (first two payload bytes: opcode, status) from the data-notify characteristic. */
    val otaAcks = BlockingQueue<ByteArray>(platform)

    /** Async events (flag 0x01/0x06) on the control characteristic, e.g. list selections. */
    @Volatile
    var onEvent: ((address: String, frame: BleProtocol.ParsedFrame) -> Unit)? = null

    @Volatile
    var onDisconnected: ((address: String) -> Unit)? = null

    @Volatile
    var cancelled = false
        private set

    init {
        link.setListener(this)
    }

    val platformServices: ProtocolPlatform
        get() = platform

    fun now(): Long = platform.elapsedRealtimeMs()

    /** Wake every pending wait; subsequent waits return immediately as timeouts. */
    fun cancel() {
        cancelled = true
        lock.withLock {
            for (latch in pendingAcks.values) latch.countDown()
            authLatch?.countDown()
        }
    }

    fun allocMagic(): Int =
        lock.withLock {
            val magic = nextMagic
            nextMagic = if (nextMagic >= magicEnd) magicStart else nextMagic + 1
            magic
        }

    fun nextSeq(): Int =
        lock.withLock {
            val seq = nextSeq and 0xff
            nextSeq = (nextSeq + 1) and 0xff
            seq
        }

    fun resetSeq(value: Int) {
        lock.withLock { nextSeq = value and 0xff }
    }

    /** Connect, tune, discover and subscribe to the control notify (plus the OTA notify when asked). Throws on failure. */
    fun bringUp(address: String, otaChannel: Boolean = false) {
        if (!link.connect(address, timings.connectTimeoutMs)) {
            throw IllegalStateException("connect failed")
        }
        link.prepareLink(address, ConnectionOptions.DESIRED_MTU, timings.connectTimeoutMs)
        if (!link.discoverServices(address, timings.servicesTimeoutMs)) {
            throw IllegalStateException("service discovery failed")
        }
        if (!link.enableNotifications(address, BleProtocol.NOTIFY_CHAR_UUID, timings.descriptorTimeoutMs)) {
            throw IllegalStateException("could not subscribe to notifications")
        }
        if (otaChannel && !link.enableNotifications(address, BleProtocol.OTA_DATA_NOTIFY_UUID, timings.descriptorTimeoutMs)) {
            throw IllegalStateException("could not subscribe to OTA notifications")
        }
    }

    fun isConnected(address: String): Boolean = link.isConnected(address)

    fun disconnectQuietly(address: String) {
        try {
            link.disconnect(address)
        } catch (ignored: Exception) {
        }
    }

    fun closeQuietly() {
        try {
            link.close()
        } catch (ignored: Exception) {
        }
    }

    /** Frame and write one message on the control characteristic; false when the write failed. */
    fun writeFrame(address: String, sid: Int, flag: Int, payload: ByteArray): Boolean =
        writeFrame(address, BleProtocol.WRITE_CHAR_UUID, sid, flag, payload, nextSeq())

    /** @throws IllegalStateException when the link reports "not connected". */
    fun writeFrame(address: String, characteristicUuid: String, sid: Int, flag: Int, payload: ByteArray, seq: Int): Boolean {
        val frames = BleProtocol.framePb(payload, sid, flag, seq)
        return link.writeFrames(address, characteristicUuid, frames, ConnectionOptions.WRITE_MODE, timings.writeTimeoutMs)
    }

    /**
     * Write a request and wait for the ack carrying the same sid and magic. Returns the ack's
     * protobuf (possibly empty), or null on write failure / timeout / cancel.
     */
    fun writeAndAwaitAck(address: String, sid: Int, flag: Int, magic: Int, payload: ByteArray, timeoutMs: Int): ByteArray? {
        val key = ackKey(sid, magic)
        val latch = Latch(1, platform)
        lock.withLock {
            pendingAcks[key] = latch
            ackPayloads.remove(key)
        }
        try {
            val seq = nextSeq()
            log(
                "tx " + address + " sid=0x" + hex2(sid) + " flag=0x" + hex2(flag) + " magic=" + magic +
                    " seq=0x" + hex2(seq) + " len=" + payload.size
            )
            val written =
                try {
                    writeFrame(address, BleProtocol.WRITE_CHAR_UUID, sid, flag, payload, seq)
                } catch (e: IllegalStateException) {
                    // "Not connected" — the link went away underneath us.
                    false
                }
            if (!written) {
                log("tx write FAILED sid=0x" + sid.toString(16) + " (" + address + ")")
                return null
            }
            if (!latch.await(timeoutMs.toLong()) || cancelled) {
                return null
            }
            return lock.withLock { ackPayloads[key] ?: ByteArray(0) }
        } finally {
            lock.withLock {
                if (pendingAcks[key] === latch) pendingAcks.remove(key)
                ackPayloads.remove(key)
            }
        }
    }

    /** Mandatory session prelude on sid=0x01; throws when it is not acked. */
    fun sendPrelude(address: String, failureDetail: String = "") {
        if (writeAndAwaitAck(
                address,
                BleProtocol.PRELUDE_ACK_SID,
                BleProtocol.FLAG_REQUEST,
                BleProtocol.PRELUDE_ACK_MAGIC,
                BleProtocol.PRELUDE_F5872_PAYLOAD,
                timings.preludeTimeoutMs,
            ) == null
        ) {
            throw IllegalStateException("session prelude not acked$failureDetail")
        }
    }

    /** One sid-0x09 settings read; the ack protobuf or null when unanswered. */
    fun readSettings(address: String, timeoutMs: Int): ByteArray? {
        val magic = allocMagic()
        return writeAndAwaitAck(address, BleProtocol.SID_UI_SETTING, BleProtocol.FLAG_REQUEST, magic, BleProtocol.buildSettingsQuery(magic), timeoutMs)
    }

    /**
     * Send the sid-0x80 authentication request and wait for the firmware's SUCCESS notification,
     * which only arrives once the link is encrypted. On an unbonded phone that means waiting
     * through the OS pairing flow (BOND_BONDING, possibly with a dialog up), so the wait is
     * extended while the OS reports pairing in progress and the request is re-sent once after a
     * fresh bond in case the pre-pairing write was dropped. Bond state is polled; 250 ms
     * granularity is plenty here. Platforms that cannot see bonding (UNKNOWN) get the plain
     * timeout. The first reply with a non-success result is expected before encryption and does
     * not satisfy the wait.
     */
    fun authenticate(address: String, label: String): AuthResult {
        val start = now()
        var deadline = start + timings.securityAuthTimeoutMs
        val hardDeadline = start + timings.pairingWaitCapMs
        val latch = Latch(1, platform)
        lock.withLock {
            authMagics.clear()
            authLatch = latch
        }
        val initialBond = link.bondState(address)
        log("security auth: $label lens, bond state " + bondStateName(initialBond))
        try {
            var sends = 0
            var lastSendFailed = false
            var nextSendAt = start
            var bondedAt = -1L
            var resentAfterBond = false
            var loggedBonding = false
            while (!cancelled) {
                val now = now()
                val bond = link.bondState(address)

                if (bond == BondState.BONDING) {
                    // OS pairing in progress — the firmware will answer once the link is
                    // encrypted. Don't write, don't give up, don't move on to the other arm.
                    if (!loggedBonding) {
                        log("the OS is pairing with the $label lens; waiting for the user to accept")
                        loggedBonding = true
                    }
                    if (now >= hardDeadline) {
                        break
                    }
                } else {
                    if (bond == BondState.BONDED && initialBond != BondState.BONDED && bondedAt < 0) {
                        bondedAt = now
                        log("bond established with the $label lens; waiting for the auth success")
                        deadline = maxOf(deadline, now + timings.securityAuthSoftTimeoutMs)
                    }
                    val wantSend = sends == 0 ||
                        (lastSendFailed && sends < 3 && now >= nextSendAt) ||
                        (bondedAt >= 0 && !resentAfterBond && now - bondedAt >= timings.postBondGraceMs)
                    if (wantSend) {
                        if (bondedAt >= 0) {
                            resentAfterBond = true
                            if (sends > 0) {
                                log("re-sending the auth request after pairing ($label lens)")
                            }
                        }
                        lastSendFailed = !sendAuthRequest(address)
                        sends++
                        nextSendAt = now() + timings.armRetryDelayMs
                        if (lastSendFailed && !link.isConnected(address)) {
                            return AuthResult.LINK_DROPPED
                        }
                    }
                    if (now >= deadline) {
                        break
                    }
                }

                if (latch.await(timings.pollMs.toLong()) && !cancelled) {
                    log("security auth complete: $label lens ($address)")
                    return AuthResult.SUCCESS
                }
                if (!link.isConnected(address)) {
                    log(
                        "security auth: $label lens disconnected while waiting" +
                            (if (bond == BondState.BONDING) " (the OS was still pairing)" else "")
                    )
                    return AuthResult.LINK_DROPPED
                }
            }
            if (cancelled) {
                return AuthResult.UNCONFIRMED
            }
            log("security auth unconfirmed: $label lens ($address), bond state " + bondStateName(link.bondState(address)))
            return AuthResult.UNCONFIRMED
        } finally {
            lock.withLock {
                authLatch = null
                authMagics.clear()
            }
        }
    }

    private fun sendAuthRequest(address: String): Boolean {
        val magic = allocMagic()
        lock.withLock { authMagics.add(magic) }
        val seq = nextSeq()
        val payload = BleProtocol.buildAuthenticationRequest(magic)
        log(
            "tx " + address + " sid=0x" + hex2(BleProtocol.SID_SECURITY_AUTH) + " flag=0x" + hex2(BleProtocol.FLAG_SECURITY_AUTH) +
                " magic=" + magic + " seq=0x" + hex2(seq) + " len=" + payload.size
        )
        val written =
            try {
                writeFrame(address, BleProtocol.WRITE_CHAR_UUID, BleProtocol.SID_SECURITY_AUTH, BleProtocol.FLAG_SECURITY_AUTH, payload, seq)
            } catch (e: IllegalStateException) {
                false
            }
        if (!written) {
            log("tx write FAILED sid=0x80 ($address)")
        }
        return written
    }

    /** Block while the OS reports this arm as BONDING (pairing dialog up / SMP in flight). */
    fun waitForBondToSettle(address: String, label: String, sleeper: InterruptibleSleep) {
        val cap = now() + timings.pairingWaitCapMs
        var logged = false
        while (!cancelled && link.bondState(address) == BondState.BONDING && now() < cap) {
            if (!logged) {
                log("waiting for the OS to finish pairing with the $label lens before reconnecting")
                logged = true
            }
            sleeper.sleep(timings.pollMs.toLong())
        }
    }

    // ---- inbound --------------------------------------------------------------

    override fun onNotification(address: String, characteristicUuid: String, data: ByteArray) {
        if (BleProtocol.OTA_DATA_NOTIFY_UUID.equals(characteristicUuid, ignoreCase = true)) {
            val frame = BleProtocol.parseFrame(data)
            if (frame.ok && frame.pb.size >= 2) {
                otaAcks.put(frame.pb.copyOf(minOf(frame.pb.size, 2)))
            }
            return
        }
        if (!BleProtocol.NOTIFY_CHAR_UUID.equals(characteristicUuid, ignoreCase = true)) {
            return
        }
        // One notification value can carry several envelope frames back to back; reading only
        // the first would silently drop the rest.
        val frames = BleProtocol.splitFrames(data)
        if (traceFrames && frames.size > 1) {
            log("rx " + address + " value carries " + frames.size + " frames (raw " + data.size + " bytes)")
        }
        for (buf in frames) {
            handleFrame(address, buf, data.size)
        }
    }

    private fun handleFrame(address: String, buf: ByteArray, rawValueLength: Int) {
        val frame = BleProtocol.parseFrame(buf)
        if (!frame.ok) {
            if (traceFrames) {
                log(
                    "rx " + address + " unparseable frame len=" + buf.size + " (raw value " + rawValueLength + ")" +
                        " head=" + BinaryEncoding.bytesToHex(buf.copyOf(minOf(16, buf.size)))
                )
            }
            return
        }
        if (traceFrames) {
            // Log every control frame while diagnosing 2.2.9: sid/flag/type/magic plus a
            // payload prefix is enough to reconstruct what the lens said.
            val declared = if (buf.size > 3) buf[3].toInt() and 0xff else 0
            val truncated = if (buf.size < 8 + declared) " TRUNCATED(declared=$declared)" else ""
            log(
                "rx " + address + " sid=0x" + hex2(frame.sid) + " flag=0x" + hex2(frame.flag) + " type=" + frame.msgType +
                    " magic=" + frame.msgSeq + " frag=" + (if (buf.size > 5) buf[5].toInt() and 0xff else 0) + "/" +
                    (if (buf.size > 4) buf[4].toInt() and 0xff else 0) + " len=" + frame.pb.size + truncated +
                    " pb=" + BinaryEncoding.bytesToHex(frame.pb.copyOf(minOf(48, frame.pb.size)))
            )
        }
        if (frame.sid == BleProtocol.SID_UI_SETTING && BleProtocol.parseSettingsFirmwareInfo(frame.pb) != null) {
            // Any settings frame carrying firmware versions answers the probe's question,
            // whether or not it matches the magic we asked with.
            unsolicitedSettingsPb = frame.pb
        }
        if (frame.flag == BleProtocol.FLAG_NOTIFY || frame.flag == BleProtocol.FLAG_NOTIFY_ALT) {
            // Async event, not an ack. This includes the lens's own periodic sid-0x80 notifies
            // (device-chosen magic, non-empty result).
            onEvent?.invoke(address, frame)
            return
        }
        if (frame.sid == BleProtocol.SID_SECURITY_AUTH) {
            var success = false
            var ours = false
            lock.withLock {
                val currentLatch = authLatch
                if (currentLatch != null) {
                    ours = authMagics.contains(frame.msgSeq)
                    for (magic in authMagics) {
                        if (BleProtocol.isAuthenticationSuccess(frame.pb, magic)) {
                            success = true
                            currentLatch.countDown()
                            break
                        }
                    }
                }
            }
            if (ours && !success) {
                // Expected before the link is encrypted: the firmware answers the request
                // straight away with a non-success result and sends the real success once
                // pairing/encryption completes.
                log("auth reply for magic " + frame.msgSeq + " is not the success result; still waiting")
            }
            return
        }
        if (frame.msgSeq >= 0) {
            val key = ackKey(frame.sid, frame.msgSeq)
            lock.withLock {
                val latch = pendingAcks[key]
                if (latch != null) {
                    ackPayloads[key] = frame.pb
                    latch.countDown()
                }
            }
        }
    }

    override fun onConnectionStateChange(address: String, connected: Boolean) {
        if (!connected) {
            log("disconnected: $address")
            onDisconnected?.invoke(address)
        }
    }

    companion object {
        private fun ackKey(sid: Int, magic: Int): String = "$sid:$magic"

        internal fun hex2(value: Int): String = (value and 0xff).toString(16).padStart(2, '0')

        internal fun bondStateName(state: BondState): String =
            when (state) {
                BondState.NONE -> "none"
                BondState.BONDING -> "bonding"
                BondState.BONDED -> "bonded"
                BondState.UNKNOWN -> "unknown"
            }

        internal fun messageOf(e: Throwable): String = e.message ?: e.toString()
    }
}
