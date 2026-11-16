package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

private const val ARM = "F4:27:E9:CA:E8:3F"

private fun hex(text: String): ByteArray = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

/** An image the way MCUboot lays one out: header, payload, then a TLV area with its SHA-256. */
private fun testImage(version: Triple<Int, Int, Int> = Triple(0, 5, 64), payloadSize: Int = 5000): ByteArray {
    val headerSize = 512
    val hash = ByteArray(32) { (it * 3 + version.third).toByte() }
    val image = ByteArray(headerSize + payloadSize + 4 + 4 + 32)
    fun put16(at: Int, value: Int) {
        image[at] = value.toByte()
        image[at + 1] = (value ushr 8).toByte()
    }
    fun put32(at: Int, value: Int) {
        put16(at, value and 0xffff)
        put16(at + 2, value ushr 16)
    }
    put32(0, 0x96f3b83d.toInt())
    put16(8, headerSize)
    put32(12, payloadSize)
    image[20] = version.first.toByte()
    image[21] = version.second.toByte()
    put16(22, version.third)
    for (i in 0 until payloadSize) image[headerSize + i] = (i * 7).toByte()
    val tlv = headerSize + payloadSize
    put16(tlv, 0x6907)
    put16(tlv + 2, 4 + 4 + 32)
    put16(tlv + 4, 0x10)
    put16(tlv + 6, 32)
    hash.copyInto(image, tlv + 8)
    return image
}

/**
 * One arm behind the StockLink port: MCUmgr's image and OS groups as flash.py meets them on real arms, and g1v0's HELLO,
 * PROPS and asset store. Requests are answered synchronously, from the write. [netImage] is what a restore puts in image
 * 1's slot.
 */
private class FakeArm(private val image: ByteArray, var stock: Boolean = false, private val netImage: ByteArray? = null) : StockLink {
    var inbound: StockLinkListener? = null
    var connected = false
    var bond = BondState.BONDED
    var bondRequests = 0
    var bondResult = BondState.BONDED
    val subscribed = ArrayList<String>()
    val heartbeats = ArrayList<ByteArray>()
    val calls = ArrayList<String>()

    var runningVersion = "0.5.63"
    var safeMode = false
    var battery = 80

    /** The hash in each image's second slot. */
    val slotHashes = HashMap<Int, ByteArray>()
    var slot1Hash: ByteArray?
        get() = slotHashes[0]
        set(value) {
            if (value == null) slotHashes.remove(0) else slotHashes[0] = value
        }
    /** Images marked for the next boot, and whether permanently. */
    val pending = HashMap<Int, Boolean>()
    val confirms = ArrayList<Pair<Int, Boolean>>()
    /** The image of the upload in progress, and what each image's last whole upload was. */
    var uploadImage = -1
    val uploads = HashMap<Int, ByteArray>()
    var uploaded = ByteArray(0)
    var uploadOffset = 0
    var uploadRefusal = 0
    /** After the upload the list shows this instead of the image's hash. */
    var corruptAfterUpload = false
    var confirmRefusal = 0
    /** Only this image's confirm is refused; -1: any. */
    var confirmRefusalImage = -1
    /** This image's confirm is answered, and the list doesn't show it pending. */
    var unmarkedImage = -1

    /** No `ASSET_INFO`, as before 0.5.56. */
    var storeSupported = true
    var storeAvailable = true
    var storeAssets = 0
    var storeSeq = 0L
    var storeState = 0
    var storeError = 0
    /** Bytes that aren't 0xFF in the store's directory sectors: Even's data, until a format. */
    var directoryNonErased = 4096L
    /** The format's NOTICE 8 never comes. */
    var loseStoreNotice = false
    /** The arm restarts during the wipe: no notice, and the job state back to idle. */
    var wipeInterrupted = false
    val formats = ArrayList<Boolean>()
    var dropAtOffset = -1
    var silentRequests = 0
    /** The chunk at this offset gets no answer, once. */
    var silentAtOffset = -1
    var onChunk: (() -> Unit)? = null
    var connects = 0
    /** The OS remembers a table without g1v0's services, as after an install at the same address. */
    var staleTable = false
    var refreshes = 0
    /** Android says bonded and the arm has lost its half. */
    var staleBond = false
    var removedBonds = 0
    var inCase = false
    /** Even's firmware's answer to its battery query; null: it says nothing. */
    var stockBatteryReply: ByteArray? = null

    val wantHash = G1Smp.imageHash(image)

    override fun setListener(listener: StockLinkListener?) { inbound = listener }
    override fun connect(address: String, timeoutMs: Int): Boolean {
        connects++
        connected = true
        return true
    }
    override fun prepareLink(address: String, desiredMtu: Int, timeoutMs: Int) {}
    override fun discoverServices(address: String, timeoutMs: Int): Boolean = connected
    /** As FaceclawBleManager: a characteristic the table lacks throws, a refused one (no encryption) returns false. */
    override fun enableNotifications(address: String, characteristicUuid: String, timeoutMs: Int): Boolean {
        if (!connected) throw IllegalStateException("Not connected")
        if (!hasCharacteristic(address, characteristicUuid)) throw IllegalStateException("Characteristic not found: $characteristicUuid")
        if (stock && staleBond && characteristicUuid == G1Smp.NUS_TX_UUID) return false
        subscribed.add(characteristicUuid)
        return true
    }
    override fun hasCharacteristic(address: String, characteristicUuid: String): Boolean = when (characteristicUuid) {
        G1Ble.EVT_CHAR_UUID -> !stock && !staleTable
        G1Smp.NUS_TX_UUID -> stock
        else -> true
    }
    override fun refreshServices(address: String, timeoutMs: Int): Boolean {
        refreshes++
        staleTable = false
        return connected
    }
    override fun removeBond(address: String): Boolean {
        removedBonds++
        bond = BondState.NONE
        staleBond = false
        connected = false
        return true
    }
    override fun isConnected(address: String): Boolean = connected
    override fun bondState(address: String): BondState = bond
    override fun requestBond(address: String) {
        bondRequests++
        bond = bondResult
    }
    override fun negotiatedMtu(address: String): Int = 100
    override fun disconnect(address: String) { connected = false }
    override fun close() { connected = false }

