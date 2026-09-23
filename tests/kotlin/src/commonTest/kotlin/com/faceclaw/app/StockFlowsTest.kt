package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** A stock-firmware lens pair behind the StockLink port; replies are scripted per written message. */
private class FakeStockLink : StockLink {
    class Written(val address: String, val uuid: String, val sid: Int, val flag: Int, val seq: Int, val pb: ByteArray) {
        /** Protobuf magic (field 2) of a control message; -1 for OTA payloads. */
        val magic: Int get() = if (sid == 0xc0 || sid == 0xc1) -1 else BleProtocol.readVarintFieldValue(BleProtocol.stripTrailingCrc(pb), 2, -1)
    }

    var inbound: StockLinkListener? = null
    val connected = HashSet<String>()
    val bond = HashMap<String, BondState>()
    val writes = ArrayList<Written>()
    var connectResult: (String) -> Boolean = { true }
    var responder: (Written) -> Unit = {}
    var closed = false

    override fun setListener(listener: StockLinkListener?) { inbound = listener }
    override fun connect(address: String, timeoutMs: Int): Boolean = connectResult(address).also { if (it) connected.add(address) }
    override fun prepareLink(address: String, desiredMtu: Int, timeoutMs: Int) {}
    override fun discoverServices(address: String, timeoutMs: Int): Boolean = address in connected
    override fun enableNotifications(address: String, characteristicUuid: String, timeoutMs: Int): Boolean = address in connected
    override fun writeFrames(address: String, characteristicUuid: String, frames: List<ByteArray>, mode: GattWriteMode, timeoutMs: Int): Boolean {
        if (address !in connected) throw IllegalStateException("Not connected: $address")
        val head = frames.first()
        val body = ByteArray(frames.sumOf { it.size - 8 })
        var at = 0
        for (f in frames) { f.copyInto(body, at, 8); at += f.size - 8 }
        val written = Written(address, characteristicUuid, head[6].toInt() and 0xff, head[7].toInt() and 0xff, head[2].toInt() and 0xff, body)
        writes.add(written)
        responder(written)
        return true
    }
    override fun isConnected(address: String): Boolean = address in connected
    override fun bondState(address: String): BondState = bond[address] ?: BondState.BONDED
    override fun disconnect(address: String) { connected.remove(address) }
    override fun close() { closed = true; connected.clear() }

    /** Deliver a lens frame on the control notify characteristic. */
    fun notify(address: String, pb: ByteArray, sid: Int, flag: Int = 0) {
        for (frame in BleProtocol.framePb(pb, sid, flag, 7)) inbound!!.onNotification(address, BleProtocol.NOTIFY_CHAR_UUID, frame)
    }
    fun otaAck(address: String, op: Int, status: Int) {
        inbound!!.onNotification(address, BleProtocol.OTA_DATA_NOTIFY_UUID, BleProtocol.framePb(byteArrayOf(op.toByte(), status.toByte()), 0xc1, 0, 1).single())
    }
    fun drop(address: String) { connected.remove(address); inbound!!.onConnectionStateChange(address, false) }
}

private fun varint(value: Int): ByteArray { var v = value; val out = ArrayList<Byte>(); do { var b = v and 0x7f; v = v ushr 7; if (v != 0) b = b or 0x80; out.add(b.toByte()) } while (v != 0); return out.toByteArray() }
private fun field(number: Int, bytes: ByteArray): ByteArray = varint((number shl 3) or 2) + varint(bytes.size) + bytes
private fun field(number: Int, text: String): ByteArray = field(number, text.encodeToByteArray())
private fun authSuccess(magic: Int) = BleProtocol.encodeVarintField(1, 4) + BleProtocol.encodeVarintField(2, magic) + field(3, ByteArray(0))
private fun authPending(magic: Int) = BleProtocol.encodeVarintField(1, 4) + BleProtocol.encodeVarintField(2, magic) + field(3, BleProtocol.encodeVarintField(1, 1))
private fun ack(magic: Int) = BleProtocol.encodeVarintField(1, 1) + BleProtocol.encodeVarintField(2, magic)
private fun settingsAck(magic: Int, battery: Int = -1, left: String = "", right: String = "", extension: String = ""): ByteArray {
    var request = ByteArray(0)
    if (left.isNotEmpty()) request += field(5, left)
    if (right.isNotEmpty()) request += field(6, right)
    if (battery >= 0) request += BleProtocol.encodeVarintField(12, battery)
    var pb = BleProtocol.encodeVarintField(1, 2) + BleProtocol.encodeVarintField(2, magic) + field(4, request)
    if (extension.isNotEmpty()) pb += field(100, extension)
    return pb
}
private fun listSelection(container: String, item: String, index: Int, eventType: Int): ByteArray =
    field(13, field(1, field(2, container) + field(3, item) + BleProtocol.encodeVarintField(4, index) + BleProtocol.encodeVarintField(5, eventType)))

