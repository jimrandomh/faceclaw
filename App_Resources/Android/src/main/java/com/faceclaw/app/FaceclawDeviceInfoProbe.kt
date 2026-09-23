package com.faceclaw.app

import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log

import java.util.HashSet
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Connects to the glasses (stock-firmware compatible), reads the device-info /
 * settings response, and reports the firmware versions plus the firmware-
 * extension string (empty on stock firmware). Used by onboarding to decide whether to
 * flash. Reuses FaceclawBleManager + BleProtocol; owns its own connection and
 * runs on a single worker thread. Shows nothing on the lens.
 */
class FaceclawDeviceInfoProbe(context: Context, rightAddress: String?, leftAddress: String?) : FaceclawBleListener {
    companion object {
        private const val TAG = "FaceclawDeviceInfo"
        private const val QUERY_TIMEOUT_MS = 4_000
        /** Connect + auth attempts per arm; a link that drops mid-pairing is retried once the bond settles. */
        private const val ARM_ATTEMPTS = 3
        private const val ARM_RETRY_DELAY_MS = 1_000
        /**
         * Upper bound on waiting for the auth success while Android reports the arm
         * as BOND_BONDING — i.e. an OS pairing dialog may be sitting there waiting
         * for the user, which can take a lot longer than the normal 30 s window.
         */
        private const val PAIRING_WAIT_CAP_MS = 90_000
        /** After a fresh bond, how long the firmware gets to notify success on its own before the request is re-sent. */
        private const val POST_BOND_GRACE_MS = 2_000
        private const val POLL_MS = 250

        private fun bondStateName(state: Int): String {
            return when (state) {
                BluetoothDevice.BOND_NONE -> "none"
                BluetoothDevice.BOND_BONDING -> "bonding"
                BluetoothDevice.BOND_BONDED -> "bonded"
                else -> "unknown"
            }
        }
    }

    private val context: Context
    private val rightAddress: String
    private val leftAddress: String
    private val bleManager: FaceclawBleManager
    private val mainHandler = Handler(Looper.getMainLooper())

    private val lock = Any()
    private var nextSeq = 0x40
    private var nextMagic = 100

    private var awaitSid = -1
    private var awaitMagic = -1
    private var awaitPb: ByteArray? = null
    private var awaitLatch: CountDownLatch? = null

    /**
     * Security-auth wait, kept separate from the generic ack wait: only the
     * firmware's SUCCESS result (empty result message) may satisfy it. The
     * firmware answers the request as soon as it arrives, but with a
     * non-success result until the link is encrypted; accepting that first
     * reply as "the ack" is what let the probe move on to the other arm while
     * Android's pairing dialog for this one was still up.
     */
    private val authMagics: MutableSet<Int> = HashSet()
    private var authLatch: CountDownLatch? = null

    /**
     * A sid-0x09 frame that carried firmware versions without matching the
     * awaited magic — some firmware pushes the settings snapshot on a magic it
     * picked itself instead of (or in addition to) acking the read.
     */
    @Volatile
    private var unsolicitedSettingsPb: ByteArray? = null

    @Volatile
    private var listener: FaceclawDeviceInfoProbeListener? = null
    @Volatile
    private var worker: Thread? = null
    @Volatile
    private var cancelled = false

    init {
        this.context = context.applicationContext
        this.rightAddress = rightAddress ?: ""
        this.leftAddress = leftAddress ?: ""
        this.bleManager = FaceclawBleManager(this.context)
        this.bleManager.setListener(this)
    }

    fun setListener(listener: FaceclawDeviceInfoProbeListener?) {
        this.listener = listener
    }

    fun start() {
        synchronized(lock) {
            if (worker != null) {
                return
            }
            val w = Thread({ run() }, "faceclaw-device-info")
            worker = w
            w.start()
        }
    }

    fun cancel() {
        cancelled = true
        val w = worker
        if (w != null) {
            w.interrupt()
        }
    }