    fun drop() {
        connected = false
        inbound?.onConnectionStateChange(ARM, false)
    }

    override fun writeFrames(address: String, characteristicUuid: String, frames: List<ByteArray>, mode: GattWriteMode, timeoutMs: Int): Boolean {
        if (!connected) throw IllegalStateException("Not connected")
        when (characteristicUuid) {
            G1Smp.NUS_RX_UUID -> {
                val frame = frames.single()
                if (frame[0].toInt() == 0x2c) {
                    stockBatteryReply?.let { inbound?.onNotification(ARM, G1Smp.NUS_TX_UUID, it) }
                } else {
                    heartbeats.add(frame)
                }
            }
            G1Ble.PAIR_CHAR_UUID -> return bond == BondState.BONDED && !staleBond
            G1Ble.CTRL_CHAR_UUID -> control(frames.single())
            G1Smp.SMP_CHAR_UUID -> {
                for (frame in frames) assertTrue(frame.size <= 97, "a write longer than the MTU allows")
                smp(frames.reduce { a, b -> a + b })
            }
            else -> throw IllegalStateException("write to $characteristicUuid")
        }
        return true
    }

    private fun control(request: ByteArray) {
        val op = request[0].toInt() and 0xff
        val tag = request[1]
        val args = request.copyOfRange(2, request.size)
        var status = 0
        var after: (() -> Unit)? = null
        val body = when (op) {
            G1Protocol.OP_HELLO -> {
                val parts = runningVersion.split(".").map { it.toInt().toByte() }
                val flags = (if (safeMode) 1 else 0) or 2 or (if (staleBond) 0 else 64) or (if (inCase) 128 else 0)
                byteArrayOf(5, parts[0], parts[1], parts[2], 1, flags.toByte(), 0)
            }
            G1Protocol.OP_PROPS -> byteArrayOf(battery.toByte(), 0, 0, 0)
            G1Protocol.OP_ASSET_INFO -> {
                if (!storeSupported) {
                    status = 2
                    ByteArray(0)
                } else {
                    ByteArray(12) + byteArrayOf(storeAssets.toByte(), storeState.toByte(), storeError.toByte(), if (storeAvailable) 1 else 0) +
                        le32(storeSeq.toInt())
                }
            }
            G1Protocol.OP_FLASH_CRC -> {
                calls.add("crc")
                assertContentEquals(G1Protocol.flashCrcRequest(G1Protocol.STORE_ADDRESS, G1Protocol.STORE_DIRECTORY_BYTES), args)
                if (safeMode) {
                    status = 7
                } else {
                    after = { storeNotice(G1Protocol.STORE_JOB_CRC, 0, args + le32(0x1234) + le32(directoryNonErased.toInt())) }
                }
                ByteArray(0)
            }
            G1Protocol.OP_ASSET_FORMAT -> {
                calls.add("format")
                assertContentEquals(G1Protocol.assetFormatRequest(wipe = true), args)
                when {
                    safeMode -> status = 7
                    storeState in 1..3 -> status = 13
                    else -> {
                        formats.add(true)
                        storeAssets = 0
                        storeSeq = 0
                        directoryNonErased = 0
                        if (wipeInterrupted) {
                            storeState = 0
                        } else {
                            storeState = 4
                            storeError = 0
                            if (!loseStoreNotice) after = { storeNotice(G1Protocol.STORE_JOB_FORMAT, 0, ByteArray(16)) }
                        }
                    }
                }
                ByteArray(0)
            }
            else -> ByteArray(0)
        }
        val event = ByteArray(9) + byteArrayOf(tag, status.toByte()) + body
        event[0] = (0x80 or op).toByte()
        inbound?.onNotification(ARM, G1Ble.EVT_CHAR_UUID, event)
        after?.invoke()
    }

    private fun storeNotice(job: Int, result: Int, detail: ByteArray) {
        val event = ByteArray(9) + byteArrayOf(G1Protocol.NOTICE_STORE_JOB.toByte(), job.toByte(), result.toByte()) + detail
        event[0] = G1Protocol.EV_NOTICE.toByte()
        inbound?.onNotification(ARM, G1Ble.EVT_CHAR_UUID, event)
    }

    private fun le32(value: Int): ByteArray = byteArrayOf(value.toByte(), (value ushr 8).toByte(), (value ushr 16).toByte(), (value ushr 24).toByte())

    private fun imageOf(index: Int): ByteArray = when (index) {
        0 -> image
        1 -> netImage ?: throw AssertionError("an upload to image 1")
        else -> throw AssertionError("an upload to image $index")
    }

