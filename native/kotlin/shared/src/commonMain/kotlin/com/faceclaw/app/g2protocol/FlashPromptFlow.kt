package com.faceclaw.app

import kotlin.concurrent.Volatile

/**
 * A minimal, stock-firmware-compatible flow used only to show the pre-flash confirmation
 * prompt on the glasses and read back the user's Yes/No choice. It speaks only the stock subset
 * — session prelude, a text container, a list container, and heartbeats. No images.
 *
 * Both arms are connected and security-authenticated up front, even though the prompt itself
 * only needs the right arm (the lenses relay messages to each other, and acks/events only ever
 * come from the right arm): on an unbonded phone the auth exchange is what raises the OS
 * pairing prompt, and doing both here means both prompts appear at the start rather than one
 * popping up half way through flashing the second lens. While connected, each arm's battery
 * level is read (they are independent batteries) so the caller can refuse to flash on a low
 * charge. Before the prompt is shown, the right arm's settings are read once more so a lens
 * that reports silent mode (which blanks the display and ignores input) is refused with the
 * way out instead of a prompt nobody can see.
 *
 * With `skipPrompt` the on-glasses confirmation is not shown: the flow is just connect + auth +
 * battery read + result(approved). Used to re-check the battery after the user has already
 * confirmed once. [run] executes on the caller's worker thread; the heartbeat runs on its own
 * thread while the prompt is up.
 */