    fun close() {
        cancel()
        try {
            bleManager.close()
        } catch (ignored: Exception) {
        }
    }

    private fun run() {
        try {
            if (rightAddress.trim().isEmpty()) {
                emitError("No right-arm address configured.")
                return
            }

            val haveLeft = !leftAddress.trim().isEmpty() && !leftAddress.equals(rightAddress, ignoreCase = true)

            // Bring up and authenticate BOTH arms before asking for versions.
            // Each arm is its own peripheral with its own bond, so on a fresh
            // phone each raises its own pairing prompt; completing both here
            // means the flash step (and the app proper) find both bonds in
            // place. Strictly one arm at a time: Android pairs with one device
            // at a time, and a second arm connected while the first was still
            // pairing has been seen to drop within a second and never pair
            // (2026-09-11 logcat).
            var rightAuthenticated = bringUpArm(rightAddress, "right")
            var leftAuthenticated = false
            if (haveLeft && !cancelled) {
                leftAuthenticated = bringUpArm(leftAddress, "left")
            }
            if (cancelled) {
                emitError("Cancelled.")
                return
            }
            if (!bleManager.isConnected(rightAddress)) {
                // The right lens may have dropped while the left one paired;
                // it is bonded by now, so this comes back quickly.
                emitLog("right lens disconnected while the left lens was set up; reconnecting")
                rightAuthenticated = bringUpArm(rightAddress, "right")
                if (cancelled) {
                    emitError("Cancelled.")
                    return
                }
            }

            var ack: ByteArray? = null
            var rightFailure: String? = null
            try {
                ack = queryArm(rightAddress, "right", rightAuthenticated)
            } catch (e: IllegalStateException) {
                rightFailure = if (e.message == null) e.toString() else e.message
                emitLog("right-lens query failed: $rightFailure")
            }
            // The right lens is the documented control endpoint, but a silent
            // right lens has been observed on stock 2.2.9 even after a
            // successful security auth — run the same probe against the left
            // lens rather than giving up, and log which lens answered.
            if (ack == null && !cancelled && haveLeft) {
                emitLog("right lens did not answer the settings query; probing the left lens")
                try {
                    ack = queryArm(leftAddress, "left", leftAuthenticated)
                } catch (e: Exception) {
                    emitLog("left-lens probe failed: " + (if (e.message == null) e.toString() else e.message))
                }
            }
            if (cancelled) {
                emitError("Cancelled.")
                return
            }
            if (ack == null) {
                throw IllegalStateException(if (rightFailure != null)
                    rightFailure
                    else "no response to the device-info query on either lens — check `adb logcat -s "
                        + TAG + "` for the frame trace")
            }

            val info: BleProtocol.FirmwareInfo? = BleProtocol.parseSettingsFirmwareInfo(ack)
            val left = if (info == null) "" else info.leftVersion
            val right = if (info == null) "" else info.rightVersion
            val extension = if (info == null) "" else info.extension
            emitLog("device-info: L=$left R=$right ext=[$extension]")
            emitResult(left, right, extension)
        } catch (e: Exception) {
            val message = if (cancelled) "Cancelled." else (if (e.message == null) e.toString() else e.message)
            emitError(message)
        } finally {
            try {
                bleManager.close()
            } catch (ignored: Exception) {
            }
        }
    }