private val fast = StockFlowTimings(
    securityAuthTimeoutMs = 300, securityAuthSoftTimeoutMs = 100, pairingWaitCapMs = 2_000, postBondGraceMs = 20, pollMs = 5,
    armRetryDelayMs = 5, queryTimeoutMs = 40, preludeTimeoutMs = 40, heartbeatIntervalMs = 15, selectionTimeoutMs = 80, createAckTimeoutMs = 40,
    batteryAckTimeoutMs = 40, blockAckTimeoutMs = 60, ctrlAckTimeoutMs = 60, firstLensConnectWindowMs = 200, secondLensConnectWindowMs = 200,
    rebootSettleMs = 5, notifySettleMs = 5, otaRetryDelayMs = 5, componentRetryDelayMs = 5,
)

private const val R = "AA:00:00:00:00:01"
private const val L = "AA:00:00:00:00:02"

private class ProbeEvents : FaceclawDeviceInfoProbeListener {
    val logs = ArrayList<String>(); val states = ArrayList<String>(); var result: List<String>? = null; var error: String? = null
    override fun onLog(line: String?) { logs.add(line ?: "") }
    override fun onState(state: String?, detail: String?) { states.add("$state:$detail") }
    override fun onResult(leftVersion: String?, rightVersion: String?, extension: String?) { result = listOf(leftVersion ?: "", rightVersion ?: "", extension ?: "") }
    override fun onError(message: String?) { error = message }
}

/** Standard lens behaviour: auth succeeds, prelude and settings are acked with the given versions/battery. */
private fun stockResponder(link: FakeStockLink, left: String = "2.2.9", right: String = "2.2.9", extension: String = "", battery: Int = 85): (FakeStockLink.Written) -> Unit = { w ->
    when (w.sid) {
        BleProtocol.SID_SECURITY_AUTH -> link.notify(w.address, authSuccess(w.magic), w.sid)
        BleProtocol.PRELUDE_ACK_SID -> link.notify(w.address, ack(BleProtocol.PRELUDE_ACK_MAGIC), w.sid)
        BleProtocol.SID_UI_SETTING -> link.notify(w.address, settingsAck(w.magic, battery, left, right, extension), w.sid)
        BleProtocol.SID_EVENHUB -> link.notify(w.address, ack(w.magic), w.sid)
    }
}

class StockFlowsTest {
    @Test
    fun probeAuthenticatesBothArmsThenReadsVersions() {
        val link = FakeStockLink()
        link.responder = stockResponder(link, "L1", "R1", "Faceclaw/3")
        val events = ProbeEvents()
        DeviceInfoProbeFlow(link, R, L, events, fast, testPlatform()).run()
        assertEquals(listOf("L1", "R1", "Faceclaw/3"), events.result)
        assertEquals(null, events.error)
        assertEquals(listOf("connecting:right", "authenticating:right", "connecting:left", "authenticating:left", "querying:right"), events.states)
        // Right arm then left arm auth, then prelude + one settings read on the right arm only.
        assertEquals(listOf(R, L), link.writes.filter { it.sid == BleProtocol.SID_SECURITY_AUTH }.map { it.address })
        assertEquals(listOf(R), link.writes.filter { it.sid == BleProtocol.SID_UI_SETTING }.map { it.address })
        assertTrue(link.closed)
    }

