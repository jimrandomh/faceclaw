package com.faceclaw.app

import android.bluetooth.BluetoothGatt
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * A minimal, stock-firmware-compatible BLE communicator used only to show the
 * pre-flash confirmation prompt on the glasses and read back the user's Yes/No
 * choice. It is deliberately separate from FaceclawBleCommunicator: the main
 * app assumes the custom firmware (image containers, compositor, etc.), whereas
 * this must work on unmodified glasses, so it speaks only the stock subset —
 * session prelude, a text container, a list container, and heartbeats. No
 * images.
 *
 * It reuses the low-level GATT wrapper (FaceclawBleManager) and the framing /
 * protobuf helpers (BleProtocol), but owns its own GATT connection and runs its
 * whole lifecycle on a single worker thread. It expects the main app to be
 * disconnected while it runs (onboarding, before flashing).
 *
 * Both arms are connected and security-authenticated up front, even though the
 * prompt itself only needs the right arm (the lenses relay messages to each
 * other, and acks/events only ever come from the right arm): on an unbonded
 * phone the auth exchange is what raises the OS pairing prompt, and doing both
 * here means both prompts appear at the start rather than one popping up half
 * way through flashing the second lens. While connected, each arm's battery
 * level is read (they are independent batteries) so the caller can refuse to
 * flash on a low charge.
 *
 * With `skipPrompt` the on-glasses confirmation is not shown: the flow is just
 * connect + auth + battery read + result(approved). Used to re-check the
 * battery after the user has already confirmed once.
 */