    /**
     * Connect to one arm and complete its security-auth exchange, retrying
     * when the link drops mid-pairing. Returns whether the auth success was
     * seen (false = connected but unconfirmed, tolerated because the custom
     * firmware's response to the exchange is not yet hardware-verified);
     * throws when the arm cannot be brought up at all.
     */
    @Throws(InterruptedException::class)
    private fun bringUpArm(address: String, label: String): Boolean {
        var lastFailure: String? = null
        var attempt = 1
        while (attempt <= ARM_ATTEMPTS && !cancelled) {
            if (attempt > 1) {
                // A link Android dropped while it was still pairing comes back
                // once the bond settles; reconnecting sooner just fails again.
                waitForBondToSettle(address, label)
                if (cancelled) {
                    break
                }
                emitLog("retrying the $label lens (attempt $attempt/$ARM_ATTEMPTS): $lastFailure")
                Thread.sleep(ARM_RETRY_DELAY_MS.toLong())
            }
            emitState("connecting", label)
            try {
                connectArm(address)
            } catch (e: IllegalStateException) {
                lastFailure = if (e.message == null) e.toString() else e.message
                emitLog("$label lens: $lastFailure")
                attempt++
                continue
            }
            if (cancelled) {
                break
            }

            // Firmware 2.2.9 answers no queries until the security-auth
            // exchange completes over an encrypted link; on a phone with no
            // existing bond this is also what triggers SMP pairing (and its OS
            // prompt), so it must come before the prelude and query.
            emitState("authenticating", label)
            val result = authenticate(address, label)
            if (result == AuthResult.SUCCESS) {
                return true
            }
            if (result == AuthResult.UNCONFIRMED) {
                return false
            }
            lastFailure = "link dropped during authentication"
            attempt++
        }
        if (cancelled) {
            return false
        }
        throw IllegalStateException("could not connect to the $label lens ($address): "
            + lastFailure + " — if Android showed a Bluetooth pairing request, accept it and try again")
    }

    private enum class AuthResult { SUCCESS, UNCONFIRMED, LINK_DROPPED }

    /**
     * Send the sid-0x80 authentication request and wait for the firmware's
     * SUCCESS notification, which only arrives once the link is encrypted.
     * On an unbonded phone that means waiting through Android's pairing flow
     * (BOND_BONDING, possibly with a dialog up), so the wait is extended while
     * the OS reports pairing in progress and the request is re-sent once
     * after a fresh bond in case the pre-pairing write was dropped. Bond
     * state is polled rather than awaited via broadcast; 250 ms granularity
     * is plenty here.
     */
    @Throws(InterruptedException::class)
    private fun authenticate(address: String, label: String): AuthResult {
        val start = SystemClock.elapsedRealtime()
        var deadline = start + ConnectionOptions.SECURITY_AUTH_TIMEOUT_MS
        val hardDeadline = start + PAIRING_WAIT_CAP_MS
        val latch = CountDownLatch(1)
        synchronized(lock) {
            authMagics.clear()
            authLatch = latch
        }
        val initialBond = bleManager.getBondState(address)
        emitLog("security auth: $label lens, Android bond state " + bondStateName(initialBond))
        try {
            var sends = 0
            var lastSendFailed = false
            var nextSendAt = start
            var bondedAt = -1L
            var resentAfterBond = false
            var loggedBonding = false
            while (!cancelled) {
                val now = SystemClock.elapsedRealtime()
                val bond = bleManager.getBondState(address)

                if (bond == BluetoothDevice.BOND_BONDING) {
                    // OS pairing in progress — the firmware will answer once the
                    // link is encrypted. Don't write, don't give up, don't move
                    // on to the other arm.
                    if (!loggedBonding) {
                        emitLog("Android is pairing with the $label lens; waiting for the user to accept")
                        loggedBonding = true
                    }
                    if (now >= hardDeadline) {
                        break
                    }
                } else {
                    if (bond == BluetoothDevice.BOND_BONDED && initialBond != BluetoothDevice.BOND_BONDED
                            && bondedAt < 0) {
                        bondedAt = now
                        emitLog("Android bond established with the $label lens; waiting for the auth success")
                        deadline = Math.max(deadline, now + ConnectionOptions.SECURITY_AUTH_SOFT_TIMEOUT_MS)
                    }
                    val wantSend = sends == 0
                        || (lastSendFailed && sends < 3 && now >= nextSendAt)
                        || (bondedAt >= 0 && !resentAfterBond && now - bondedAt >= POST_BOND_GRACE_MS)
                    if (wantSend) {
                        if (bondedAt >= 0) {
                            resentAfterBond = true
                            if (sends > 0) {
                                emitLog("re-sending the auth request after pairing ($label lens)")
                            }
                        }
                        lastSendFailed = !sendAuthRequest(address)
                        sends++
                        nextSendAt = SystemClock.elapsedRealtime() + ARM_RETRY_DELAY_MS
                        if (lastSendFailed && !bleManager.isConnected(address)) {
                            return AuthResult.LINK_DROPPED
                        }
                    }
                    if (now >= deadline) {
                        break
                    }
                }

                if (latch.await(POLL_MS.toLong(), TimeUnit.MILLISECONDS)) {
                    emitLog("security auth complete: $label lens ($address)")
                    return AuthResult.SUCCESS
                }
                if (!bleManager.isConnected(address)) {
                    emitLog("security auth: $label lens disconnected while waiting"
                        + (if (bond == BluetoothDevice.BOND_BONDING) " (Android was still pairing)" else ""))
                    return AuthResult.LINK_DROPPED
                }
            }
            if (cancelled) {
                return AuthResult.UNCONFIRMED
            }
            emitLog("security auth unconfirmed: $label lens ($address), Android bond state "
                + bondStateName(bleManager.getBondState(address)))
            return AuthResult.UNCONFIRMED
        } finally {
            synchronized(lock) {
                authLatch = null
                authMagics.clear()
            }
        }
    }