    @Test
    fun probeUsesUnsolicitedSettingsPushAndFallsBackToLeftLens() {
        // Right lens: auth ok, but the settings read is never acked; instead a push on a
        // device-chosen magic carries the versions.
        val pushed = FakeStockLink()
        pushed.responder = { w ->
            when (w.sid) {
                BleProtocol.SID_SECURITY_AUTH -> pushed.notify(w.address, authSuccess(w.magic), w.sid)
                BleProtocol.PRELUDE_ACK_SID -> pushed.notify(w.address, ack(BleProtocol.PRELUDE_ACK_MAGIC), w.sid)
                BleProtocol.SID_UI_SETTING -> pushed.notify(w.address, settingsAck(250, -1, "P1", "P2", ""), w.sid)
            }
        }
        var events = ProbeEvents()
        DeviceInfoProbeFlow(pushed, R, "", events, fast, testPlatform()).run()
        assertEquals(listOf("P1", "P2", ""), events.result)
        assertTrue(events.logs.any { it.contains("unsolicited settings push") })

        // Right lens silent on settings (both attempts); the left lens answers.
        val silentRight = FakeStockLink()
        silentRight.responder = { w ->
            when (w.sid) {
                BleProtocol.SID_SECURITY_AUTH -> silentRight.notify(w.address, authSuccess(w.magic), w.sid)
                BleProtocol.PRELUDE_ACK_SID -> silentRight.notify(w.address, ack(BleProtocol.PRELUDE_ACK_MAGIC), w.sid)
                BleProtocol.SID_UI_SETTING -> if (w.address == L) silentRight.notify(w.address, settingsAck(w.magic, -1, "LL", "RR", ""), w.sid)
            }
        }
        events = ProbeEvents()
        DeviceInfoProbeFlow(silentRight, R, L, events, fast, testPlatform()).run()
        assertEquals(listOf("LL", "RR", ""), events.result)
        assertTrue(events.logs.any { it.contains("probing the left lens") })
        assertEquals(2, silentRight.writes.count { it.sid == BleProtocol.SID_UI_SETTING && it.address == R })
        assertContains(events.states, "querying:left")
    }

    @Test
    fun probeWaitsThroughPairingAndResendsAfterBond() {
        // Unbonded phone: the first auth request is answered with the pre-encryption
        // non-success result, the OS then pairs (no writes while BONDING), and once bonded the
        // request is re-sent after the grace period and finally succeeds.
        val link = FakeStockLink()
        link.bond[R] = BondState.NONE
        val authReplies = ArrayList<Int>()
        link.responder = { w ->
            when (w.sid) {
                BleProtocol.SID_SECURITY_AUTH -> { authReplies.add(w.magic); link.notify(w.address, if (authReplies.size == 1) authPending(w.magic) else authSuccess(w.magic), w.sid) }
                BleProtocol.PRELUDE_ACK_SID -> link.notify(w.address, ack(BleProtocol.PRELUDE_ACK_MAGIC), w.sid)
                BleProtocol.SID_UI_SETTING -> link.notify(w.address, settingsAck(w.magic, -1, "a", "b", ""), w.sid)
            }
        }
        startThread("bond-flip", true) { sleepMs(20); link.bond[R] = BondState.BONDING; sleepMs(40); link.bond[R] = BondState.BONDED }
        val events = ProbeEvents()
        DeviceInfoProbeFlow(link, R, "", events, fast, testPlatform()).run()
        assertEquals(listOf("a", "b", ""), events.result, events.logs.joinToString("\n"))
        assertTrue(events.logs.any { it.contains("is not the success result") })
        assertTrue(events.logs.any { it.contains("is pairing with the right lens") })
        assertTrue(events.logs.any { it.contains("bond established") })
        assertTrue(events.logs.any { it.contains("re-sending the auth request after pairing") })
        assertEquals(2, authReplies.size)
        assertTrue(events.logs.any { it.contains("security auth complete: right lens") })
    }

    @Test
    fun probeReportsUnreachableArmAndCancel() {
        val link = FakeStockLink()
        link.connectResult = { false }
        val events = ProbeEvents()
        DeviceInfoProbeFlow(link, R, L, events, fast, testPlatform()).run()
        assertNotNull(events.error).let { assertTrue(it.contains("could not connect to the right lens"), it) }
        assertEquals(3, events.states.count { it == "connecting:right" })

        val cancelled = FakeStockLink()
        cancelled.responder = { w -> if (w.sid == BleProtocol.SID_SECURITY_AUTH) cancelled.notify(w.address, authPending(w.magic), w.sid) }
        val slow = StockFlowTimings(securityAuthTimeoutMs = 5_000, pollMs = 5)
        val flow = DeviceInfoProbeFlow(cancelled, R, "", ProbeEvents().also { events.logs.clear() }, slow, testPlatform())
        startThread("cancel", true) { sleepMs(30); flow.cancel() }
        val start = testPlatform().elapsedRealtimeMs()
        flow.run()
        assertTrue(testPlatform().elapsedRealtimeMs() - start < 2_000)
        assertTrue(flow.cancelled)
    }