    private fun smp(frame: ByteArray) {
        val op = frame[0].toInt()
        val group = frame[5].toInt()
        val seq = frame[6].toInt() and 0xff
        val cmd = frame[7].toInt()
        val body = G1Cbor.decode(frame, 8) as Map<*, *>
        if (silentRequests > 0) {
            silentRequests--
            return
        }
        when {
            group == 1 && cmd == 1 -> {
                calls.add("upload")
                val off = (body["off"] as Long).toInt()
                onChunk?.invoke()
                if (off == silentAtOffset) {
                    silentAtOffset = -1
                    return
                }
                if (uploadRefusal != 0) return reply(op, group, seq, cmd, mapOf("rc" to uploadRefusal))
                if (off == 0) {
                    // A first chunk names the image; the same file again resumes where it stopped, as MCUmgr does.
                    val index = (body["image"] as Long).toInt()
                    val expected = imageOf(index)
                    assertEquals(expected.size.toLong(), body["len"])
                    assertContentEquals(sha256(expected), body["sha"] as ByteArray)
                    if (index != uploadImage || uploadOffset >= expected.size) {
                        uploadImage = index
                        uploadOffset = 0
                        uploaded = ByteArray(0)
                    }
                }
                if (off == uploadOffset) {
                    val data = body["data"] as ByteArray
                    uploaded += data
                    uploadOffset += data.size
                    if (uploadOffset == imageOf(uploadImage).size) {
                        uploads[uploadImage] = uploaded
                        slotHashes[uploadImage] = if (corruptAfterUpload) ByteArray(32) else G1Smp.imageHash(uploaded)
                    }
                }
                if (uploadOffset >= dropAtOffset && dropAtOffset >= 0) {
                    dropAtOffset = -1
                    drop()
                    return
                }
                reply(op, group, seq, cmd, mapOf("rc" to 0, "off" to uploadOffset))
            }
            group == 1 && cmd == 0 && op == G1Smp.OP_READ -> {
                calls.add("list")
                val images = ArrayList<Map<String, Any?>>()
                images.add(mapOf("image" to 0, "slot" to 0, "version" to runningVersion, "hash" to ByteArray(32), "active" to true, "confirmed" to true, "bootable" to true))
                for ((index, hash) in slotHashes.toSortedMap()) {
                    val marked = pending[index]
                    val entry = mutableMapOf<String, Any?>("image" to index, "slot" to 1, "version" to "0.5.64", "hash" to hash, "bootable" to true)
                    if (marked != null && index != unmarkedImage) {
                        entry["pending"] = true
                        if (marked) entry["permanent"] = true
                    }
                    images.add(entry)
                }
                reply(op, group, seq, cmd, mapOf("images" to images))
            }
            group == 1 && cmd == 0 -> {
                calls.add("confirm")
                val hash = body["hash"] as ByteArray
                val index = slotHashes.entries.firstOrNull { it.value.contentEquals(hash) }?.key
                assertNotNull(index, "a confirm for a hash no slot holds")
                if (index == 0 && netImage == null) {
                    assertEquals(true, body["confirm"])
                    assertContentEquals(wantHash, hash)
                }
                val permanent = body["confirm"] as Boolean
                confirms.add(index to permanent)
                val refused = if (confirmRefusalImage < 0 || confirmRefusalImage == index) confirmRefusal else 0
                if (refused == 0) pending[index] = permanent
                reply(op, group, seq, cmd, mapOf("rc" to refused))
            }
            group == 0 && cmd == 5 -> {
                calls.add("reset")
                reply(op, group, seq, cmd, emptyMap())
                drop()
            }
            else -> throw IllegalStateException("SMP $group/$cmd")
        }
    }

    /** The reply comes in pieces, as notifications do. */
    private fun reply(op: Int, group: Int, seq: Int, cmd: Int, body: Map<String, Any?>) {
        val frame = G1Smp.frame(op or 1, group, seq, cmd, body)
        for (piece in G1Smp.split(frame, 23)) inbound?.onNotification(ARM, G1Smp.SMP_CHAR_UUID, piece)
    }
}

private class Recorder : FaceclawFirmwareFlasherListener {
    val states = ArrayList<String>()
    val logs = ArrayList<String>()
    var progress = 0L
    var total = 0L
    var success: Boolean? = null
    var detail = ""

    override fun onLog(line: String?) { logs.add(line ?: "") }
    override fun onProgress(lens: String?, componentIndex: Int, componentCount: Int, blockIndex: Int, blockCount: Int, bytesSent: Long, bytesTotal: Long) {
        progress = bytesSent
        total = bytesTotal
    }
    override fun onState(state: String?, detail: String?) { states.add(state ?: "") }
    override fun onComplete(success: Boolean, detail: String?) {
        this.success = success
        this.detail = detail ?: ""
    }
}

private val FAST = G1FlashTimings(
    connectTimeoutMs = 50, servicesTimeoutMs = 50, descriptorTimeoutMs = 50, writeTimeoutMs = 50, pairingMs = 200, retryDelayMs = 1,
    controlReplyMs = 20, controlTries = 2, uploadReplyMs = 150, smpReplyMs = 150, resetReplyMs = 50, heartbeatMs = 30, pollMs = 5, uploadRetries = 5,
    storePollMs = 10, wipeMs = 2_000, crcMs = 200,
)