    private fun sendAuthRequest(address: String): Boolean {
        val magic = allocMagic()
        val seq: Int
        synchronized(lock) {
            authMagics.add(magic)
            seq = nextSeq++ and 0xff
        }
        val payload = BleProtocol.buildAuthenticationRequest(magic)
        emitLog(String.format("tx %s sid=0x%02x flag=0x%02x magic=%d seq=0x%02x len=%d",
            address, BleProtocol.SID_SECURITY_AUTH, BleProtocol.FLAG_SECURITY_AUTH, magic, seq, payload.size))
        val frames = BleProtocol.framePb(payload, BleProtocol.SID_SECURITY_AUTH, BleProtocol.FLAG_SECURITY_AUTH, seq)
        var written: Boolean
        try {
            written = bleManager.writeFrames(
                address, BleProtocol.WRITE_CHAR_UUID, frames, AndroidProtocolPlatform.writeType(ConnectionOptions.WRITE_MODE), ConnectionOptions.WRITE_TIMEOUT_MS)
        } catch (e: IllegalStateException) {
            // "Not connected" — the link went away underneath us.
            written = false
        }
        if (!written) {
            emitLog("tx write FAILED sid=0x80 ($address)")
        }
        return written
    }

    /** Block while Android reports this arm as BOND_BONDING (pairing dialog up / SMP in flight). */
    @Throws(InterruptedException::class)
    private fun waitForBondToSettle(address: String, label: String) {
        val cap = SystemClock.elapsedRealtime() + PAIRING_WAIT_CAP_MS
        var logged = false
        while (!cancelled && bleManager.getBondState(address) == BluetoothDevice.BOND_BONDING
                && SystemClock.elapsedRealtime() < cap) {
            if (!logged) {
                emitLog("waiting for Android to finish pairing with the $label lens before reconnecting")
                logged = true
            }
            Thread.sleep(POLL_MS.toLong())
        }
    }