    private class PromptEvents : FaceclawFlashPromptListener {
        val logs = ArrayList<String>(); val states = ArrayList<String>(); var battery: Pair<Int, Int>? = null; var result: Boolean? = null
        override fun onLog(line: String?) { logs.add(line ?: "") }
        override fun onState(state: String?, detail: String?) { states.add("$state:$detail") }
        override fun onBattery(rightPercent: Int, leftPercent: Int) { battery = rightPercent to leftPercent }
        override fun onResult(approved: Boolean) { result = approved }
    }

    private fun promptResponder(link: FakeStockLink, selection: Int?, batteries: Map<String, Int>): (FakeStockLink.Written) -> Unit = { w ->
        when (w.sid) {
            BleProtocol.SID_SECURITY_AUTH -> link.notify(w.address, authSuccess(w.magic), w.sid)
            BleProtocol.PRELUDE_ACK_SID -> link.notify(w.address, ack(BleProtocol.PRELUDE_ACK_MAGIC), w.sid)
            BleProtocol.SID_UI_SETTING -> link.notify(w.address, settingsAck(w.magic, batteries[w.address] ?: -1), w.sid)
            BleProtocol.SID_EVENHUB -> {
                val cmd = BleProtocol.readVarintFieldValue(BleProtocol.stripTrailingCrc(w.pb), 1, -1)
                link.notify(w.address, ack(w.magic), w.sid)
                // Cmd 0 = create page: the user taps a row right away (a scroll first, which must be ignored).
                if (cmd == 0 && selection != null) {
                    link.notify(w.address, listSelection(FlashPromptFlow.LIST_NAME, "other", 0, BleProtocol.EVENT_SCROLL_TOP), BleProtocol.SID_EVENHUB, BleProtocol.FLAG_NOTIFY)
                    link.notify(w.address, listSelection(FlashPromptFlow.LIST_NAME, FlashPromptFlow.ITEMS[selection], selection, BleProtocol.EVENT_CLICK), BleProtocol.SID_EVENHUB, BleProtocol.FLAG_NOTIFY)
                }
            }
        }
    }

    @Test
    fun promptApprovalReadsBothBatteriesAndShutsDown() {
        val link = FakeStockLink()
        link.responder = promptResponder(link, 1, mapOf(R to 85, L to 70))
        val events = PromptEvents()
        FlashPromptFlow(link, R, L, "warning", false, events, fast, testPlatform()).run()
        assertEquals(true, events.result, events.logs.joinToString("\n"))
        assertEquals(85 to 70, events.battery)
        assertEquals(listOf("connecting:", "connected:", "prompting:", "battery:", "result:approved"), events.states)
        val hub = link.writes.filter { it.sid == BleProtocol.SID_EVENHUB }.map { BleProtocol.readVarintFieldValue(BleProtocol.stripTrailingCrc(it.pb), 1, -1) }
        assertEquals(0, hub.first()) // create page
        assertEquals(9, hub.last()) // shutdown
        assertTrue(link.writes.all { it.sid != BleProtocol.SID_EVENHUB || it.address == R })
        assertTrue(link.closed)
    }