class FlashPromptFlow(
    link: StockLink,
    rightAddress: String,
    leftAddress: String,
    warningText: String,
    private val skipPrompt: Boolean,
    private val listener: FaceclawFlashPromptListener,
    private val timings: StockFlowTimings = StockFlowTimings(),
    platform: ProtocolPlatform = protocolPlatform(),
) {
    companion object {
        const val TAG = "FaceclawFlashPrompt"
        const val TEXT_NAME = "flashwarn"
        const val LIST_NAME = "flashmenu"
        const val TEXT_CONTAINER_ID = 1
        const val LIST_CONTAINER_ID = 2
        // Index 0 = decline, index 1 = approve. Kept short for the ~50-col grid.
        val ITEMS = arrayOf("No, cancel", "Yes, flash")

        /**
         * Detail of the "silent" state, shown instead of a bare "prompt page not acked" error. Silent mode is entered and left
         * by the same gesture on the glasses and nothing here can clear it, so the instruction
         * has to travel with the error.
         */
        const val SILENT_MODE_MESSAGE =
            "Your glasses are in silent mode, so they cannot show the confirmation prompt. " +
                "Long-press both touchpads on the glasses to leave silent mode, then try again."
    }

    private val rightAddress = rightAddress.trim()
    private val leftAddress = leftAddress.trim()
    private val warningText = warningText
    private val platform = platform
    private val lock = platform.createLock()
    private val sleeper = InterruptibleSleep(platform)
    private val selectionLatch = Latch(1, platform)
    private val session = StockLinkSession(link, ::emitLog, timings, platform = platform)

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

    /** The running heartbeat's sleeper; interrupting it ends that thread. */
    @Volatile
    private var heartbeat: InterruptibleSleep? = null

    val cancelled: Boolean
        get() = session.cancelled

    init {
        session.onEvent = { _, frame -> handleEvent(frame) }
        session.onDisconnected = ::handleDisconnected
    }

    /** Abort the prompt (e.g. the user backed out on the phone). */
    fun cancel() {
        session.cancel()
        selectionLatch.countDown()
        sleeper.interrupt()
        stopHeartbeat()
    }

    fun run() {
        try {
            if (rightAddress.isEmpty()) {
                listener.onState("error", "No right-arm address configured.")
                return
            }

            listener.onState("connecting", "")
            connectArm(rightAddress, "right")
            rightConnected = true
            if (cancelled) {
                teardown()
                return
            }
            if (leftAddress.isNotEmpty()) {
                connectArm(leftAddress, "left")
                leftConnected = true
                if (cancelled) {
                    teardown()
                    return
                }
            }

            listener.onState("connected", "")
            // Auth both arms now (pairing prompts, if any, happen here) before anything else,
            // so both bonds exist by the time flashing starts.
            authenticateArm(rightAddress, "right")
            if (leftConnected) {
                authenticateArm(leftAddress, "left")
            }
            if (cancelled) {
                teardown()
                return
            }
            session.sendPrelude(rightAddress, ": $rightAddress")

            if (!skipPrompt) {
                // Ask before writing a page that cannot be answered: silent mode blanks the
                // display and stops the firmware dispatching input while BLE stays up, so the
                // create-prompt write is still acked and the user is left waiting on a prompt
                // that never appears.
                if (reportsSilentMode(rightAddress)) {
                    listener.onState("silent", SILENT_MODE_MESSAGE)
                    teardown()
                    return
                }
                showPrompt(rightAddress)
                startHeartbeat()
                listener.onState("prompting", "")

                selectionLatch.await(timings.selectionTimeoutMs.toLong())
                stopHeartbeat()

                if (cancelled) {
                    listener.onState("cancelled", "")
                    teardown()
                    return
                }
                if (approved == null) {
                    if (rightLost) {
                        listener.onState("disconnected", "Lost connection to the glasses.")
                    } else {
                        listener.onState("timeout", "No response from the glasses.")
                    }
                    teardown()
                    return
                }
                try {
                    sendShutdown()
                } catch (ignored: Exception) {
                }
                if (approved != true) {
                    listener.onResult(false)
                    listener.onState("result", "declined")
                    teardown()
                    return
                }
            }

            // Approved (or prompt skipped): read each arm's battery while the links are still
            // up, then report the result.
            listener.onState("battery", "")
            readBatteries()
            if (cancelled) {
                listener.onState("cancelled", "")
                teardown()
                return
            }
            if (rightLost) {
                listener.onState("disconnected", "Lost connection to the glasses.")
                teardown()
                return
            }
            finished = true
            listener.onResult(true)
            listener.onState("result", "approved")
            teardown()
        } catch (e: Exception) {
            stopHeartbeat()
            if (!cancelled) {
                listener.onState("error", StockLinkSession.messageOf(e))
            }
            teardown()
        }
    }

    private fun connectArm(address: String, arm: String) {
        try {
            session.bringUp(address)
        } catch (e: IllegalStateException) {
            throw IllegalStateException(StockLinkSession.messageOf(e) + ": $arm arm ($address)")
        }
        emitLog("connected $arm arm")
    }

    /**
     * Security-auth exchange on sid=0x80: firmware 2.2.9 will not run a session (and closes
     * the link after ~30 s) without it, and on an unbonded phone this is what triggers SMP
     * pairing, so it may sit waiting on an OS pairing prompt.
     */
    private fun authenticateArm(address: String, arm: String) {
        if (session.authenticate(address, arm) != StockLinkSession.AuthResult.SUCCESS) {
            throw IllegalStateException(
                "could not authenticate with the $arm arm ($address" +
                    ") — if the phone shows a Bluetooth pairing request, accept it and try again"
            )
        }
        emitLog("security auth complete: $arm arm")
    }

    private fun showPrompt(address: String) {
        // Create the prompt page (warning text + No/Yes list) on sid=0xe0 Cmd=0. Two attempts:
        // on 2.2.9 the first request sent right after the prelude can be dropped while the lens
        // emits its own sid-0x80 notifications (observed with the device-info settings read).
        var pageAck: ByteArray? = null
        var attempt = 0
        while (attempt < 2 && pageAck == null && !cancelled) {
            val magic = session.allocMagic()
            val page = BleProtocol.buildCreatePromptPage(magic, TEXT_NAME, TEXT_CONTAINER_ID, warningText, LIST_NAME, LIST_CONTAINER_ID, ITEMS)
            pageAck = session.writeAndAwaitAck(address, BleProtocol.SID_EVENHUB, BleProtocol.FLAG_REQUEST, magic, page, timings.createAckTimeoutMs)
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
     * Read each arm's battery via a sid-0x09 settings read on that arm's own link (the arms
     * have independent batteries and each answers with its own). An arm that does not answer
     * reports -1; the caller decides what to do with a partial reading.
     */
    private fun readBatteries() {
        val right = if (rightConnected) readBattery(rightAddress, "right") else -1
        val left = if (leftConnected) readBattery(leftAddress, "left") else -1
        emitLog("battery R=" + (if (right < 0) "?" else "$right%") + " L=" + (if (left < 0) "?" else "$left%"))
        listener.onBattery(right, left)
    }

    private fun readBattery(address: String, arm: String): Int = readSettingsSnapshot(address, arm)?.battery ?: -1

    /**
     * The sid-0x09 settings read behind both the battery gate and the silent-mode check; one
     * ack carries both fields. Two attempts, since on 2.2.9 a request sent right after the
     * prelude can be dropped. Null when the arm does not answer or the ack has no battery field.
     */
    private fun readSettingsSnapshot(address: String, arm: String): BleProtocol.BatterySnapshot? {
        var attempt = 0
        while (attempt < 2 && !cancelled) {
            val ack = session.readSettings(address, timings.batteryAckTimeoutMs)
            if (ack == null) {
                emitLog("settings read attempt " + (attempt + 1) + " unacked: " + arm + " arm")
                attempt++
                continue
            }
            val snapshot = BleProtocol.parseSettingsBattery(ack)
            if (snapshot != null) {
                return snapshot
            }
            emitLog("settings read ack had no battery field: $arm arm")
            attempt++
        }
        return null
    }

    /**
     * True only when the arm answers and its ack does not say silent mode is off. The firmware
     * omits field 14 when silent mode is off (the protobuf default), so an answered ack without
     * the field counts as off. An arm that does not answer falls through to the prompt exactly
     * as before, so a missing answer can never block a flash.
     */
    private fun reportsSilentMode(address: String): Boolean {
        val snapshot = readSettingsSnapshot(address, "right")
        val state = when {
            snapshot == null -> "unknown (arm did not answer)"
            snapshot.silentMode > 0 -> "on"
            else -> "off"
        }
        emitLog("silent mode before prompt: $state")
        return snapshot != null && snapshot.silentMode > 0
    }

    private fun startHeartbeat() {
        stopHeartbeat()
        val ticker = InterruptibleSleep(platform)
        heartbeat = ticker
        startThread("faceclaw-flash-hb", true) {
            while (heartbeat === ticker && ticker.sleep(timings.heartbeatIntervalMs.toLong())) {
                if (heartbeat !== ticker) break
                sendHeartbeat()
            }
        }
    }

    private fun sendHeartbeat() {
        if (finished || cancelled) {
            return
        }
        try {
            val heartbeat = BleProtocol.buildHeartbeat(session.allocMagic())
            if (rightConnected) {
                session.writeFrame(rightAddress, BleProtocol.SID_EVENHUB, BleProtocol.FLAG_REQUEST, heartbeat)
            }
        } catch (e: Exception) {
            emitLog("heartbeat failed: " + e.message)
        }
    }

    private fun stopHeartbeat() {
        val ticker = heartbeat ?: return
        heartbeat = null
        ticker.interrupt()
    }

    private fun sendShutdown() {
        val shutdown = BleProtocol.buildShutdown(session.allocMagic(), 0)
        if (rightConnected) {
            session.writeFrame(rightAddress, BleProtocol.SID_EVENHUB, BleProtocol.FLAG_REQUEST, shutdown)
        }
    }

    private fun teardown() {
        finished = true
        stopHeartbeat()
        session.closeQuietly()
        rightConnected = false
        leftConnected = false
    }

    private fun handleEvent(frame: BleProtocol.ParsedFrame) {
        val selection = BleProtocol.parseListSelection(frame) ?: return
        if (LIST_NAME != selection.containerName) {
            return
        }
        // Only a confirmed click is a decision; scroll/highlight changes are ignored.
        if (selection.eventType != BleProtocol.EVENT_CLICK) {
            return
        }
        val itemName = selection.itemName
        val yes = selection.itemIndex == 1 || (itemName != null && itemName.lowercase().startsWith("yes"))
        lock.withLock {
            if (finished) {
                return
            }
            finished = true
            approved = yes
        }
        emitLog("selection: " + (if (yes) "flash" else "cancel") + " (index " + selection.itemIndex + ")")
        selectionLatch.countDown()
    }

    private fun handleDisconnected(address: String) {
        if (address.equals(leftAddress, ignoreCase = true)) {
            // The prompt itself only needs the right arm; a dropped left link just means no
            // left battery reading.
            leftConnected = false
            emitLog("left arm disconnected")
            return
        }
        if (address.equals(rightAddress, ignoreCase = true)) {
            rightConnected = false
            lock.withLock {
                if (!finished && !cancelled) {
                    rightLost = true
                    finished = true
                    selectionLatch.countDown()
                }
            }
        }
    }

    // Log lines reach the platform log through the adapter's onLog (Android: logcat under TAG).
    private fun emitLog(line: String) {
        listener.onLog(line)
    }
}