class G1SmpStockTest {
    @Test
    fun stocksBatteryReplyIsReadOnlyWhenItIsOne() {
        // What the real firmware answered in emulation (g1-fw BLE_COMMAND_SET_REPORT), first bytes.
        assertEquals(100, G1Smp.parseStockBattery(byteArrayOf(0x2c, 0x66, 0x64, 0x64, 0xf9.toByte(), 0x80.toByte())))
        assertEquals(null, G1Smp.parseStockBattery(byteArrayOf(0x2c, 0x66, 0)))
        assertEquals(null, G1Smp.parseStockBattery(byteArrayOf(0x2c, 0x66, 101)))
        assertEquals(null, G1Smp.parseStockBattery(byteArrayOf(0x2c, 0xc9.toByte(), 50)))
        assertEquals(null, G1Smp.parseStockBattery(byteArrayOf(0x25, 0x66, 50)))
        assertEquals(null, G1Smp.parseStockBattery(byteArrayOf(0x2c, 0x66)))
    }
}

class G1SmpTest {
    private val sha = ByteArray(32) { it.toByte() }

    /** The expected bytes come from scouter_kit's tools/g1host.py, whose requests were proven on real arms. */
    @Test
    fun requestsMatchTheProvenPythonTool() {
        val image = ByteArray(574408)
        image[0] = 1
        image[1] = 2
        image[2] = 3
        val first = G1Smp.uploadRequest(image, 0, sha).toMutableMap()
        first["data"] = byteArrayOf(1, 2, 3)
        assertEquals(
            "0200004e00010001a665696d61676500636c656e1a0008c3c8636f666600637368615820000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f6464617461430102036775706772616465f4",
            BinaryEncoding.bytesToHex(G1Smp.frame(G1Smp.OP_WRITE, G1Smp.GROUP_IMAGE, 0, G1Smp.CMD_IMAGE_UPLOAD, first)),
        )
        assertEquals(
            "0200001100010101a2636f6666190800646461746143010203",
            BinaryEncoding.bytesToHex(G1Smp.frame(G1Smp.OP_WRITE, G1Smp.GROUP_IMAGE, 1, G1Smp.CMD_IMAGE_UPLOAD, mapOf("off" to 2048, "data" to byteArrayOf(1, 2, 3)))),
        )
        assertEquals(
            "0200003100010500a264686173685820000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f67636f6e6669726df5",
            BinaryEncoding.bytesToHex(G1Smp.frame(G1Smp.OP_WRITE, G1Smp.GROUP_IMAGE, 5, G1Smp.CMD_IMAGE_STATE, G1Smp.confirmRequest(sha))),
        )
        assertEquals("0000000100010700a0", BinaryEncoding.bytesToHex(G1Smp.frame(G1Smp.OP_READ, G1Smp.GROUP_IMAGE, 7, G1Smp.CMD_IMAGE_STATE, emptyMap())))
        assertEquals("020000010000ff05a0", BinaryEncoding.bytesToHex(G1Smp.frame(G1Smp.OP_WRITE, G1Smp.GROUP_OS, 255, G1Smp.CMD_OS_RESET, emptyMap())))
    }

    @Test
    fun cborMatchesPythonAndRoundTrips() {
        val value = mapOf("n" to -5, "big" to 70000, "huge" to 5000000000L, "t" to true, "s" to "ab")
        val encoded = G1Cbor.encode(value)
        assertEquals("a5616e24636269671a0001117064687567651b000000012a05f2006174f56173626162", BinaryEncoding.bytesToHex(encoded))
        val decoded = G1Cbor.decode(encoded) as Map<*, *>
        assertEquals(-5L, decoded["n"])
        assertEquals(70000L, decoded["big"])
        assertEquals(5000000000L, decoded["huge"])
        assertEquals(true, decoded["t"])
        assertEquals("ab", decoded["s"])
    }

    @Test
    fun cborReadsTheIndefiniteLengthsOfAnImageList() {
        // {"images": [{"slot": 1, "active": true}]}, each container of indefinite length.
        val data = hex("bf66696d616765739fbf64736c6f74016661637469766" + "5f5ffffff")
        val slots = (G1Cbor.decode(data) as Map<*, *>)["images"] as List<*>
        val slot = slots.single() as Map<*, *>
        assertEquals(1L, slot["slot"])
        assertEquals(true, slot["active"])
    }

    @Test
    fun malformedCborIsAnErrorNotAWrongValue() {
        assertFailsWith<IllegalArgumentException> { G1Cbor.decode(hex("5820")) }
        assertFailsWith<IllegalArgumentException> { G1Cbor.decode(hex("bf")) }
        assertFailsWith<IllegalArgumentException> { G1Cbor.decode(ByteArray(0)) }
    }

    @Test
    fun repliesAreJoinedAcrossNotifications() {
        val assembler = G1Smp.Assembler()
        val one = G1Smp.frame(3, 1, 7, 1, mapOf("off" to 2048, "rc" to 0))
        val two = G1Smp.frame(3, 1, 8, 0, emptyMap())
        val all = one + two
        val replies = ArrayList<Pair<Int, Map<*, *>>>()
        for (start in all.indices step 5) replies += assembler.feed(all.copyOfRange(start, minOf(start + 5, all.size)))
        assertEquals(listOf(7, 8), replies.map { it.first })
        assertEquals(2048, G1Smp.replyOffset(replies[0].second))
        assertEquals(0, G1Smp.replyCode(replies[1].second))
    }