    @Test
    fun promptDeclineTimeoutAndSkip() {
        val declined = FakeStockLink()
        declined.responder = promptResponder(declined, 0, mapOf())
        var events = PromptEvents()
        FlashPromptFlow(declined, R, "", "w", false, events, fast, testPlatform()).run()
        assertEquals(false, events.result)
        assertEquals("result:declined", events.states.last())
        assertEquals(null, events.battery)

        val silent = FakeStockLink()
        silent.responder = promptResponder(silent, null, mapOf())
        events = PromptEvents()
        FlashPromptFlow(silent, R, "", "w", false, events, fast, testPlatform()).run()
        assertEquals(null, events.result)
        assertEquals("timeout:No response from the glasses.", events.states.last())
        // Heartbeats (EvenHub cmd 12) kept the page alive while waiting (interval 15 ms, wait 80 ms).
        assertTrue(silent.writes.count { it.sid == BleProtocol.SID_EVENHUB && BleProtocol.readVarintFieldValue(BleProtocol.stripTrailingCrc(it.pb), 1, -1) == 12 } >= 2)

        val skipped = FakeStockLink()
        skipped.responder = promptResponder(skipped, null, mapOf(R to 50))
        events = PromptEvents()
        FlashPromptFlow(skipped, R, L, "w", true, events, fast, testPlatform()).run()
        assertEquals(true, events.result)
        assertEquals(50 to -1, events.battery)
        assertFalse(skipped.writes.any { it.sid == BleProtocol.SID_EVENHUB })

        val lost = FakeStockLink()
        lost.responder = { w ->
            promptResponder(lost, null, mapOf())(w)
            if (w.sid == BleProtocol.SID_EVENHUB) lost.drop(R)
        }
        events = PromptEvents()
        FlashPromptFlow(lost, R, "", "w", false, events, fast, testPlatform()).run()
        assertEquals("disconnected:Lost connection to the glasses.", events.states.last())
    }

    // ---- OTA ---------------------------------------------------------------

    private fun putU32(buf: ByteArray, offset: Int, value: Long) { for (i in 0 until 4) buf[offset + i] = ((value ushr (8 * i)) and 0xff).toByte() }

    private fun container(): ByteArray {
        val mainApp = ByteArray(6000) { (it * 7).toByte() }.also { putU32(it, 0, 6000L); putU32(it, 0x14, FirmwareImage.APP_LOAD_ADDR) }
        val components = listOf("ota/bootloader.bin" to ByteArray(300) { it.toByte() }, "ota/a.bin" to ByteArray(64) { 1 }, "ota/b.bin" to ByteArray(128) { 2 }, "ota/c.bin" to ByteArray(32) { 3 }, FirmwareImage.REQUIRED_SEGMENT to mainApp)
        val toc = FirmwareImage.HEADER_SIZE + components.size * FirmwareImage.TOC_ENTRY_SIZE
        var offset = toc
        val offsets = components.map { c -> offset.also { offset += FirmwareImage.SUBHEADER_SIZE + c.second.size } }
        val img = ByteArray(offset)
        putU32(img, 8, components.size.toLong())
        components.forEachIndexed { i, c ->
            val off = offsets[i]
            putU32(img, FirmwareImage.HEADER_SIZE + i * 16 + 4, off.toLong())
            putU32(img, off + 8, c.second.size.toLong())
            c.first.encodeToByteArray().copyInto(img, off + FirmwareImage.NAME_OFFSET)
            c.second.copyInto(img, off + FirmwareImage.SUBHEADER_SIZE)
            val crc = FirmwareImage.crc32cUnsigned(c.second)
            putU32(img, FirmwareImage.HEADER_SIZE + i * 16 + 12, crc)
            putU32(img, off + 12, crc)
        }
        return img
    }

    private class FlashEvents : FaceclawFirmwareFlasherListener {
        val logs = ArrayList<String>(); val states = ArrayList<String>(); val progress = ArrayList<String>(); var complete: Pair<Boolean, String>? = null
        override fun onLog(line: String?) { logs.add(line ?: "") }
        override fun onProgress(lens: String?, componentIndex: Int, componentCount: Int, blockIndex: Int, blockCount: Int, bytesSent: Long, bytesTotal: Long) { progress.add("$lens $componentIndex/$componentCount $blockIndex/$blockCount $bytesSent/$bytesTotal") }
        override fun onState(state: String?, detail: String?) { states.add("$state:$detail") }
        override fun onComplete(success: Boolean, detail: String?) { complete = success to (detail ?: "") }
    }

