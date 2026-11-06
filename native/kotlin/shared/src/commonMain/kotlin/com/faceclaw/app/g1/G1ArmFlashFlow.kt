package com.faceclaw.app

import kotlin.concurrent.Volatile
import kotlin.jvm.JvmField

class G1FlashTimings(
    @JvmField val connectTimeoutMs: Int = ConnectionOptions.CONNECT_TIMEOUT_MS,
    @JvmField val servicesTimeoutMs: Int = ConnectionOptions.SERVICES_TIMEOUT_MS,
    @JvmField val descriptorTimeoutMs: Int = ConnectionOptions.DESCRIPTOR_TIMEOUT_MS,
    @JvmField val writeTimeoutMs: Int = ConnectionOptions.WRITE_TIMEOUT_MS,
    /** The OS may be showing its pairing dialog. */
    @JvmField val pairingMs: Int = 60_000,
    @JvmField val retryDelayMs: Int = 2_000,
    @JvmField val controlReplyMs: Int = 1_500,
    @JvmField val controlTries: Int = 4,
    /** The first chunk of an upload waits for the arm to erase its slot. */
    @JvmField val uploadReplyMs: Int = 30_000,
    @JvmField val smpReplyMs: Int = 20_000,
    /** The arm may go down before its reply leaves. */
    @JvmField val resetReplyMs: Int = 5_000,
    @JvmField val heartbeatMs: Int = 8_000,
    @JvmField val pollMs: Int = 200,
    @JvmField val uploadRetries: Int = 40,
)

/**
 * Installs an MCUboot image on one G1 arm through MCUmgr SMP, or asks an arm what it runs; a port of scouter_kit's
 * g1_firmware/flash.py. The caller handles one arm at a time, left first, and looks for the arm again afterwards: it
 * restarts, and coming off Even's firmware it has a new address.
 *
 * Nothing changes on the arm until the confirm, which comes only after the arm's image list shows that its second slot
 * holds exactly this image. MCUboot then overwrites the running firmware with no way back. [run] blocks; the worker thread
 * is the host's.
 */