class FaceclawFlashPromptCommunicator(
        context: Context, rightAddress: String?, leftAddress: String?, warningText: String?, skipPrompt: Boolean) : FaceclawBleListener {
    companion object {
        private const val TAG = "FaceclawFlashPrompt"

        private const val TEXT_NAME = "flashwarn"
        private const val LIST_NAME = "flashmenu"
        private const val TEXT_CONTAINER_ID = 1
        private const val LIST_CONTAINER_ID = 2
        // Index 0 = decline, index 1 = approve. Kept short for the ~50-col grid.
        private val ITEMS = arrayOf("No, cancel", "Yes, flash")

        private const val HEARTBEAT_INTERVAL_MS = 4_000
        private const val SELECTION_TIMEOUT_MS = 120_000
        private const val CREATE_ACK_TIMEOUT_MS = 3_000
        private const val BATTERY_ACK_TIMEOUT_MS = 3_000

        private fun ackKey(sid: Int, magic: Int): String {
            return "$sid:$magic"
        }
    }

    private val context: Context
    private val rightAddress: String
    private val leftAddress: String
    private val warningText: String
    private val skipPrompt: Boolean
    private val bleManager: FaceclawBleManager
    private val mainHandler = Handler(Looper.getMainLooper())

    private val lock = Any()
    private val pendingAcks = ConcurrentHashMap<String, CountDownLatch>()
    private val ackPayloads = ConcurrentHashMap<String, ByteArray>()
    private val selectionLatch = CountDownLatch(1)

    @Volatile
    private var listener: FaceclawFlashPromptListener? = null
    @Volatile
    private var worker: Thread? = null
    @Volatile
    private var cancelled = false
    @Volatile
    private var finished = false
    @Volatile
    private var rightConnected = false
    @Volatile
    private var leftConnected = false
    @Volatile
    private var rightLost = false
    @Volatile
    private var approved: Boolean? = null
    @Volatile
    private var heartbeatExecutor: ScheduledExecutorService? = null

    private var nextMagic = 100
    private var nextSeq = 0x40

    init {
        this.context = context.applicationContext
        this.rightAddress = rightAddress ?: ""
        this.leftAddress = leftAddress ?: ""
        this.warningText = warningText ?: ""
        this.skipPrompt = skipPrompt
        this.bleManager = FaceclawBleManager(this.context)
        this.bleManager.setListener(this)
    }

    fun setListener(listener: FaceclawFlashPromptListener?) {
        this.listener = listener
    }

    fun start() {
        synchronized(lock) {
            if (worker != null) {
                return
            }
            val w = Thread({ run() }, "faceclaw-flash-prompt")
            worker = w
            w.start()
        }
    }

    /** Abort the prompt (e.g. the user backed out on the phone). */
    fun cancel() {
        cancelled = true
        selectionLatch.countDown()
        val w = worker
        if (w != null) {
            w.interrupt()
        }
    }

    fun close() {
        cancel()
        stopHeartbeat()
        try {
            bleManager.close()
        } catch (ignored: Exception) {
        }
    }

    private fun run() {
        try {
            if (rightAddress.trim().isEmpty()) {
                emitState("error", "No right-arm address configured.")
                return
            }

            emitState("connecting", "")
            connectArm(rightAddress, "right")
            rightConnected = true
            if (cancelled) {
                teardown()
                return
            }
            if (!leftAddress.trim().isEmpty()) {
                connectArm(leftAddress, "left")
                leftConnected = true
                if (cancelled) {
                    teardown()
                    return
                }
            }

            emitState("connected", "")
            // Auth both arms now (pairing prompts, if any, happen here) before
            // anything else, so both bonds exist by the time flashing starts.
            authenticateArm(rightAddress, "right")
            if (leftConnected) {
                authenticateArm(leftAddress, "left")
            }
            if (cancelled) {
                teardown()
                return
            }
            sendPrelude(rightAddress)

            if (!skipPrompt) {
                showPrompt(rightAddress)
                startHeartbeat()
                emitState("prompting", "")

                selectionLatch.await(SELECTION_TIMEOUT_MS.toLong(), TimeUnit.MILLISECONDS)
                stopHeartbeat()

                if (cancelled) {
                    emitState("cancelled", "")
                    teardown()
                    return
                }
                if (approved == null) {
                    if (rightLost) {
                        emitState("disconnected", "Lost connection to the glasses.")
                    } else {
                        emitState("timeout", "No response from the glasses.")
                    }
                    teardown()
                    return
                }
                try {
                    sendShutdown()
                } catch (ignored: Exception) {
                }
                if (approved != true) {
                    emitResult(false)
                    emitState("result", "declined")
                    teardown()
                    return
                }
            }

            // Approved (or prompt skipped): read each arm's battery while the
            // links are still up, then report the result.
            emitState("battery", "")
            readBatteries()
            if (cancelled) {
                emitState("cancelled", "")
                teardown()
                return
            }
            if (rightLost) {
                emitState("disconnected", "Lost connection to the glasses.")
                teardown()
                return
            }
            finished = true
            emitResult(true)
            emitState("result", "approved")
            teardown()
        } catch (e: Exception) {
            stopHeartbeat()
            if (!cancelled) {
                val message = if (e.message == null) e.toString() else e.message
                emitState("error", message)
            }
            teardown()
        }
    }

    private fun connectArm(address: String, arm: String) {
        if (!bleManager.connect(address, ConnectionOptions.CONNECT_TIMEOUT_MS)) {
            throw IllegalStateException("could not connect to the $arm arm ($address)")
        }
        bleManager.requestConnectionPriority(address, BluetoothGatt.CONNECTION_PRIORITY_HIGH)
        bleManager.requestMtu(address, ConnectionOptions.DESIRED_MTU, ConnectionOptions.CONNECT_TIMEOUT_MS)
        if (!bleManager.discoverServices(address, ConnectionOptions.SERVICES_TIMEOUT_MS)) {
            throw IllegalStateException("discoverServices failed: $arm arm ($address)")
        }
        if (!bleManager.enableNotifications(address, BleProtocol.NOTIFY_CHAR_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS)) {
            throw IllegalStateException("enableNotifications failed: $arm arm ($address)")
        }
        emitLog("connected $arm arm")
    }

    /**
     * Security-auth exchange on sid=0x80: firmware 2.2.9 will not run a
     * session (and closes the link after ~30 s) without it, and on an
     * unbonded phone this is what triggers SMP pairing, so it may sit
     * waiting on an OS pairing prompt.
     */
    @Throws(InterruptedException::class)
    private fun authenticateArm(address: String, arm: String) {
        val authMagic = allocMagic()
        val authAck = writeAndAwaitAck(
            address,
            BleProtocol.SID_SECURITY_AUTH,
            BleProtocol.FLAG_SECURITY_AUTH,
            authMagic,
            BleProtocol.buildAuthenticationRequest(authMagic),
            ConnectionOptions.SECURITY_AUTH_TIMEOUT_MS)
        if (authAck == null || !BleProtocol.isAuthenticationSuccess(authAck, authMagic)) {
            throw IllegalStateException(
                "could not authenticate with the $arm arm ($address"
                    + ") — if Android shows a Bluetooth pairing request, accept it and try again")
        }
        emitLog("security auth complete: $arm arm")
    }

    /** Mandatory session prelude on sid=0x01 (app-launch). Right arm only; it relays. */
    @Throws(InterruptedException::class)
    private fun sendPrelude(address: String) {
        if (writeAndAwaitAck(
                address,
                BleProtocol.PRELUDE_ACK_SID,
                BleProtocol.FLAG_REQUEST,
                BleProtocol.PRELUDE_ACK_MAGIC,
                BleProtocol.PRELUDE_F5872_PAYLOAD,
                ConnectionOptions.PRELUDE_TIMEOUT_MS) == null) {
            throw IllegalStateException("session prelude not acked: $address")
        }
    }

    @Throws(InterruptedException::class)
    private fun showPrompt(address: String) {
        // Create the prompt page (warning text + No/Yes list) on sid=0xe0 Cmd=0.
        // Two attempts: on 2.2.9 the first request sent right after the
        // prelude can be dropped while the lens emits its own sid-0x80
        // notifications (observed with the device-info settings read).
        var pageAck: ByteArray? = null
        var attempt = 0
        while (attempt < 2 && pageAck == null && !cancelled) {
            val magic = allocMagic()
            val page = BleProtocol.buildCreatePromptPage(
                magic, TEXT_NAME, TEXT_CONTAINER_ID, warningText, LIST_NAME, LIST_CONTAINER_ID, ITEMS)
            pageAck = writeAndAwaitAck(address, BleProtocol.SID_EVENHUB, BleProtocol.FLAG_REQUEST, magic, page, CREATE_ACK_TIMEOUT_MS)
            if (pageAck == null) {
                emitLog("prompt page attempt " + (attempt + 1) + " unacked: " + address)
            }
            attempt++
        }
        if (pageAck == null) {
            throw IllegalStateException("prompt page not acked: $address")
        }
        emitLog("prompt page shown on $address")
    }

    /**
     * Read each arm's battery via a sid-0x09 settings read on that arm's own
     * link (the arms have independent batteries and each answers with its
     * own). An arm that does not answer reports -1; the caller decides what
     * to do with a partial reading.
     */
    @Throws(InterruptedException::class)
    private fun readBatteries() {
        val right = if (rightConnected) readBattery(rightAddress, "right") else -1
        val left = if (leftConnected) readBattery(leftAddress, "left") else -1
        emitLog("battery R=" + (if (right < 0) "?" else "$right%") + " L=" + (if (left < 0) "?" else "$left%"))
        emitBattery(right, left)
    }

    @Throws(InterruptedException::class)
    private fun readBattery(address: String, arm: String): Int {
        var attempt = 0
        while (attempt < 2 && !cancelled) {
            val magic = allocMagic()
            val ack = writeAndAwaitAck(
                address,
                BleProtocol.SID_UI_SETTING,
                BleProtocol.FLAG_REQUEST,
                magic,
                BleProtocol.buildSettingsQuery(magic),
                BATTERY_ACK_TIMEOUT_MS)
            if (ack == null) {
                emitLog("battery read attempt " + (attempt + 1) + " unacked: " + arm + " arm")
                attempt++
                continue
            }
            val snapshot: BleProtocol.BatterySnapshot? = BleProtocol.parseSettingsBattery(ack)
            if (snapshot != null) {
                return snapshot.battery
            }
            emitLog("battery read ack had no battery field: $arm arm")
            attempt++
        }
        return -1
    }

    /** Write and wait for the matching ack; returns the ack's protobuf (may be empty), or null on timeout/write failure. */
    @Throws(InterruptedException::class)
    private fun writeAndAwaitAck(address: String, sid: Int, flag: Int, magic: Int, payload: ByteArray, timeoutMs: Int): ByteArray? {
        val latch = CountDownLatch(1)
        val key = ackKey(sid, magic)
        pendingAcks[key] = latch
        try {
            if (!writeFrame(address, sid, flag, payload)) {
                return null
            }
            if (!latch.await(timeoutMs.toLong(), TimeUnit.MILLISECONDS)) {
                return null
            }
            val pb = ackPayloads[key]
            return pb ?: ByteArray(0)
        } finally {
            pendingAcks.remove(key, latch)
            ackPayloads.remove(key)
        }
    }

    private fun writeFrame(address: String, sid: Int, flag: Int, payload: ByteArray): Boolean {
        val seq: Int
        synchronized(lock) {
            seq = nextSeq++ and 0xff
        }
        val frames = BleProtocol.framePb(payload, sid, flag, seq)
        return bleManager.writeFrames(
            address,
            BleProtocol.WRITE_CHAR_UUID,
            frames,
            AndroidProtocolPlatform.writeType(ConnectionOptions.WRITE_MODE),
            ConnectionOptions.WRITE_TIMEOUT_MS)
    }

    private fun startHeartbeat() {
        stopHeartbeat()
        val executor = Executors.newSingleThreadScheduledExecutor { runnable ->
            val t = Thread(runnable, "faceclaw-flash-hb")
            t.isDaemon = true
            t
        }
        heartbeatExecutor = executor
        executor.scheduleWithFixedDelay(
            { sendHeartbeat() }, HEARTBEAT_INTERVAL_MS.toLong(), HEARTBEAT_INTERVAL_MS.toLong(), TimeUnit.MILLISECONDS)
    }

    private fun sendHeartbeat() {
        if (finished || cancelled) {
            return
        }
        try {
            val heartbeat = BleProtocol.buildHeartbeat(allocMagic())
            if (rightConnected) {
                writeFrame(rightAddress, BleProtocol.SID_EVENHUB, BleProtocol.FLAG_REQUEST, heartbeat)
            }
        } catch (e: Exception) {
            Log.w(TAG, "heartbeat failed: " + e.message)
        }
    }

    private fun stopHeartbeat() {
        val executor = heartbeatExecutor
        heartbeatExecutor = null
        if (executor != null) {
            executor.shutdownNow()
        }
    }

    private fun sendShutdown() {
        val shutdown = BleProtocol.buildShutdown(allocMagic(), 0)
        if (rightConnected) {
            writeFrame(rightAddress, BleProtocol.SID_EVENHUB, BleProtocol.FLAG_REQUEST, shutdown)
        }
    }

    private fun teardown() {
        finished = true
        stopHeartbeat()
        try {
            bleManager.close()
        } catch (ignored: Exception) {
        }
        rightConnected = false
        leftConnected = false
    }

    override fun onNotification(address: String?, characteristicUuid: String?, data: ByteArray?) {
        if (!BleProtocol.NOTIFY_CHAR_UUID.equals(characteristicUuid, ignoreCase = true)) {
            return
        }
        // A value can carry several envelope frames back to back.
        for (buf in BleProtocol.splitFrames(data)) {
            handleFrame(address, buf)
        }
    }

    private fun handleFrame(address: String?, buf: ByteArray) {
        val frame = BleProtocol.parseFrame(buf)
        if (!frame.ok) {
            return
        }
        if (frame.flag == BleProtocol.FLAG_NOTIFY || frame.flag == BleProtocol.FLAG_NOTIFY_ALT) {
            handleEvent(frame)
            return
        }
        if (frame.msgSeq >= 0) {
            val key = ackKey(frame.sid, frame.msgSeq)
            val latch = pendingAcks[key]
            if (latch != null) {
                ackPayloads[key] = frame.pb
                latch.countDown()
            }
        }
    }

    private fun handleEvent(frame: BleProtocol.ParsedFrame) {
        val selection: BleProtocol.ListSelection? = BleProtocol.parseListSelection(frame)
        if (selection == null || LIST_NAME != selection.containerName) {
            return
        }
        // Only a confirmed click is a decision; scroll/highlight changes are ignored.
        if (selection.eventType != BleProtocol.EVENT_CLICK) {
            return
        }
        val itemName = selection.itemName
        val yes = selection.itemIndex == 1
            || (itemName != null && itemName.lowercase().startsWith("yes"))
        synchronized(lock) {
            if (finished) {
                return
            }
            finished = true
            approved = yes
        }
        emitLog("selection: " + (if (yes) "flash" else "cancel") + " (index " + selection.itemIndex + ")")
        selectionLatch.countDown()
    }

    override fun onConnectionStateChange(address: String?, connected: Boolean) {
        if (connected) {
            return
        }
        if (address!!.equals(leftAddress, ignoreCase = true)) {
            // The prompt itself only needs the right arm; a dropped left link
            // just means no left battery reading.
            leftConnected = false
            emitLog("left arm disconnected")
            return
        }
        if (address.equals(rightAddress, ignoreCase = true)) {
            rightConnected = false
            synchronized(lock) {
                if (!finished && !cancelled) {
                    rightLost = true
                    finished = true
                    selectionLatch.countDown()
                }
            }
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

    private fun emitBattery(rightPercent: Int, leftPercent: Int) {
        mainHandler.post {
            val current = listener
            if (current != null) {
                current.onBattery(rightPercent, leftPercent)
            }
        }
    }

    private fun emitResult(approvedResult: Boolean) {
        mainHandler.post {
            val current = listener
            if (current != null) {
                current.onResult(approvedResult)
            }
        }
    }
}