    /**
     * Prelude + settings read on an already connected/authenticated lens.
     * Returns the settings ack protobuf, an unsolicited settings push that
     * carried firmware versions, or null when the lens never answered the read.
     * Throws on prelude failure; the caller wraps the fallback lens's attempt
     * so its failure cannot mask the primary lens's outcome.
     */
    @Throws(InterruptedException::class)
    private fun queryArm(address: String, label: String, authenticated: Boolean): ByteArray? {
        if (cancelled) {
            return null
        }

        emitState("querying", label)
        // Session prelude, then a settings/device-info read (both arms'
        // versions and the firmware-extension string ride back in one response).
        if (writeAndAwaitAck(address, BleProtocol.PRELUDE_ACK_SID, BleProtocol.FLAG_REQUEST,
                BleProtocol.PRELUDE_ACK_MAGIC, BleProtocol.PRELUDE_F5872_PAYLOAD,
                ConnectionOptions.PRELUDE_TIMEOUT_MS) == null) {
            throw IllegalStateException("session prelude not acked ($label lens)"
                + (if (authenticated) "" else "; authentication did not complete —"
                    + " if Android shows a Bluetooth pairing request, accept it and try again"))
        }

        // Two attempts: the first read straight after a fresh pairing has been
        // seen to go unanswered while a later one succeeds.
        var attempt = 0
        while (attempt < 2 && !cancelled) {
            val magic = allocMagic()
            val ack = writeAndAwaitAck(address, BleProtocol.SID_UI_SETTING, BleProtocol.FLAG_REQUEST,
                magic, BleProtocol.buildSettingsQuery(magic), QUERY_TIMEOUT_MS)
            if (ack != null) {
                return ack
            }
            // A push with the firmware versions on the device's own magic is
            // as good as the ack we asked for.
            val pushed = unsolicitedSettingsPb
            if (pushed != null) {
                emitLog("using unsolicited settings push instead of the read ack ($label lens)")
                return pushed
            }
            emitLog("settings query attempt " + (attempt + 1) + " unanswered (" + label + " lens)")
            attempt++
        }
        return null
    }

    private fun connectArm(address: String) {
        if (!bleManager.connect(address, ConnectionOptions.CONNECT_TIMEOUT_MS)) {
            throw IllegalStateException("connect failed")
        }
        bleManager.requestConnectionPriority(address, BluetoothGatt.CONNECTION_PRIORITY_HIGH)
        bleManager.requestMtu(address, ConnectionOptions.DESIRED_MTU, ConnectionOptions.CONNECT_TIMEOUT_MS)
        if (!bleManager.discoverServices(address, ConnectionOptions.SERVICES_TIMEOUT_MS)) {
            throw IllegalStateException("service discovery failed")
        }
        if (!bleManager.enableNotifications(address, BleProtocol.NOTIFY_CHAR_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS)) {
            throw IllegalStateException("could not subscribe to notifications")
        }
    }