    @Test
    fun anImageSaysWhatItIs() {
        val image = testImage(Triple(0, 5, 300))
        assertEquals("0.5.300", G1Smp.imageVersion(image))
        assertContentEquals(ByteArray(32) { (it * 3 + 300).toByte() }, G1Smp.imageHash(image))
        assertFailsWith<IllegalArgumentException> { G1Smp.imageVersion(ByteArray(100)) }
        val cut = image.copyOf(image.size - 20)
        assertFailsWith<IllegalArgumentException> { G1Smp.imageHash(cut) }
    }

    @Test
    fun writesFitTheMtu() {
        val pieces = G1Smp.split(ByteArray(1000), 247)
        assertTrue(pieces.all { it.size <= 244 })
        assertEquals(1000, pieces.sumOf { it.size })
    }
}

class G1ArmFlashFlowTest {
    private val image = testImage()

    private fun flow(arm: FakeArm, listener: Recorder, mode: G1ArmFlashFlow.Mode, window: Int = 100) =
        G1ArmFlashFlow(arm, ARM, "left", "image.bin", "", mode, window, listener, FAST, testPlatform(), { image })

    private fun run(arm: FakeArm, mode: G1ArmFlashFlow.Mode, window: Int = 100): Recorder {
        val listener = Recorder()
        flow(arm, listener, mode, window).run()
        assertNotNull(listener.success, "the flow must always finish")
        return listener
    }

    private fun confirmIsLast(arm: FakeArm) {
        assertEquals(listOf("confirm", "reset"), arm.calls.takeLast(2))
        assertEquals(1, arm.calls.count { it == "confirm" })
    }

    @Test
    fun anUpdateUploadsChecksThenConfirmsAndResets() {
        val arm = FakeArm(image)
        val result = run(arm, G1ArmFlashFlow.Mode.UPDATE)
        assertEquals(true, result.success, result.detail)
        assertEquals("""{"flashed":true,"version":"0.5.64"}""", result.detail)
        assertContentEquals(image, arm.uploaded)
        assertEquals(image.size.toLong(), result.progress)
        assertEquals(image.size.toLong(), result.total)
        confirmIsLast(arm)
        // The list before the confirm is what proves the slot holds this image.
        assertEquals("list", arm.calls[arm.calls.indexOf("confirm") - 1])
        assertTrue(arm.heartbeats.isEmpty(), "g1v0 has no heartbeat")
        assertTrue("rebooting" in result.states)
    }

    @Test
    fun anArmAlreadyOnThisVersionIsLeftAlone() {
        val arm = FakeArm(image)
        arm.runningVersion = "0.5.64"
        val result = run(arm, G1ArmFlashFlow.Mode.UPDATE)
        assertEquals(true, result.success)
        assertEquals("""{"flashed":false,"version":"0.5.64"}""", result.detail)
        assertTrue(arm.calls.isEmpty(), "nothing goes to the update service")
    }

    @Test
    fun anArmInSafeModeOnThisVersionIsInstalledAgain() {
        val arm = FakeArm(image)
        arm.runningVersion = "0.5.64"
        arm.safeMode = true
        val result = run(arm, G1ArmFlashFlow.Mode.UPDATE)
        assertEquals("""{"flashed":true,"version":"0.5.64"}""", result.detail)
        confirmIsLast(arm)
    }

    @Test
    fun aSlotThatDoesNotHoldTheImageIsNeverConfirmed() {
        val arm = FakeArm(image)
        arm.corruptAfterUpload = true
        val result = run(arm, G1ArmFlashFlow.Mode.UPDATE)
        assertEquals(false, result.success)
        assertFalse("confirm" in arm.calls)
        assertFalse("reset" in arm.calls)
        assertTrue("Nothing was installed" in result.detail, result.detail)
    }

    @Test
    fun aRefusedUploadIsNeverConfirmed() {
        val arm = FakeArm(image)
        arm.uploadRefusal = 9
        val result = run(arm, G1ArmFlashFlow.Mode.UPDATE)
        assertEquals(false, result.success)
        assertFalse("confirm" in arm.calls)
        assertTrue("error 9" in result.detail, result.detail)
    }

    @Test
    fun aRefusedConfirmIsNotAReset() {
        val arm = FakeArm(image)
        arm.confirmRefusal = 2
        val result = run(arm, G1ArmFlashFlow.Mode.UPDATE)
        assertEquals(false, result.success)
        assertFalse("reset" in arm.calls)
    }

    @Test
    fun aLowBatteryStopsAnUpdateBeforeAnyUpload() {
        val arm = FakeArm(image)
        arm.battery = 12
        val result = run(arm, G1ArmFlashFlow.Mode.UPDATE)
        assertEquals(false, result.success)
        assertTrue("12%" in result.detail, result.detail)
        assertTrue(arm.calls.isEmpty())
    }

    @Test
    fun aDamagedImageFailsBeforeTheLinkIsTouched() {
        val listener = Recorder()
        val arm = FakeArm(image)
        G1ArmFlashFlow(arm, ARM, "left", "image.bin", "", G1ArmFlashFlow.Mode.UPDATE, 100, listener, FAST, testPlatform(), { ByteArray(100) }).run()
        assertEquals(false, listener.success)
        assertEquals(0, arm.connects)
    }

    @Test
    fun anUnreadableImageIsAClearFailure() {
        val listener = Recorder()
        val arm = FakeArm(image)
        G1ArmFlashFlow(arm, ARM, "left", "image.bin", "", G1ArmFlashFlow.Mode.STOCK, 100, listener, FAST, testPlatform(), { throw IllegalStateException("gone") }).run()
        assertEquals(false, listener.success)
        assertTrue("could not read the firmware" in listener.detail, listener.detail)
    }