class G1ArmFlashFlow(
    private val link: StockLink,
    private val address: String,
    private val side: String,
    private val firmwarePath: String,
    private val mode: Mode,
    /** How long to keep trying to reach the arm and pair with it. */
    private val connectWindowMs: Int,
    private val listener: FaceclawFirmwareFlasherListener,
    private val timings: G1FlashTimings = G1FlashTimings(),
    platform: ProtocolPlatform = protocolPlatform(),
    private val readImage: (String) -> ByteArray = ::readFileData,
) : StockLinkListener {
    enum class Mode {
        /** The arm runs Even's firmware. */
        STOCK,
        /** The arm runs g1v0: it answers what it runs, and an arm that already has this version is left alone. */
        UPDATE,
        /** Only say what the arm runs, and pair with it. */
        PROBE,
    }

    companion object {
        const val TAG = "FaceclawG1Flash"
        private const val MIN_BATTERY_PERCENT = 30

        fun mode(name: String): Mode = when (name) {
            "stock" -> Mode.STOCK
            "update" -> Mode.UPDATE
            "probe" -> Mode.PROBE
            else -> throw IllegalArgumentException("unknown mode $name")
        }
    }

    private class LinkLostException(message: String) : Exception(message)

    /** The arm has no g1v0 service. */
    private class NotG1v0Exception : Exception("this arm doesn't run g1v0")

    private val platform = platform
    private val lock = platform.createLock()
    private val sleeper = InterruptibleSleep(platform)
    private val assembler = G1Smp.Assembler()

    private var smpSeq = -1
    private var smpReply: Map<*, *>? = null
    private var smpLatch: Latch? = null
    private var nextSmpSeq = 0

    private var controlTag = -1
    private var controlReply: G1Protocol.Reply? = null
    private var controlLatch: Latch? = null
    private var nextControlTag = 0

    private var linkLost = false
    private var heartbeats = 0
    private var nextHeartbeatAtMs = 0L

    @Volatile
    private var cancelled = false

    fun cancel() {
        cancelled = true
        lock.withLock {
            smpLatch?.countDown()
            controlLatch?.countDown()
        }
        sleeper.interrupt()
    }

    fun run() {
        link.setListener(this)
        try {
            if (mode == Mode.PROBE) probe() else install()
        } catch (e: Exception) {
            val message = if (cancelled) "Cancelled." else StockLinkSession.messageOf(e)
            log("failed: $message")
            listener.onState("error", message)
            listener.onComplete(false, message)
        } finally {
            quietly { link.disconnect(address) }
        }
    }

    private fun probe() {
        listener.onState("connecting", side)
        try {
            bringUp()
        } catch (e: NotG1v0Exception) {
            listener.onComplete(true, """{"firmware":"stock"}""")
            return
        }
        listener.onState("checking", side)
        val hello = hello()
        listener.onComplete(true, """{"firmware":"g1v0","version":"${hello.version}","safeMode":${hello.safeMode},"inCase":${hello.inCase},"battery":${batteryPercent()}}""")
    }

    private fun install() {
        listener.onState("validating", side)
        val image = try {
            readImage(firmwarePath)
        } catch (e: Exception) {
            throw IllegalStateException("could not read the firmware: " + StockLinkSession.messageOf(e), e)
        }
        val version = G1Smp.imageVersion(image)
        val hash = G1Smp.imageHash(image)
        log("image $version, ${image.size} bytes, hash ${BinaryEncoding.bytesToHex(hash.copyOf(8))}")

        listener.onState("connecting", side)
        bringUp()
        if (mode == Mode.UPDATE) {
            listener.onState("checking", side)
            val hello = hello()
            log("runs g1v0 ${hello.version}, safe mode ${hello.safeMode}, in the case ${hello.inCase}, encrypted ${hello.encrypted}")
            if (hello.version == version && !hello.safeMode) {
                listener.onComplete(true, """{"flashed":false,"version":"$version"}""")
                return
            }
            val battery = batteryPercent()
            if (battery != null && battery < MIN_BATTERY_PERCENT) {
                throw IllegalStateException("The $side arm's battery is at $battery%, too low to install safely. " +
                    "Charge both arms to at least $MIN_BATTERY_PERCENT% in the case, then try again.")
            }
        }

        val slots = retrying { images() }
        for (slot in slots) log(slot.toString())
        listener.onState("flashing", side)
        if (holdsImage(slots, hash)) {
            log("the second slot already holds this image")
            listener.onProgress(side, 1, 1, image.size, image.size, image.size.toLong(), image.size.toLong())
        } else {
            val startedAt = now()
            upload(image)
            log("uploaded in ${(now() - startedAt) / 1000} s")
        }
        if (!holdsImage(retrying { images() }, hash)) {
            throw IllegalStateException("The $side arm's second slot doesn't hold the image after the upload. Nothing was installed.")
        }
        throwIfCancelled()

        listener.onState("committing", side)
        val confirm = smp(G1Smp.OP_WRITE, G1Smp.GROUP_IMAGE, G1Smp.CMD_IMAGE_STATE, G1Smp.confirmRequest(hash), timings.smpReplyMs)
        val code = G1Smp.replyCode(confirm)
        if (code != 0) throw IllegalStateException("The $side arm refused the image (error $code). Nothing was installed.")
        log("confirmed: MCUboot installs it at the next boot")
        try {
            smp(G1Smp.OP_WRITE, G1Smp.GROUP_OS, G1Smp.CMD_OS_RESET, emptyMap(), timings.resetReplyMs)
        } catch (e: StockTimeoutException) {
            log("no answer to the reset")
        } catch (e: LinkLostException) {
            log("the link went down with the reset")
        }
        listener.onState("rebooting", side)
        listener.onComplete(true, """{"flashed":true,"version":"$version"}""")
    }

    private fun holdsImage(slots: List<G1Smp.Slot>, hash: ByteArray): Boolean =
        slots.any { it.image == 0 && it.slot == 1 && it.hash.contentEquals(hash) }

    private fun images(): List<G1Smp.Slot> =
        G1Smp.parseSlots(smp(G1Smp.OP_READ, G1Smp.GROUP_IMAGE, G1Smp.CMD_IMAGE_STATE, emptyMap(), timings.smpReplyMs))

    /** MCUmgr answers each chunk with the offset it wants next, so an upload resumes after a lost link. */
    private fun upload(image: ByteArray) {
        val fileSha = sha256(image)
        var offset = 0
        var failures = 0
        while (offset < image.size) {
            throwIfCancelled()
            val reply = try {
                smp(G1Smp.OP_WRITE, G1Smp.GROUP_IMAGE, G1Smp.CMD_IMAGE_UPLOAD, G1Smp.uploadRequest(image, offset, fileSha), timings.uploadReplyMs)
            } catch (e: Exception) {
                if (e !is StockTimeoutException && e !is LinkLostException) throw e
                failures++
                if (failures > timings.uploadRetries) throw e
                log("chunk at $offset failed (${e.message}), trying again")
                reconnectIfNeeded()
                continue
            }
            val code = G1Smp.replyCode(reply)
            val next = G1Smp.replyOffset(reply)
            if (code != 0 || next == null || next < 0 || next > image.size) {
                throw IllegalStateException("The $side arm refused the upload at $offset (error $code). Nothing was installed.")
            }
            offset = next
            listener.onProgress(side, 1, 1, offset, image.size, offset.toLong(), image.size.toLong())
        }
    }

    private fun <T> retrying(request: () -> T): T {
        var attempt = 0
        while (true) {
            try {
                return request()
            } catch (e: Exception) {
                if (e !is StockTimeoutException && e !is LinkLostException) throw e
                attempt++
                if (attempt >= 10) throw e
                log("request failed (${e.message}), trying again")
                reconnectIfNeeded()
            }
        }
    }

    private fun reconnectIfNeeded() {
        throwIfCancelled()
        lock.withLock { assembler.reset() }
        if (!link.isConnected(address)) bringUp()
    }

    // ---- the link ------------------------------------------------------------

    private fun bringUp() {
        val deadline = now() + connectWindowMs
        var attempt = 0
        while (true) {
            throwIfCancelled()
            attempt++
            val failure = try {
                connectOnce()
                log("connected (attempt $attempt)")
                return
            } catch (e: NotG1v0Exception) {
                throw e
            } catch (e: Exception) {
                StockLinkSession.messageOf(e)
            }
            log("connect attempt $attempt failed: $failure")
            quietly { link.disconnect(address) }
            if (now() >= deadline) {
                throw IllegalStateException("Couldn't reach the $side arm: $failure." + if (mode == Mode.STOCK) {
                    " If this phone was paired with these glasses before, remove them from its Bluetooth settings and try again."
                } else {
                    ""
                })
            }
            sleeper.sleep(timings.retryDelayMs.toLong())
        }
    }

    private fun connectOnce() {
        if (!link.connect(address, timings.connectTimeoutMs)) throw IllegalStateException("connect failed")
        lock.withLock {
            linkLost = false
            assembler.reset()
        }
        link.prepareLink(address, G1Ble.REQUESTED_MTU, timings.connectTimeoutMs)
        if (!link.discoverServices(address, timings.servicesTimeoutMs)) throw IllegalStateException("service discovery failed")
        if (mode == Mode.STOCK) {
            // Even's firmware serves its own service only on an encrypted link, and the heartbeat goes there.
            settleBond()
            if (!link.enableNotifications(address, G1Smp.NUS_TX_UUID, timings.descriptorTimeoutMs)) {
                throw IllegalStateException("no link to Even's service")
            }
            heartbeats = 0
            nextHeartbeatAtMs = 0
        } else {
            if (!link.enableNotifications(address, G1Ble.EVT_CHAR_UUID, timings.descriptorTimeoutMs)) {
                if (!link.isConnected(address)) throw LinkLostException("the link went down")
                throw NotG1v0Exception()
            }
            // Out of the case the arm obeys only an encrypted link.
            settleBond()
            val paired = try {
                link.writeFrames(address, G1Ble.PAIR_CHAR_UUID, listOf(byteArrayOf(1)), GattWriteMode.WITH_RESPONSE, timings.pairingMs)
            } catch (e: IllegalStateException) {
                false
            }
            if (!paired) throw IllegalStateException("no encrypted link: an arm pairs only in its case")
        }
        if (mode != Mode.PROBE && !link.enableNotifications(address, G1Smp.SMP_CHAR_UUID, timings.descriptorTimeoutMs)) {
            throw IllegalStateException("no update service")
        }
    }

    /** Asks the OS to pair if it hasn't, and waits for that to end; a platform that doesn't say pairs by itself. */
    private fun settleBond() {
        if (link.bondState(address) == BondState.NONE) {
            listener.onState("pairing", side)
            link.requestBond(address)
        }
        val deadline = now() + timings.pairingMs
        var sawBonding = false
        while (true) {
            throwIfCancelled()
            when (link.bondState(address)) {
                BondState.BONDED, BondState.UNKNOWN -> return
                BondState.BONDING -> sawBonding = true
                BondState.NONE -> if (sawBonding) throw IllegalStateException("pairing was refused")
            }
            if (!link.isConnected(address)) throw LinkLostException("the link went down while pairing")
            if (now() >= deadline) throw IllegalStateException("pairing took too long")
            sleeper.sleep(timings.pollMs.toLong())
        }
    }

    private fun heartbeatIfDue() {
        if (mode != Mode.STOCK || now() < nextHeartbeatAtMs) return
        val seq = heartbeats % 0xff
        heartbeats++
        nextHeartbeatAtMs = now() + timings.heartbeatMs
        try {
            link.writeFrames(address, G1Smp.NUS_RX_UUID, listOf(G1Smp.stockHeartbeat(seq)), GattWriteMode.WITHOUT_RESPONSE, timings.writeTimeoutMs)
        } catch (e: IllegalStateException) {
            // The request waiting now finds out.
        }
    }

    private fun smp(op: Int, group: Int, cmd: Int, payload: Map<String, Any?>, timeoutMs: Int): Map<*, *> {
        val seq = nextSmpSeq
        nextSmpSeq = (nextSmpSeq + 1) and 0xff
        val latch = Latch(1, platform)
        lock.withLock {
            smpSeq = seq
            smpReply = null
            smpLatch = latch
        }
        try {
            heartbeatIfDue()
            val frames = G1Smp.split(G1Smp.frame(op, group, seq, cmd, payload), link.negotiatedMtu(address))
            val written = try {
                link.writeFrames(address, G1Smp.SMP_CHAR_UUID, frames, GattWriteMode.WITHOUT_RESPONSE, timings.writeTimeoutMs)
            } catch (e: IllegalStateException) {
                false
            }
            if (!written) throw LinkLostException("write failed")
            val deadline = now() + timeoutMs
            while (true) {
                throwIfCancelled()
                heartbeatIfDue()
                val remaining = deadline - now()
                if (remaining <= 0) throw StockTimeoutException("no answer from the $side arm within $timeoutMs ms")
                latch.await(minOf(remaining, timings.pollMs.toLong()))
                val (reply, lost) = lock.withLock { smpReply to linkLost }
                if (reply != null) return reply
                if (lost) throw LinkLostException("the link went down")
            }
        } finally {
            lock.withLock {
                if (smpLatch === latch) smpLatch = null
            }
        }
    }

    private fun control(op: Int, body: ByteArray = ByteArray(0)): G1Protocol.Reply {
        repeat(timings.controlTries) {
            val tag = nextControlTag % 255 + 1
            nextControlTag = tag
            val latch = Latch(1, platform)
            lock.withLock {
                controlTag = tag
                controlReply = null
                controlLatch = latch
            }
            val written = try {
                link.writeFrames(address, G1Ble.CTRL_CHAR_UUID, listOf(G1Protocol.control(op, tag, body)), GattWriteMode.WITHOUT_RESPONSE, timings.writeTimeoutMs)
            } catch (e: IllegalStateException) {
                false
            }
            if (!written) throw LinkLostException("write failed")
            latch.await(timings.controlReplyMs.toLong())
            throwIfCancelled()
            val (reply, lost) = lock.withLock {
                controlLatch = null
                controlReply to linkLost
            }
            if (reply != null) return reply
            if (lost) throw LinkLostException("the link went down")
        }
        throw StockTimeoutException("no answer to request $op from the $side arm")
    }

    private fun hello(): G1Protocol.Hello {
        val reply = control(G1Protocol.OP_HELLO)
        return G1Protocol.parseHello(reply.body) ?: throw IllegalStateException("The $side arm's firmware isn't one this app knows.")
    }

    /** Null when the arm doesn't know yet, or a firmware doesn't say. */
    private fun batteryPercent(): Int? {
        val reply = control(G1Protocol.OP_PROPS, byteArrayOf(G1Protocol.PROP_BATT_PCT.toByte()))
        if (reply.status != 0) return null
        val value = G1Protocol.parseProps(reply.body, 1)?.get(0) ?: return null
        return if (value in 0..100) value else null
    }

    private fun throwIfCancelled() {
        if (cancelled) throw IllegalStateException("Cancelled.")
    }

    private fun now(): Long = platform.elapsedRealtimeMs()

    private fun log(line: String) = listener.onLog("$side arm: $line")

    private inline fun quietly(action: () -> Unit) {
        try {
            action()
        } catch (ignored: Exception) {
        }
    }

    // ---- inbound -------------------------------------------------------------

    override fun onNotification(address: String, characteristicUuid: String, data: ByteArray) {
        if (characteristicUuid.equals(G1Smp.SMP_CHAR_UUID, ignoreCase = true)) {
            lock.withLock {
                for ((seq, body) in assembler.feed(data)) {
                    if (seq == smpSeq) {
                        smpReply = body
                        smpLatch?.countDown()
                    }
                }
            }
        } else if (characteristicUuid.equals(G1Ble.EVT_CHAR_UUID, ignoreCase = true)) {
            val reply = G1Protocol.parseReply(data) ?: return
            lock.withLock {
                if (reply.tag == controlTag) {
                    controlReply = reply
                    controlLatch?.countDown()
                }
            }
        }
    }

    override fun onConnectionStateChange(address: String, connected: Boolean) {
        if (connected) return
        lock.withLock {
            linkLost = true
            smpLatch?.countDown()
            controlLatch?.countDown()
        }
    }
}