    @Throws(InterruptedException::class)
    private fun writeAndAwaitAck(address: String, sid: Int, flag: Int, magic: Int, payload: ByteArray, timeoutMs: Int): ByteArray? {
        val latch = CountDownLatch(1)
        synchronized(lock) {
            awaitSid = sid
            awaitMagic = magic
            awaitPb = null
            awaitLatch = latch
        }
        val seq: Int
        synchronized(lock) {
            seq = nextSeq++ and 0xff
        }
        emitLog(String.format("tx %s sid=0x%02x flag=0x%02x magic=%d seq=0x%02x len=%d",
            address, sid, flag, magic, seq, payload.size))
        val frames = BleProtocol.framePb(payload, sid, flag, seq)
        val written = bleManager.writeFrames(
            address, BleProtocol.WRITE_CHAR_UUID, frames, AndroidProtocolPlatform.writeType(ConnectionOptions.WRITE_MODE), ConnectionOptions.WRITE_TIMEOUT_MS)
        if (!written) {
            emitLog("tx write FAILED sid=0x" + Integer.toHexString(sid))
            synchronized(lock) {
                awaitLatch = null
            }
            return null
        }
        val acked = latch.await(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
        synchronized(lock) {
            awaitLatch = null
            return if (acked) awaitPb else null
        }
    }

    override fun onNotification(address: String?, characteristicUuid: String?, data: ByteArray?) {
        if (!BleProtocol.NOTIFY_CHAR_UUID.equals(characteristicUuid, ignoreCase = true)) {
            return
        }
        // One notification value can carry several envelope frames back to
        // back; reading only the first would silently drop the rest.
        val frames = BleProtocol.splitFrames(data)
        if (frames.size > 1) {
            emitLog("rx " + address + " value carries " + frames.size + " frames (raw " + data!!.size + " bytes)")
        }
        for (buf in frames) {
            handleFrame(address, buf, data!!.size)
        }
    }

    private fun handleFrame(address: String?, buf: ByteArray, rawValueLength: Int) {
        val frame = BleProtocol.parseFrame(buf)
        if (!frame.ok) {
            emitLog("rx " + address + " unparseable frame len=" + buf.size + " (raw value " + rawValueLength + ")"
                + " head=" + FaceclawFirmwareUtil.bytesToHex(java.util.Arrays.copyOf(buf, Math.min(16, buf.size))))
            return
        }
        // Log every control frame while diagnosing 2.2.9: sid/flag/type/magic
        // plus a payload prefix is enough to reconstruct what the lens said.
        val declared = if (buf.size > 3) buf[3].toInt() and 0xff else 0
        val truncated = if (buf.size < 8 + declared) " TRUNCATED(declared=$declared)" else ""
        emitLog(String.format("rx %s sid=0x%02x flag=0x%02x type=%d magic=%d frag=%d/%d len=%d%s pb=%s",
            address, frame.sid, frame.flag, frame.msgType, frame.msgSeq,
            if (buf.size > 5) buf[5].toInt() and 0xff else 0, if (buf.size > 4) buf[4].toInt() and 0xff else 0, frame.pb.size, truncated,
            FaceclawFirmwareUtil.bytesToHex(java.util.Arrays.copyOf(frame.pb, Math.min(48, frame.pb.size)))))
        if (frame.sid == BleProtocol.SID_UI_SETTING
                && BleProtocol.parseSettingsFirmwareInfo(frame.pb) != null) {
            // Any settings frame carrying firmware versions answers the probe's
            // question, whether or not it matches the magic we asked with.
            unsolicitedSettingsPb = frame.pb
        }
        if (frame.flag == BleProtocol.FLAG_NOTIFY || frame.flag == BleProtocol.FLAG_NOTIFY_ALT) {
            // Async event, not an ack. This includes the lens's own periodic
            // sid-0x80 notifies (device-chosen magic, non-empty result).
            return
        }
        if (frame.sid == BleProtocol.SID_SECURITY_AUTH) {
            var success = false
            var ours = false
            synchronized(lock) {
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
                // Expected before the link is encrypted: the firmware answers
                // the request straight away with a non-success result and
                // sends the real success once pairing/encryption completes.
                emitLog("auth reply for magic " + frame.msgSeq + " is not the success result; still waiting")
            }
            return
        }
        synchronized(lock) {
            val currentLatch = awaitLatch
            if (currentLatch != null && frame.sid == awaitSid && frame.msgSeq == awaitMagic) {
                awaitPb = frame.pb
                currentLatch.countDown()
            }
        }
    }

    override fun onConnectionStateChange(address: String?, connected: Boolean) {
        if (!connected) {
            Log.i(TAG, "disconnected: $address")
        }
    }

    private fun allocMagic(): Int {
        synchronized(lock) {
            val magic = nextMagic
            nextMagic = if (nextMagic >= 255) 100 else nextMagic + 1
            return magic
        }
    }

    private fun emitLog(line: String) {
        Log.i(TAG, line)
        mainHandler.post {
            val current = listener
            if (current != null) {
                current.onLog(line)
            }
        }
    }

    private fun emitState(state: String, detail: String?) {
        val safeDetail = detail ?: ""
        mainHandler.post {
            val current = listener
            if (current != null) {
                current.onState(state, safeDetail)
            }
        }
    }

    private fun emitResult(left: String, right: String, extension: String) {
        mainHandler.post {
            val current = listener
            if (current != null) {
                current.onResult(left, right, extension)
            }
        }
    }

    private fun emitError(message: String?) {
        val safeMessage = message ?: ""
        mainHandler.post {
            val current = listener
            if (current != null) {
                current.onError(safeMessage)
            }
        }
    }
}