    @Test
    fun aLostLinkResumesTheUpload() {
        val arm = FakeArm(image)
        arm.dropAtOffset = 2048
        val result = run(arm, G1ArmFlashFlow.Mode.UPDATE)
        assertEquals(true, result.success, result.detail)
        assertContentEquals(image, arm.uploaded)
        assertTrue(arm.connects >= 2, "it connected again")
        confirmIsLast(arm)
    }

    @Test
    fun aChunkThatGetsNoAnswerIsSentAgain() {
        val arm = FakeArm(image)
        arm.silentAtOffset = 2048
        val result = run(arm, G1ArmFlashFlow.Mode.UPDATE)
        assertEquals(true, result.success, result.detail)
        assertContentEquals(image, arm.uploaded)
        confirmIsLast(arm)
    }

    @Test
    fun anUploadThatNeverGetsAnswersGivesUpWithoutConfirming() {
        val arm = FakeArm(image)
        arm.silentRequests = 1000
        val result = run(arm, G1ArmFlashFlow.Mode.UPDATE)
        assertEquals(false, result.success)
        assertFalse("confirm" in arm.calls)
    }

    @Test
    fun aSlotAlreadyHoldingTheImageSkipsTheUpload() {
        val arm = FakeArm(image)
        arm.slot1Hash = arm.wantHash
        val result = run(arm, G1ArmFlashFlow.Mode.UPDATE)
        assertEquals(true, result.success, result.detail)
        assertFalse("upload" in arm.calls)
        confirmIsLast(arm)
    }

    @Test
    fun stockGetsAHeartbeatEvenWhileAChunkWaits() {
        val arm = FakeArm(image, stock = true)
        // A chunk can wait a long time, as the first does while the arm erases its slot: the heartbeat has to keep going.
        arm.silentAtOffset = 2048
        val result = run(arm, G1ArmFlashFlow.Mode.STOCK)
        assertEquals(true, result.success, result.detail)
        assertTrue(arm.heartbeats.size >= 3, "heartbeats: ${arm.heartbeats.size}")
        assertTrue(G1Smp.NUS_TX_UUID in arm.subscribed)
        assertEquals(0x25, arm.heartbeats[0][0].toInt())
        assertEquals(arm.heartbeats[1][3], 1.toByte())
        assertEquals(arm.heartbeats[1][5], 1.toByte())
        confirmIsLast(arm)
    }

    @Test
    fun stockIsPairedWithFirst() {
        val arm = FakeArm(image, stock = true)
        arm.bond = BondState.NONE
        val result = run(arm, G1ArmFlashFlow.Mode.STOCK)
        assertEquals(true, result.success, result.detail)
        assertEquals(1, arm.bondRequests)
        assertTrue("pairing" in result.states)
    }

    @Test
    fun aRefusedBondIsRetriedThenReported() {
        val arm = FakeArm(image)
        arm.bond = BondState.NONE
        arm.bondResult = BondState.NONE
        val result = run(arm, G1ArmFlashFlow.Mode.UPDATE, window = 1)
        assertEquals(false, result.success)
        assertTrue(arm.calls.isEmpty())
        assertTrue("Couldn't reach the left arm" in result.detail, result.detail)
    }

    @Test
    fun aPlatformThatCannotSeeBondsReliesOnTheEncryptedWrite() {
        val arm = FakeArm(image)
        arm.bond = BondState.UNKNOWN
        val listener = Recorder()
        // The write to PAIR fails on an unknown bond in this fake, as on an arm out of the case: no encrypted link.
        flow(arm, listener, G1ArmFlashFlow.Mode.PROBE, 1).run()
        assertEquals(false, listener.success)
        assertEquals(0, arm.bondRequests)
        assertTrue("an arm pairs only in its case" in listener.detail, listener.detail)
    }

    @Test
    fun aStaleBondInTheCaseIsRemovedAndMadeAgain() {
        val arm = FakeArm(image)
        arm.staleBond = true
        arm.inCase = true
        val result = run(arm, G1ArmFlashFlow.Mode.UPDATE)
        assertEquals(true, result.success, result.detail)
        assertEquals(1, arm.removedBonds)
        assertEquals(1, arm.bondRequests)
        confirmIsLast(arm)
    }

    @Test
    fun aBondIsNeverGivenUpOutOfTheCase() {
        val arm = FakeArm(image)
        arm.staleBond = true
        arm.inCase = false
        val result = run(arm, G1ArmFlashFlow.Mode.UPDATE, window = 1)
        assertEquals(false, result.success)
        assertEquals(0, arm.removedBonds, "no new bond can be made out of the case")
    }

    @Test
    fun aStaleBondOnStockIsRemovedAndMadeAgain() {
        val arm = FakeArm(image, stock = true)
        arm.staleBond = true
        val result = run(arm, G1ArmFlashFlow.Mode.STOCK)
        assertEquals(true, result.success, result.detail)
        assertEquals(1, arm.removedBonds)
        assertEquals(1, arm.bondRequests)
    }

    @Test
    fun anOldServiceTableIsReadAgainBeforeItIsBelieved() {
        val arm = FakeArm(image)
        arm.staleTable = true
        val result = run(arm, G1ArmFlashFlow.Mode.PROBE)
        assertEquals(true, result.success, result.detail)
        assertEquals(1, arm.refreshes)
        assertTrue("\"firmware\":\"g1v0\"" in result.detail, result.detail)
    }

