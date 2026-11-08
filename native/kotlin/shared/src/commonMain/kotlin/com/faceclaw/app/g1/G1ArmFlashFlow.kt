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
    /** How often a store job's state is asked for while its notice hasn't come. */
    @JvmField val storePollMs: Int = 2_000,
    /** Erasing the store over Even's old fonts and pictures takes minutes. */
    @JvmField val wipeMs: Int = 1_800_000,
    @JvmField val crcMs: Int = 30_000,
)

/**
 * Installs an MCUboot image on one G1 arm through MCUmgr SMP, or asks an arm what it runs; a port of scouter_kit's
 * g1_firmware/flash.py. The caller handles one arm at a time and looks for the arm again afterwards: it restarts, and
 * coming off firmware older than g1v0 0.5.66 it has a new address.
 *
 * Nothing changes on the arm until the confirm, which comes only after the arm's image list shows that its second slot
 * holds exactly this image. MCUboot then overwrites the running firmware with no way back. [run] blocks; the worker thread
 * is the host's.
 *
 * [Mode.RESTORE] puts Even's firmware back on an arm running g1v0: both of a release's images, the application core's
 * ([firmwarePath]) and the network core's ([netCorePath]), as Even's own update does, so the two always match.
 */
class G1ArmFlashFlow(
    private val link: StockLink,
    private val address: String,
    private val side: String,
    private val firmwarePath: String,
    private val netCorePath: String,
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
        /** The arm runs g1v0 and gets Even's firmware back. */
        RESTORE,
    }

    companion object {
        const val TAG = "FaceclawG1Flash"
        private const val MIN_BATTERY_PERCENT = 30
        private const val ANY_STORE_JOB = -1
        private const val STORE_JOB_INTERRUPTED = -1

        fun mode(name: String): Mode = when (name) {
            "stock" -> Mode.STOCK
            "update" -> Mode.UPDATE
            "probe" -> Mode.PROBE
            "restore" -> Mode.RESTORE
            else -> throw IllegalArgumentException("unknown mode $name")
        }
    }

    /** One image of an install: MCUboot's number for it, its bytes and the hash its slot is checked against. */
    private class Part(val imageIndex: Int, val bytes: ByteArray, val label: String) {
        val hash: ByteArray = G1Smp.imageHash(bytes)
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

    private var stockBattery: Int? = null
    private var stockBatteryLatch: Latch? = null

    /** `NOTICE` 8s since the store job now waited for was asked for. */
    private val storeNotices = ArrayList<G1Protocol.StoreNotice>()

    /** The OS's half of a stale pairing goes once per run: a second failure isn't that. */
    private var bondRemoved = false

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
            when (mode) {
                Mode.PROBE -> probe()
                Mode.RESTORE -> restore()
                else -> install()
            }
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

    private fun readFirmware(path: String): ByteArray = try {
        readImage(path)
    } catch (e: Exception) {
        throw IllegalStateException("could not read the firmware: " + StockLinkSession.messageOf(e), e)
    }

    private fun install() {
        listener.onState("validating", side)
        val image = readFirmware(firmwarePath)
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
            requireBattery(batteryPercent())
        } else {
            val battery = stockBatteryPercent()
            log(if (battery == null) "battery unknown; going on, as the arm is in the case" else "battery $battery%")
            requireBattery(battery)
        }

        val slots = retrying { images() }
        for (slot in slots) log(slot.toString())
        listener.onState("flashing", side)
        if (holdsImage(slots, G1Smp.IMAGE_APP, hash)) {
            log("the second slot already holds this image")
            listener.onProgress(side, 1, 1, image.size, image.size, image.size.toLong(), image.size.toLong())
        } else {
            val startedAt = now()
            upload(image, G1Smp.IMAGE_APP)
            log("uploaded in ${(now() - startedAt) / 1000} s")
        }
        if (!holdsImage(retrying { images() }, G1Smp.IMAGE_APP, hash)) {
            throw IllegalStateException("The $side arm's second slot doesn't hold the image after the upload. Nothing was installed.")
        }
        throwIfCancelled()

        listener.onState("committing", side)
        val confirm = smp(G1Smp.OP_WRITE, G1Smp.GROUP_IMAGE, G1Smp.CMD_IMAGE_STATE, G1Smp.confirmRequest(hash), timings.smpReplyMs)
        val code = G1Smp.replyCode(confirm)
        if (code != 0) throw IllegalStateException("The $side arm refused the image (error $code). Nothing was installed.")
        log("confirmed: MCUboot installs it at the next boot")
        reset()
        listener.onState("rebooting", side)
        listener.onComplete(true, """{"flashed":true,"version":"$version"}""")
    }

    /**
     * Even's firmware back on an arm running g1v0: the store cleared if g1v0 ever wrote to it, then both images uploaded
     * and checked, and only then marked for MCUboot, the network core first. MCUboot installs both at the reset, the
     * network core through its own path to that core, as at every update from Even.
     */
    private fun restore() {
        listener.onState("validating", side)
        val parts = listOf(
            Part(G1Smp.IMAGE_NET_CORE, readFirmware(netCorePath), "network core"),
            Part(G1Smp.IMAGE_APP, readFirmware(firmwarePath), "application"),
        )
        for (part in parts) log("${part.label} image: ${part.bytes.size} bytes, hash ${BinaryEncoding.bytesToHex(part.hash.copyOf(8))}")

        listener.onState("connecting", side)
        bringUp()
        listener.onState("checking", side)
        val hello = hello()
        log("runs g1v0 ${hello.version}, safe mode ${hello.safeMode}, in the case ${hello.inCase}, encrypted ${hello.encrypted}")
        requireBattery(batteryPercent())
        val wiped = clearStore(hello)

        val slots = retrying { images() }
        for (slot in slots) log(slot.toString())
        listener.onState("flashing", side)
        val total = parts.sumOf { it.bytes.size }
        var before = 0
        for ((index, part) in parts.withIndex()) {
            if (holdsImage(slots, part.imageIndex, part.hash)) {
                log("the ${part.label}'s second slot already holds Even's image")
                listener.onProgress(side, index + 1, parts.size, part.bytes.size, part.bytes.size, (before + part.bytes.size).toLong(), total.toLong())
            } else {
                val startedAt = now()
                upload(part.bytes, part.imageIndex, index + 1, parts.size, before, total)
                log("${part.label} uploaded in ${(now() - startedAt) / 1000} s")
            }
            before += part.bytes.size
        }
        val uploaded = retrying { images() }
        for (part in parts) {
            if (!holdsImage(uploaded, part.imageIndex, part.hash)) {
                throw IllegalStateException("The $side arm's slot for its ${part.label} doesn't hold Even's image after the upload. Nothing was installed.")
            }
        }
        throwIfCancelled()

        listener.onState("committing", side)
        // The network core first. If the second request fails, what's left pending is Even's network core under g1v0,
        // which g1v0 works with (its fallback installs this very image); Even's application over the older network core
        // is the combination that has never been tried.
        for (part in parts) {
            val permanent = part.imageIndex == G1Smp.IMAGE_APP
            val reply = smp(G1Smp.OP_WRITE, G1Smp.GROUP_IMAGE, G1Smp.CMD_IMAGE_STATE, G1Smp.confirmRequest(part.hash, permanent), timings.smpReplyMs)
            val code = G1Smp.replyCode(reply)
            if (code != 0) {
                throw IllegalStateException("The $side arm refused Even's ${part.label} image (error $code). The arm wasn't restarted; retry to try again.")
            }
        }
        val marked = retrying { images() }
        for (slot in marked) log(slot.toString())
        for (part in parts) {
            if (!marked.any { it.image == part.imageIndex && it.slot == 1 && it.hash.contentEquals(part.hash) && "pending" in it.flags }) {
                throw IllegalStateException("The $side arm didn't mark Even's ${part.label} image for installing. The arm wasn't restarted; retry to try again.")
            }
        }
        log("both images marked: MCUboot installs them at the next boot")
        reset()
        listener.onState("rebooting", side)
        listener.onComplete(true, """{"flashed":true,"firmware":"stock","wiped":$wiped}""")
    }

    private fun reset() {
        try {
            smp(G1Smp.OP_WRITE, G1Smp.GROUP_OS, G1Smp.CMD_OS_RESET, emptyMap(), timings.resetReplyMs)
        } catch (e: StockTimeoutException) {
            log("no answer to the reset")
        } catch (e: LinkLostException) {
            log("the link went down with the reset")
        }
    }

    // ---- the asset store ---------------------------------------------------------

    /**
     * Before Even's firmware goes back: g1v0's asset store took the flash where Even's fonts and pictures were, so if it
     * ever wrote there, Even's firmware must meet erased flash (flash.py's `wipe_store`). A store that was never written
     * is left alone, and Even's data with it. True when it was erased.
     */
    private fun clearStore(hello: G1Protocol.Hello): Boolean {
        repeat(3) {
            val info = assetInfo()
            if (info == null) {
                log("no asset store: this firmware never wrote where Even's data is")
                return false
            }
            if (!info.available) {
                log("the asset store is unavailable, so nothing was written to it")
                return false
            }
            if (info.running) {
                // A retried request can find its own job running, as can a retry after a link lost during a wipe.
                log("a storage job is running: waiting for it to end")
                clearStoreNotices()
                waitStoreJob(ANY_STORE_JOB, timings.wipeMs.toLong())
                return@repeat
            }
            if (!storeWritten(info, hello)) {
                log("the asset store was never written: Even's fonts and pictures stay as they are")
                return false
            }
            if (hello.safeMode) throw IllegalStateException(safeModeMessage())
            listener.onState("wiping", side)
            log("erasing the asset store (${info.assets} assets, commit ${info.seq})")
            val startedAt = now()
            clearStoreNotices()
            when (val status = control(G1Protocol.OP_ASSET_FORMAT, G1Protocol.assetFormatRequest(wipe = true)).status) {
                0 -> {
                    val result = waitStoreJob(G1Protocol.STORE_JOB_FORMAT, timings.wipeMs.toLong())
                    if (result == STORE_JOB_INTERRUPTED) {
                        throw IllegalStateException("The $side arm restarted while erasing Faceclaw's storage. Nothing was installed; retry to finish it.")
                    }
                    if (result != 0) {
                        throw IllegalStateException("The $side arm couldn't erase Faceclaw's storage (error $result). Nothing was installed.")
                    }
                    log("asset store erased in ${(now() - startedAt) / 1000} s")
                    return true
                }
                G1Protocol.STATUS_SAFE_MODE -> throw IllegalStateException(safeModeMessage())
                // A job runs: the next round waits for it.
                G1Protocol.STATUS_ASSET -> {}
                else -> throw IllegalStateException("The $side arm refused to erase Faceclaw's storage (error $status). Nothing was installed.")
            }
        }
        throw IllegalStateException("The $side arm's storage couldn't be erased. Nothing was installed.")
    }

    private fun safeModeMessage(): String =
        "The $side arm is in safe mode (its firmware restarted repeatedly), where it can't erase Faceclaw's storage, and that has to " +
            "happen before Even's firmware goes back. Install Faceclaw's firmware again, then uninstall it. Nothing was installed."

    /**
     * Whether g1v0 ever wrote to the store. It only reads it at boot, so with no assets and no commit nothing was written,
     * unless a format erased the directory's two sectors (a format resets the commit count), which their fingerprint shows.
     */
    private fun storeWritten(info: G1Protocol.AssetInfo, hello: G1Protocol.Hello): Boolean {
        if (info.assets > 0 || info.seq != 0L) return true
        if (hello.safeMode) {
            log("safe mode: the directory can't be checked")
            return true
        }
        val nonErased = flashNonErased(G1Protocol.STORE_ADDRESS, G1Protocol.STORE_DIRECTORY_BYTES)
        log("the store's directory sectors: ${nonErased ?: "unknown"} bytes not erased")
        return nonErased == null || nonErased == 0L
    }

    /** How many bytes of flash [from]…[from] + [n] - 1 aren't 0xFF, or null when the arm didn't say. */
    private fun flashNonErased(from: Int, n: Int): Long? {
        clearStoreNotices()
        val status = try {
            control(G1Protocol.OP_FLASH_CRC, G1Protocol.flashCrcRequest(from, n)).status
        } catch (e: StockTimeoutException) {
            return null
        }
        // 13: a crc job runs, which a retried request finds when the first one's reply was lost; its notice says the same.
        if (status != 0 && status != G1Protocol.STATUS_ASSET) return null
        val deadline = now() + timings.crcMs
        while (now() < deadline) {
            throwIfCancelled()
            val notice = lock.withLock {
                storeNotices.firstOrNull { it.job == G1Protocol.STORE_JOB_CRC && it.address == from && it.n == n }
            }
            if (notice != null) return if (notice.result == 0) notice.nonErased else null
            if (!link.isConnected(address)) return null
            sleeper.sleep(timings.pollMs.toLong())
        }
        return null
    }

    private fun assetInfo(): G1Protocol.AssetInfo? {
        val reply = control(G1Protocol.OP_ASSET_INFO)
        return if (reply.status == 0) G1Protocol.parseAssetInfo(reply.body) else null
    }

    private fun clearStoreNotices() = lock.withLock { storeNotices.clear() }

    /**
     * The result of the store job running now: its `NOTICE` 8, or `ASSET_INFO`'s state once it has ended (a notice is lost
     * with the link, and the job goes on without it). [STORE_JOB_INTERRUPTED] when the arm restarted meanwhile, which ends
     * a job unfinished.
     */
    private fun waitStoreJob(job: Int, timeoutMs: Long): Int {
        val deadline = now() + timeoutMs
        var askAt = now() + timings.storePollMs
        while (true) {
            throwIfCancelled()
            val notice = lock.withLock { storeNotices.firstOrNull { job == ANY_STORE_JOB || it.job == job } }
            if (notice != null) return notice.result
            if (now() >= deadline) throw StockTimeoutException("the $side arm's storage job didn't end within ${timeoutMs / 60_000} minutes")
            if (now() >= askAt) {
                askAt = now() + timings.storePollMs
                val info = try {
                    assetInfo()
                } catch (e: Exception) {
                    if (e !is StockTimeoutException && e !is LinkLostException) throw e
                    log("no answer while the storage job runs (${e.message})")
                    reconnectIfNeeded()
                    null
                }
                when (info?.state) {
                    G1Protocol.STORE_DONE -> return info.lastError
                    G1Protocol.STORE_FAILED -> return if (info.lastError != 0) info.lastError else G1Protocol.STATUS_ASSET
                    // A job leaves the state at done or failed until the next boot.
                    G1Protocol.STORE_IDLE -> return STORE_JOB_INTERRUPTED
                }
            }
            sleeper.sleep(timings.pollMs.toLong())
        }
    }

    private fun requireBattery(percent: Int?) {
        if (percent != null && percent < MIN_BATTERY_PERCENT) {
            throw IllegalStateException("The $side arm's battery is at $percent%, too low to install safely. " +
                "Charge both arms to at least $MIN_BATTERY_PERCENT% in the case, then try again.")
        }
    }

    private fun holdsImage(slots: List<G1Smp.Slot>, imageIndex: Int, hash: ByteArray): Boolean =
        slots.any { it.image == imageIndex && it.slot == 1 && it.hash.contentEquals(hash) }

    private fun images(): List<G1Smp.Slot> =
        G1Smp.parseSlots(smp(G1Smp.OP_READ, G1Smp.GROUP_IMAGE, G1Smp.CMD_IMAGE_STATE, emptyMap(), timings.smpReplyMs))

    /**
     * MCUmgr answers each chunk with the offset it wants next, so an upload resumes after a lost link. Progress counts
     * [before] bytes of earlier parts out of [total].
     */
    private fun upload(image: ByteArray, imageIndex: Int, part: Int = 1, parts: Int = 1, before: Int = 0, total: Int = image.size) {
        val fileSha = sha256(image)
        var offset = 0
        var failures = 0
        while (offset < image.size) {
            throwIfCancelled()
            val reply = try {
                smp(G1Smp.OP_WRITE, G1Smp.GROUP_IMAGE, G1Smp.CMD_IMAGE_UPLOAD, G1Smp.uploadRequest(image, offset, fileSha, imageIndex), timings.uploadReplyMs)
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
            listener.onProgress(side, part, parts, offset, image.size, (before + offset).toLong(), total.toLong())
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
                throw IllegalStateException("Couldn't reach the $side arm: $failure. Keep the glasses in the case with the lid open; a fully " +
                    "charged arm can take up to 5 minutes to notice it's in the case. If this phone was paired with these glasses before and " +
                    "this keeps happening, remove them from its Bluetooth settings and try again.")
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
            if (!haveCharacteristic(G1Smp.NUS_TX_UUID)) throw IllegalStateException("no link to Even's service")
            if (!subscribe(G1Smp.NUS_TX_UUID)) {
                // Bonded and refused: Even's firmware keeps one bond and has lost this one. This run started in the case.
                removeStaleBond()
                throw IllegalStateException("no link to Even's service")
            }
            heartbeats = 0
            nextHeartbeatAtMs = 0
        } else {
            if (!haveCharacteristic(G1Ble.EVT_CHAR_UUID)) {
                if (!link.isConnected(address)) throw LinkLostException("the link went down")
                throw NotG1v0Exception()
            }
            if (!subscribe(G1Ble.EVT_CHAR_UUID)) throw IllegalStateException("no events from the arm")
            // Out of the case the arm obeys only an encrypted link.
            settleBond()
            val paired = try {
                link.writeFrames(address, G1Ble.PAIR_CHAR_UUID, listOf(byteArrayOf(1)), GattWriteMode.WITH_RESPONSE, timings.pairingMs)
            } catch (e: IllegalStateException) {
                false
            }
            if (!paired) {
                // The OS says bonded and the arm disagrees. Giving that up is safe only where a new bond can be made.
                if (link.isConnected(address) && inCaseWithoutEncryption()) removeStaleBond()
                throw IllegalStateException("no encrypted link: an arm pairs only in its case")
            }
        }
        if (mode != Mode.PROBE && (!haveCharacteristic(G1Smp.SMP_CHAR_UUID) || !subscribe(G1Smp.SMP_CHAR_UUID))) {
            throw IllegalStateException("no update service")
        }
    }

    /** An arm keeps its address across an install, and the OS may remember the services it had before: look again before believing that. */
    private fun haveCharacteristic(uuid: String): Boolean {
        if (link.hasCharacteristic(address, uuid)) return true
        log("no $uuid in the service table: reading it again")
        link.refreshServices(address, timings.servicesTimeoutMs)
        return link.hasCharacteristic(address, uuid)
    }

    private fun subscribe(uuid: String): Boolean = try {
        link.enableNotifications(address, uuid, timings.descriptorTimeoutMs)
    } catch (e: IllegalStateException) {
        false
    }

    private fun removeStaleBond() {
        if (bondRemoved || link.bondState(address) != BondState.BONDED) return
        if (link.removeBond(address)) {
            bondRemoved = true
            log("the arm no longer has this phone's pairing: removed it, pairing again")
        }
    }

    /** An unencrypted link gets an answer only from an arm in the case. */
    private fun inCaseWithoutEncryption(): Boolean = try {
        val hello = G1Protocol.parseHello(control(G1Protocol.OP_HELLO, tries = 1).body)
        hello != null && hello.inCase && !hello.encrypted
    } catch (e: Exception) {
        false
    }

    /** Null when no answer came, which firmware that doesn't have the query also gives. */
    private fun stockBatteryPercent(): Int? {
        repeat(timings.controlTries) {
            val latch = Latch(1, platform)
            lock.withLock {
                stockBattery = null
                stockBatteryLatch = latch
            }
            try {
                link.writeFrames(address, G1Smp.NUS_RX_UUID, listOf(G1Smp.STOCK_BATTERY_QUERY), GattWriteMode.WITHOUT_RESPONSE, timings.writeTimeoutMs)
            } catch (e: IllegalStateException) {
                return null
            }
            latch.await(timings.controlReplyMs.toLong())
            throwIfCancelled()
            val answer = lock.withLock {
                stockBatteryLatch = null
                stockBattery
            }
            if (answer != null) return answer
        }
        return null
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

    private fun control(op: Int, body: ByteArray = ByteArray(0), tries: Int = timings.controlTries): G1Protocol.Reply {
        repeat(tries) {
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
        } else if (characteristicUuid.equals(G1Smp.NUS_TX_UUID, ignoreCase = true)) {
            val percent = G1Smp.parseStockBattery(data) ?: return
            lock.withLock {
                stockBattery = percent
                stockBatteryLatch?.countDown()
            }
        } else if (characteristicUuid.equals(G1Ble.EVT_CHAR_UUID, ignoreCase = true)) {
            val notice = G1Protocol.parseStoreNotice(data)
            if (notice != null) {
                lock.withLock { storeNotices.add(notice) }
                return
            }
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
