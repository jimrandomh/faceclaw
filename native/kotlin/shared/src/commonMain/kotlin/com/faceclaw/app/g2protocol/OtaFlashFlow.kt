package com.faceclaw.app

/**
 * Ports g2flash.py's OTA flash procedure. Streams the EVENOTA firmware container to each lens
 * over the firmware-data service using the aa21 envelope (BleProtocol.framePb) and the c0/c1
 * control/data protocol.
 *
 * Each lens connection completes the sid-0x80 security-auth exchange before OTA BEGIN —
 * firmware 2.2.9 closes unauthenticated links ~30 s in, killing the transfer mid-component. No
 * control-channel traffic is injected during the transfer itself: official OTA captures show
 * none between BEGIN and the final END, heartbeats demonstrably do not satisfy the 2.2.9
 * deadline, and a concurrent control writer would interleave with the marker/data
 * transactions. (See notes/ble-connections-2.2.9.md.)
 *
 * Lenses are flashed one at a time (left, then right). Finishing either lens reboots BOTH
 * lenses, so the second lens is briefly unreachable — the reconnect for it uses a generous
 * window rather than failing fast. [run] executes on the caller's worker thread.
 */
class OtaFlashFlow(
    link: StockLink,
    rightAddress: String,
    leftAddress: String,
    private val firmwarePath: String,
    private val listener: FaceclawFirmwareFlasherListener,
    private val timings: StockFlowTimings = StockFlowTimings(),
    platform: ProtocolPlatform = protocolPlatform(),
    /** Test seam: the firmware container bytes; defaults to reading [firmwarePath]. */
    private val readImage: (String) -> ByteArray = ::readFirmwareFile,
) {
    companion object {
        const val TAG = "FaceclawFlasher"

        // OTA message types (envelope sid byte) and control opcodes.
        const val SID_CTRL = 0xc0
        const val SID_DATA = 0xc1
        const val FLAG_OTA = 0x00
        const val OP_BEGIN = 0x00
        const val OP_FILE_CHECK = 0x01
        const val OP_BLOCK = 0x02
        const val OP_END = 0x03

        const val BLOCK_SIZE = 4096
        const val BLOCK_NAK_RETRIES = 3
        const val COMPONENT_RETRIES = 3

        // END ack statuses that mean "component accepted": SUCCESS, UPDATING, SYS_RESTART.
        private val END_OK = intArrayOf(0, 8, 9)
        private val EMPTY = ByteArray(0)

        fun isEndOk(status: Int): Boolean = END_OK.contains(status)

        private fun readFirmwareFile(path: String): ByteArray =
            try {
                readFileData(path)
            } catch (e: Exception) {
                throw IllegalStateException("could not read firmware: " + e.message, e)
            }
    }

    private val rightAddress = rightAddress.trim()
    private val leftAddress = leftAddress.trim()
    private val sleeper = InterruptibleSleep(platform)
    // The auth exchange uses its own magic range (0x60..0x7f) and the OTA envelope counter
    // starts at 1, mirroring the stock sequence.
    private val session = StockLinkSession(link, ::emitLog, timings, magicStart = 0x60, magicEnd = 0x7f, seqStart = 1, platform = platform)

    val cancelled: Boolean
        get() = session.cancelled

    fun cancel() {
        session.cancel()
        sleeper.interrupt()
    }

    fun run() {
        try {
            if (leftAddress.isEmpty() || rightAddress.isEmpty()) {
                throw IllegalStateException("Both lens addresses are required to flash.")
            }

            listener.onState("validating", "")
            val img = readImage(firmwarePath)
            val segs = FirmwareImage.validate(img)
            emitLog("firmware validated: " + segs.size + " components, " + img.size + " bytes")

            flashLens("left", leftAddress, img, segs, timings.firstLensConnectWindowMs)
            if (cancelled) {
                listener.onState("error", "Cancelled.")
                listener.onComplete(false, "Cancelled after the left lens.")
                return
            }

            listener.onState("rebooting", "Left lens done. Both lenses reboot briefly; reconnecting for the right lens.")
            sleeper.sleep(timings.rebootSettleMs.toLong())
            flashLens("right", rightAddress, img, segs, timings.secondLensConnectWindowMs)

            listener.onState("done", "")
            listener.onComplete(true, "Both lenses flashed. The glasses are rebooting into the custom firmware.")
        } catch (e: Exception) {
            val message = if (cancelled) "Cancelled." else StockLinkSession.messageOf(e)
            listener.onState("error", message)
            listener.onComplete(false, message)
        } finally {
            session.closeQuietly()
        }
    }

    private fun flashLens(lens: String, address: String, img: ByteArray, segs: List<FirmwareImage.Segment>, connectWindowMs: Int) {
        listener.onState("connecting", lens)
        connectLensResilient(lens, address, connectWindowMs)
        sleeper.sleep(timings.notifySettleMs.toLong())
        session.otaAcks.clear()
        // Fresh envelope counter for the OTA stream (the auth exchange during bring-up used its
        // own); mirrors the stock sequence.
        session.resetSeq(1)

        listener.onState("flashing", lens)
        val beginStatus = sendCtrlAndWait(address, OP_BEGIN, EMPTY, timings.ctrlAckTimeoutMs)
        if (!isEndOk(beginStatus)) {
            emitLog("warning: unexpected begin status $beginStatus; continuing")
        }
        // Progress is reported in bytes across the whole image: the segments are one large
        // firmware blob plus several small ones, so a bar stepped per segment would sit still
        // through the big one and then sprint through the rest.
        var totalBytes = 0L
        for (seg in segs) {
            totalBytes += seg.ps
        }
        var bytesBefore = 0L
        for (i in segs.indices) {
            if (cancelled) {
                throw IllegalStateException("Cancelled.")
            }
            flashComponentWithRetry(lens, address, i, segs.size, segs[i], img, bytesBefore, totalBytes)
            bytesBefore += segs[i].ps
        }
        emitLog("$lens lens: all components verified")
        session.disconnectQuietly(address)
    }

    private fun flashComponentWithRetry(
        lens: String,
        address: String,
        index: Int,
        count: Int,
        seg: FirmwareImage.Segment,
        img: ByteArray,
        bytesBefore: Long,
        totalBytes: Long,
    ) {
        for (attempt in 0 until COMPONENT_RETRIES) {
            if (attempt > 0) {
                emitLog(seg.name + ": re-flash attempt " + (attempt + 1) + "/" + COMPONENT_RETRIES)
            }
            var endStatus: Int
            try {
                endStatus = flashComponent(lens, address, index, count, seg, img, bytesBefore, totalBytes)
            } catch (e: StockTimeoutException) {
                emitLog(seg.name + ": block phase failed: " + e.message)
                endStatus = -1
            } catch (e: RuntimeException) {
                emitLog(seg.name + ": block phase failed: " + e.message)
                endStatus = -1
            }
            if (isEndOk(endStatus)) {
                emitLog(seg.name + ": END verify OK (status " + endStatus + ")")
                return
            }
            if (endStatus >= 0) {
                emitLog(seg.name + ": END verify FAILED (status " + endStatus + ")")
            }
            session.otaAcks.clear()
            sleeper.sleep(timings.componentRetryDelayMs.toLong())
        }
        throw IllegalStateException("component " + seg.name + " failed after " + COMPONENT_RETRIES + " attempts")
    }

    private fun flashComponent(
        lens: String,
        address: String,
        index: Int,
        count: Int,
        seg: FirmwareImage.Segment,
        img: ByteArray,
        bytesBefore: Long,
        totalBytes: Long,
    ): Int {
        val sub = img.copyOfRange(seg.off, seg.off + FirmwareImage.SUBHEADER_SIZE)
        val ps = seg.ps
        val payloadStart = seg.off + FirmwareImage.SUBHEADER_SIZE

        val checkStatus = sendCtrlAndWait(address, OP_FILE_CHECK, sub, timings.ctrlAckTimeoutMs)
        if (checkStatus != 0) {
            throw IllegalStateException("FILE_CHECK rejected status=$checkStatus")
        }

        val blockCount = (ps + BLOCK_SIZE - 1) / BLOCK_SIZE
        for (b in 0 until blockCount) {
            if (cancelled) {
                throw IllegalStateException("Cancelled.")
            }
            val start = payloadStart + b * BLOCK_SIZE
            val end = minOf(start + BLOCK_SIZE, payloadStart + ps)
            val block = img.copyOfRange(start, end)

            var accepted = false
            for (tries in 0 until BLOCK_NAK_RETRIES) {
                val status = sendBlock(address, block) // throws StockTimeoutException -> component re-flash
                if (status == 0) {
                    accepted = true
                    break
                }
                emitLog(seg.name + ": block " + b + "/" + blockCount + " NAK=" + status + " resend " + (tries + 1) + "/" + BLOCK_NAK_RETRIES)
            }
            if (!accepted) {
                throw IllegalStateException("block " + b + " NAK'd " + BLOCK_NAK_RETRIES + " times")
            }
            if (b % 20 == 0 || b == blockCount - 1) {
                val bytesSent = bytesBefore + minOf((b + 1).toLong() * BLOCK_SIZE, ps.toLong())
                listener.onProgress(lens, index + 1, count, b + 1, blockCount, bytesSent, totalBytes)
            }
        }
        emitLog(seg.name + ": data phase done; sending END")
        return sendCtrlAndWait(address, OP_END, EMPTY, timings.ctrlAckTimeoutMs)
    }

    /** Send one 4 KB block as a marker + data pair sharing one envelope seq. */
    private fun sendBlock(address: String, block: ByteArray): Int {
        val seq = session.nextSeq()
        session.otaAcks.clear()
        writeOta(address, SID_CTRL, byteArrayOf(OP_BLOCK.toByte()), seq)
        writeOta(address, SID_DATA, block, seq)
        return waitAck(OP_BLOCK, timings.blockAckTimeoutMs)
    }

    private fun sendCtrlAndWait(address: String, op: Int, data: ByteArray, timeoutMs: Int): Int {
        val seq = session.nextSeq()
        session.otaAcks.clear()
        val payload = ByteArray(1 + data.size)
        payload[0] = op.toByte()
        data.copyInto(payload, 1)
        writeOta(address, SID_CTRL, payload, seq)
        return waitAck(op, timeoutMs)
    }

    private fun writeOta(address: String, sid: Int, payload: ByteArray, seq: Int): Boolean =
        session.writeFrame(address, BleProtocol.OTA_DATA_WRITE_UUID, sid, FLAG_OTA, payload, seq)

    private fun waitAck(wantOp: Int, timeoutMs: Int): Int {
        val deadline = session.now() + timeoutMs
        while (true) {
            val remaining = deadline - session.now()
            if (remaining <= 0 || cancelled) {
                break
            }
            val pb = session.otaAcks.poll(remaining) ?: break
            if (pb.size >= 2 && (pb[0].toInt() and 0xff) == wantOp) {
                return pb[1].toInt() and 0xff
            }
            // Different opcode (e.g. a late ack from a prior stage) — ignore, keep waiting.
        }
        throw StockTimeoutException("no ack op=0x" + wantOp.toString(16) + " within " + timeoutMs + "ms")
    }

    // ---- connection ----------------------------------------------------------

    private fun connectLensResilient(lens: String, address: String, windowMs: Int) {
        val deadline = session.now() + windowMs
        var lastError: String? = "unknown"
        var attempt = 0
        while (session.now() < deadline && !cancelled) {
            attempt++
            try {
                if (bringUpLens(address)) {
                    emitLog("connected $lens lens (attempt $attempt)")
                    return
                }
                lastError = "connect/discover incomplete"
            } catch (e: Exception) {
                lastError = StockLinkSession.messageOf(e)
            }
            emitLog("$lens connect attempt $attempt failed ($lastError); retrying...")
            session.disconnectQuietly(address)
            sleeper.sleep(timings.otaRetryDelayMs.toLong())
        }
        if (cancelled) {
            throw IllegalStateException("Cancelled.")
        }
        throw IllegalStateException("could not reach $lens lens: $lastError")
    }

    private fun bringUpLens(address: String): Boolean {
        try {
            // Control-channel notify carries the auth response; the OTA notify carries the acks.
            session.bringUp(address, otaChannel = true)
        } catch (e: IllegalStateException) {
            return false
        }
        // Complete the sid-0x80 security-auth exchange on this connection. On an unbonded
        // phone this triggers SMP pairing (possibly with an OS prompt), so the wait is
        // generous. Must succeed before any OTA traffic.
        if (session.authenticate(address, "ota") != StockLinkSession.AuthResult.SUCCESS) {
            throw IllegalStateException("security auth not acknowledged — if the phone shows a Bluetooth pairing request, accept it")
        }
        return true
    }

    // Log lines reach the platform log through the adapter's onLog (Android: logcat under TAG).
    private fun emitLog(line: String) {
        listener.onLog(line)
    }
}