    @Test
    fun aLowBatteryOnStockStopsBeforeAnyUpload() {
        val arm = FakeArm(image, stock = true)
        arm.stockBatteryReply = byteArrayOf(0x2c, 0x66, 12, 12)
        val result = run(arm, G1ArmFlashFlow.Mode.STOCK)
        assertEquals(false, result.success)
        assertTrue("12%" in result.detail, result.detail)
        assertFalse("upload" in arm.calls)
    }

    @Test
    fun aChargedArmOnStockGoesOn() {
        val arm = FakeArm(image, stock = true)
        arm.stockBatteryReply = byteArrayOf(0x2c, 0x66, 100, 100)
        val result = run(arm, G1ArmFlashFlow.Mode.STOCK)
        assertEquals(true, result.success, result.detail)
        assertTrue(result.logs.any { "battery 100%" in it }, result.logs.toString())
    }

    @Test
    fun aStockArmThatSaysNothingAboutItsBatteryGoesOn() {
        val arm = FakeArm(image, stock = true)
        val result = run(arm, G1ArmFlashFlow.Mode.STOCK)
        assertEquals(true, result.success, result.detail)
        assertTrue(result.logs.any { "battery unknown" in it }, result.logs.toString())
    }

    @Test
    fun aProbeSaysWhatAnArmRuns() {
        val arm = FakeArm(image)
        val result = run(arm, G1ArmFlashFlow.Mode.PROBE)
        assertEquals(true, result.success, result.detail)
        assertEquals("""{"firmware":"g1v0","version":"0.5.63","safeMode":false,"inCase":false,"battery":80}""", result.detail)
        assertTrue(arm.calls.isEmpty())
    }

    @Test
    fun aProbeOfEvensFirmwareNeedsNoPairing() {
        val arm = FakeArm(image, stock = true)
        arm.bond = BondState.NONE
        val result = run(arm, G1ArmFlashFlow.Mode.PROBE)
        assertEquals("""{"firmware":"stock"}""", result.detail)
        assertEquals(0, arm.bondRequests)
    }

    // ---- back to Even's firmware ----

    private val evenApp = testImage(Triple(0, 0, 0), payloadSize = 7000)
    private val evenNet = testImage(Triple(0, 0, 1), payloadSize = 3000)

    private fun restoreArm(): FakeArm = FakeArm(evenApp, netImage = evenNet).also { it.runningVersion = "0.5.66" }

    private fun restore(arm: FakeArm, window: Int = 100): Recorder {
        val listener = Recorder()
        G1ArmFlashFlow(arm, ARM, "right", "app.bin", "net.bin", G1ArmFlashFlow.Mode.RESTORE, window, listener, FAST, testPlatform(), { path ->
            when (path) {
                "app.bin" -> evenApp
                "net.bin" -> evenNet
                else -> throw IllegalStateException("no $path")
            }
        }).run()
        assertNotNull(listener.success, "the flow must always finish")
        return listener
    }

    @Test
    fun aRestoreUploadsBothImagesThenMarksTheNetworkCoreFirst() {
        val arm = restoreArm()
        val result = restore(arm)
        assertEquals(true, result.success, result.detail)
        assertEquals("""{"flashed":true,"firmware":"stock","wiped":false}""", result.detail)
        assertContentEquals(evenNet, arm.uploads[1])
        assertContentEquals(evenApp, arm.uploads[0])
        // Image 1 as a test install, as Even's app and g1v0's fallback do; the application for good.
        assertEquals(listOf(1 to false, 0 to true), arm.confirms)
        assertEquals(listOf("confirm", "confirm", "list", "reset"), arm.calls.takeLast(4))
        assertEquals((evenApp.size + evenNet.size).toLong(), result.total)
        assertEquals(result.total, result.progress)
        assertTrue("rebooting" in result.states)
    }

    @Test
    fun aStoreNeverWrittenKeepsEvensData() {
        val arm = restoreArm()
        val result = restore(arm)
        assertEquals(true, result.success, result.detail)
        assertEquals(listOf("crc"), arm.calls.filter { it == "crc" || it == "format" })
        assertTrue(arm.formats.isEmpty())
        assertFalse("wiping" in result.states)
    }

    @Test
    fun aStoreThatHoldsAssetsIsWipedBeforeAnyUpload() {
        val arm = restoreArm()
        arm.storeAssets = 2
        arm.storeSeq = 5
        val result = restore(arm)
        assertEquals(true, result.success, result.detail)
        assertEquals("""{"flashed":true,"firmware":"stock","wiped":true}""", result.detail)
        assertEquals(listOf(true), arm.formats)
        assertTrue(arm.calls.indexOf("format") < arm.calls.indexOf("upload"))
        assertFalse("crc" in arm.calls, "a store with assets needs no fingerprint")
        assertTrue("wiping" in result.states)
    }

    @Test
    fun anEmptyStoreWhoseDirectoryWasErasedIsWiped() {
        // A format resets the commit count, and erased the two directory sectors over Even's data.
        val arm = restoreArm()
        arm.directoryNonErased = 0
        val result = restore(arm)
        assertEquals(true, result.success, result.detail)
        assertEquals(listOf("crc", "format"), arm.calls.filter { it == "crc" || it == "format" })
    }

    @Test
    fun firmwareWithoutTheStoreIsNotWiped() {
        val arm = restoreArm()
        arm.storeSupported = false
        val result = restore(arm)
        assertEquals(true, result.success, result.detail)
        assertFalse("crc" in arm.calls)
        assertFalse("format" in arm.calls)
    }