    /** OTA lens: NAKs one block once and fails one END once, exercising both retry paths. */
    private class OtaLens(val link: FakeStockLink) {
        val received = HashMap<String, ByteArray>()
        var nakOnce = true
        var failEndOnce = true
        var component = ByteArray(0)
        fun respond(w: FakeStockLink.Written) {
            when (w.sid) {
                BleProtocol.SID_SECURITY_AUTH -> link.notify(w.address, authSuccess(w.magic), w.sid)
                OtaFlashFlow.SID_CTRL -> {
                    val pb = BleProtocol.stripTrailingCrc(w.pb)
                    when (pb[0].toInt()) {
                        OtaFlashFlow.OP_BEGIN -> link.otaAck(w.address, OtaFlashFlow.OP_BEGIN, 0)
                        OtaFlashFlow.OP_FILE_CHECK -> { component = ByteArray(0); link.otaAck(w.address, OtaFlashFlow.OP_FILE_CHECK, 0) }
                        OtaFlashFlow.OP_END -> {
                            val status = if (failEndOnce) { failEndOnce = false; 5 } else { received[w.address] = (received[w.address] ?: ByteArray(0)) + component; 9 }
                            link.otaAck(w.address, OtaFlashFlow.OP_END, status)
                        }
                        OtaFlashFlow.OP_BLOCK -> {}
                    }
                }
                OtaFlashFlow.SID_DATA -> {
                    val block = BleProtocol.stripTrailingCrc(w.pb)
                    if (nakOnce) { nakOnce = false; link.otaAck(w.address, OtaFlashFlow.OP_BLOCK, 1) } else { component += block; link.otaAck(w.address, OtaFlashFlow.OP_BLOCK, 0) }
                }
            }
        }
    }

    @Test
    fun otaFlashesBothLensesWithBlockNakAndEndRetry() {
        val img = container()
        val segs = FirmwareImage.validate(img)
        val link = FakeStockLink()
        val lens = OtaLens(link)
        link.responder = lens::respond
        val events = FlashEvents()
        OtaFlashFlow(link, R, L, "fw.bin", events, fast, testPlatform()) { img }.run()
        assertEquals(true to "Both lenses flashed. The glasses are rebooting into the custom firmware.", events.complete, events.logs.joinToString("\n"))
        assertEquals(listOf("validating:", "connecting:left", "flashing:left", "rebooting:Left lens done. Both lenses reboot briefly; reconnecting for the right lens.", "connecting:right", "flashing:right", "done:"), events.states)
        // Every component payload arrived intact on both lenses, in order.
        val expected = segs.fold(ByteArray(0)) { acc, s -> acc + img.copyOfRange(s.payloadStart, s.payloadStart + s.ps) }
        assertContentEquals(expected, lens.received[L]!!)
        assertContentEquals(expected, lens.received[R]!!)
        assertTrue(events.logs.any { it.contains("NAK=1 resend 1/3") })
        assertTrue(events.logs.any { it.contains("END verify FAILED (status 5)") })
        assertTrue(events.logs.any { it.contains("re-flash attempt 2/3") })
        assertEquals("left 5/5 2/2 6524/6524", events.progress.first { it.startsWith("left 5/5 2") })
        // Marker + data share one envelope seq; the OTA stream restarts at 1 per lens.
        val leftOta = link.writes.filter { it.address == L && it.uuid == BleProtocol.OTA_DATA_WRITE_UUID }
        assertEquals(1, leftOta.first().seq)
        val firstBlock = leftOta.indexOfFirst { it.sid == OtaFlashFlow.SID_DATA }
        assertEquals(leftOta[firstBlock - 1].seq, leftOta[firstBlock].seq)
        assertEquals(setOf(BleProtocol.WRITE_CHAR_UUID), link.writes.filter { it.sid == BleProtocol.SID_SECURITY_AUTH }.map { it.uuid }.toSet())
    }

    @Test
    fun otaGivesUpWhenLensConnectWindowExpires() {
        val link = FakeStockLink()
        link.connectResult = { false }
        val events = FlashEvents()
        OtaFlashFlow(link, R, L, "fw.bin", events, fast, testPlatform()) { container() }.run()
        assertEquals(false to "could not reach left lens: connect/discover incomplete", events.complete)
        assertEquals("error:could not reach left lens: connect/discover incomplete", events.states.last())
        assertTrue(events.logs.count { it.contains("left connect attempt") } >= 2)
        assertTrue(link.closed)

        val unreadable = FlashEvents()
        OtaFlashFlow(FakeStockLink(), R, L, "/nonexistent/fw.bin", unreadable, fast, testPlatform()).run()
        assertTrue(unreadable.complete!!.second.startsWith("could not read firmware"), unreadable.complete!!.second)
    }
}