    @Test
    fun aLostWipeNoticeIsReadFromTheStoreState() {
        val arm = restoreArm()
        arm.storeAssets = 1
        arm.storeSeq = 1
        arm.loseStoreNotice = true
        val result = restore(arm)
        assertEquals(true, result.success, result.detail)
        assertTrue("\"wiped\":true" in result.detail, result.detail)
    }

    @Test
    fun anArmThatRestartsDuringTheWipeGetsNothingInstalled() {
        val arm = restoreArm()
        arm.storeAssets = 1
        arm.storeSeq = 1
        arm.wipeInterrupted = true
        val result = restore(arm)
        assertEquals(false, result.success)
        assertTrue("restarted while erasing" in result.detail, result.detail)
        assertFalse("upload" in arm.calls)
        assertFalse("confirm" in arm.calls)
    }

    @Test
    fun safeModeWithAWrittenStoreInstallsNothing() {
        val arm = restoreArm()
        arm.safeMode = true
        arm.storeAssets = 1
        arm.storeSeq = 1
        val result = restore(arm)
        assertEquals(false, result.success)
        assertTrue("safe mode" in result.detail, result.detail)
        assertFalse("format" in arm.calls)
        assertFalse("upload" in arm.calls)
    }

    @Test
    fun aLowBatteryStopsARestoreBeforeTheWipe() {
        val arm = restoreArm()
        arm.battery = 12
        arm.storeAssets = 1
        arm.storeSeq = 1
        val result = restore(arm)
        assertEquals(false, result.success)
        assertTrue("12%" in result.detail, result.detail)
        assertFalse("format" in arm.calls)
        assertFalse("upload" in arm.calls)
    }

    @Test
    fun aRefusedNetworkCoreNeverLeavesTheApplicationMarked() {
        val arm = restoreArm()
        arm.confirmRefusal = 3
        arm.confirmRefusalImage = 1
        val result = restore(arm)
        assertEquals(false, result.success)
        assertEquals(listOf(1 to false), arm.confirms)
        assertFalse(0 in arm.pending)
        assertFalse("reset" in arm.calls)
        assertTrue("network core" in result.detail, result.detail)
    }

    @Test
    fun anImageTheArmDidNotMarkIsNoReset() {
        val arm = restoreArm()
        arm.unmarkedImage = 0
        val result = restore(arm)
        assertEquals(false, result.success)
        assertFalse("reset" in arm.calls)
        assertTrue("didn't mark" in result.detail, result.detail)
    }

    @Test
    fun aLostLinkResumesARestoreUpload() {
        val arm = restoreArm()
        arm.dropAtOffset = 2048
        val result = restore(arm)
        assertEquals(true, result.success, result.detail)
        assertContentEquals(evenNet, arm.uploads[1])
        assertContentEquals(evenApp, arm.uploads[0])
    }

    @Test
    fun cancellingDuringTheUploadStopsBeforeTheConfirm() {
        val arm = FakeArm(image)
        val listener = Recorder()
        val flow = flow(arm, listener, G1ArmFlashFlow.Mode.UPDATE)
        arm.onChunk = { flow.cancel() }
        flow.run()
        assertEquals(false, listener.success)
        assertEquals("Cancelled.", listener.detail)
        assertFalse("confirm" in arm.calls)
    }
}

class G1StoreProtocolTest {
    /** The bytes of scouter_kit's tools/g1host.py: `struct.pack("<II", FORMAT_MAGIC, WIPE_MAGIC)`. */
    @Test
    fun requestsMatchThePythonTool() {
        assertEquals("53414b5300005750", BinaryEncoding.bytesToHex(G1Protocol.assetFormatRequest(wipe = true)))
        assertEquals("53414b53", BinaryEncoding.bytesToHex(G1Protocol.assetFormatRequest(wipe = false)))
        assertEquals("0000140000200000", BinaryEncoding.bytesToHex(G1Protocol.flashCrcRequest(0x140000, 8192)))
    }

    @Test
    fun assetInfoIsRead() {
        // data 10, free 20, largest 30, 2 assets, state 4, error 0, flags 1, seq 0x01020304
        val info = G1Protocol.parseAssetInfo(hex("0a000000140000001e00000002040001" + "04030201"))
        assertNotNull(info)
        assertEquals(2, info.assets)
        assertEquals(4, info.state)
        assertTrue(info.available)
        assertFalse(info.running)
        assertEquals(0x01020304L, info.seq)
        assertEquals(null, G1Protocol.parseAssetInfo(ByteArray(19)))
    }

    @Test
    fun aStoreJobsNoticeIsRead() {
        val crc = hex("05" + "0000000000000000" + "08" + "0400" + "00001400" + "00200000" + "78563412" + "00100000")
        val notice = G1Protocol.parseStoreNotice(crc)
        assertNotNull(notice)
        assertEquals(G1Protocol.STORE_JOB_CRC, notice.job)
        assertEquals(0, notice.result)
        assertEquals(0x140000, notice.address)
        assertEquals(8192, notice.n)
        assertEquals(4096L, notice.nonErased)
        // Another notice kind, or a short one, is none.
        assertEquals(null, G1Protocol.parseStoreNotice(hex("05" + "0000000000000000" + "07" + "2a2a")))
        assertEquals(null, G1Protocol.parseStoreNotice(hex("05" + "0000000000000000" + "08" + "0300")))
    }
}
