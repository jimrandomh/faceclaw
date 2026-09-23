package com.faceclaw.app

import kotlin.concurrent.Volatile
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

private const val RIGHT = "AA:00:00:00:00:01"
private const val LEFT = "AA:00:00:00:00:02"

/** The test platform with a clock the tests can jump forward (the real waits keep real time). */
private class ClockPlatform(private val base: ProtocolPlatform) : ProtocolPlatform by base {
    @Volatile var offsetMs = 0L

    override fun elapsedRealtimeMs(): Long = base.elapsedRealtimeMs() + offsetMs
}

private fun waitUntil(timeoutMs: Long, condition: () -> Boolean): Boolean {
    val platform = testPlatform()
    val deadline = platform.elapsedRealtimeMs() + timeoutMs
    while (platform.elapsedRealtimeMs() < deadline) {
        if (condition()) return true
        sleepMs(10)
    }
    return condition()
}

private fun ByteArray.containsSequence(needle: ByteArray): Boolean {
    if (needle.isEmpty() || size < needle.size) return false
    outer@ for (start in 0..size - needle.size) {
        for (i in needle.indices) if (this[start + i] != needle[i]) continue@outer
        return true
    }
    return false
}

/** One logical write as the fake link saw it: the frames, the decoded pb, and the in-flight message (if any). */
private class Write(
    val address: String,
    val sid: Int,
    val frames: List<ByteArray>,
    val pb: ByteArray,
    val kind: String?,
    val label: String?,
    val magic: Int,
    val message: ByteArray?,
)

/**
 * A GATT link that records every write and, unless a kind is muted, answers it the way the
 * firmware would: EvenHub/settings/auth requests get a matching ack frame, CFW stream
 * messages get one ACK per lens.
 */
private class FakeLink(private val platform: ProtocolPlatform) : SessionLink {
    lateinit var core: GlassesSessionCore
    private val lock = platform.createLock()
    private val writesList = ArrayList<Write>()
    val muted = HashSet<String>()
    val connected = HashSet<String>()
    val disconnected = ArrayList<String>()
    @Volatile var closed = false
    var seq = 0

    val writes: List<Write>
        get() = lock.withLock { writesList.toList() }

    /** Decoded CFW image messages (the drive loop's debug-flags control rides the same stream and is excluded). */
    fun cfwMessages(): List<ByteArray> = writes.filter { it.sid == CfwTransport.SID && it.kind == "image" }.mapNotNull { it.message }

    override fun connect(address: String, timeoutMs: Int): Boolean {
        connected.add(address)
        return true
    }

    override fun requestHighPriority(address: String) {}

    override fun requestMtu(address: String, mtu: Int, timeoutMs: Int): Boolean = true

    override fun negotiatedMtu(address: String): Int = 247

    override fun discoverServices(address: String, timeoutMs: Int): Boolean = true

    override fun enableNotifications(address: String, characteristicUuid: String, enable: Boolean, timeoutMs: Int): Boolean = true

    override fun writeFrames(address: String, characteristicUuid: String, frames: List<ByteArray>, mode: GattWriteMode, timeoutMs: Int): Boolean {
        val sid = frames[0][6].toInt() and 255
        val magic = if (sid == CfwTransport.SID) frames[0][2].toInt() and 255 else BleProtocol.parseFrame(frames[0]).msgSeq
        // The in-flight entry gives the label/kind and the decoded CFW message.
        val inFlight = core.monitor.withLock { core.inFlightMessages.firstOrNull { it.sid == sid && it.magic == magic && magic != 0 } }
        val pb = if (sid == CfwTransport.SID) ByteArray(0) else {
            val joined = frames.flatMap { frame -> frame.slice(8 until 8 + (frame[3].toInt() and 255)) }.toByteArray()
            joined.copyOf(maxOf(0, joined.size - 2))
        }
        val write = Write(address, sid, frames, pb, inFlight?.kind, inFlight?.label, magic, inFlight?.message?.copyOf())
        lock.withLock { writesList.add(write) }
        if (inFlight != null && inFlight.kind !in muted) {
            if (sid == CfwTransport.SID) {
                for (lens in 1..2) core.onNotification(address, BleProtocol.NOTIFY_CHAR_UUID, cfwAck(magic, lens, inFlight.message.size, inFlight.cfwChecksum))
            } else {
                core.onNotification(address, BleProtocol.NOTIFY_CHAR_UUID, ackFrame(sid, magic, pb))
            }
        }
        return true
    }

    private fun ackFrame(sid: Int, magic: Int, request: ByteArray): ByteArray {
        val body = if (sid == BleProtocol.SID_SECURITY_AUTH)
            BleProtocol.encodeVarintField(1, 4) + BleProtocol.encodeVarintField(2, magic) + byteArrayOf(0x1a, 0x00)
        else
            BleProtocol.encodeVarintField(1, 1) + BleProtocol.encodeVarintField(2, magic)
        return BleProtocol.framePb(body, sid, 0x00, seq++)[0]
    }

    override fun disconnect(address: String) {
        disconnected.add(address)
        connected.remove(address)
    }

    override fun close() {
        closed = true
    }

    override fun isBonded(address: String): Boolean = true

    override fun prepareBenchmarkLink(address: String, mode: Int) {}

    override fun recordDisplayFrameSent() {}
}

private fun cfwAck(streamId: Int, lens: Int, size: Int, checksum: Int): ByteArray {
    val packet = ByteArray(19)
    packet[0] = 0xaa.toByte()
    packet[1] = 0x12
    packet[3] = 11
    packet[4] = 1
    packet[5] = 1
    packet[6] = CfwTransport.SID.toByte()
    packet[8] = 1
    packet[9] = streamId.toByte()
    packet[12] = lens.toByte()
    packet[13] = size.toByte()
    packet[14] = (size ushr 8).toByte()
    packet[15] = checksum.toByte()
    packet[16] = (checksum ushr 8).toByte()
    val crc = CfwTransport.crc(packet.copyOfRange(8, 17))
    packet[17] = crc.toByte()
    packet[18] = (crc ushr 8).toByte()
    return packet
}

private class FakeHost(private val platform: ProtocolPlatform) : SessionHost {
    private val lock = platform.createLock()
    private val lines = ArrayList<String>()
    private var done: Latch? = null
    var wakeLock = false

    fun logs(): List<String> = lock.withLock { lines.toList() }

    fun hasLog(fragment: String): Boolean = logs().any { it.contains(fragment) }

    override fun postToMain(action: () -> Unit) = action()

    override fun currentThreadDispatcher(): SessionDispatcher = SessionDispatcher { it() }

    override fun isPhoneLocked(): Boolean = false

    override fun setScreenWakeLock(on: Boolean) {
        wakeLock = on
    }

    override fun isEvenAppActive(): Boolean = false

    override fun startWorker(body: () -> Unit) {
        val latch = Latch(1, platform)
        done = latch
        startThread("test-session", true) {
            try {
                body()
            } finally {
                latch.countDown()
            }
        }
    }

    override fun joinWorker(timeoutMs: Long) {
        done?.await(timeoutMs)
    }

    override fun log(level: SessionLogLevel, tag: String, message: String, error: Throwable?) {
        lock.withLock { lines.add("$level $tag: $message") }
    }
}

private class FakeListener : FaceclawBleCommunicatorListener {
    val phases = ArrayList<String>()
    val events = ArrayList<String>()
    val finished = ArrayList<String>()
    val batteries = ArrayList<String>()

    override fun onStateChange(phase: String?, status: String?) {
        phases.add(phase ?: "")
    }

    override fun onRingEvent(kind: String?, containerName: String?, eventType: Int, eventSource: Int, systemExitReasonCode: Int, frameId: Int, ringTick: Long, ringType: Int, ringAux: Int, ringSpeed: Int) {
        events.add("$kind:$eventType")
    }

    override fun onBatteryState(headsetBattery: Int, headsetCharging: Int, ringBattery: Int, ringCharging: Int) {
        batteries.add("$headsetBattery/$headsetCharging/$ringBattery/$ringCharging")
    }

    override fun onSilentMode(silent: Boolean) {}

    override fun onWearState(wearing: Boolean) {}

    override fun onPhoneLockState(locked: Boolean) {}

    override fun onEvenAppConflict(message: String?) {}

    override fun onFrameMetrics(paintMs: Int, transmitMs: Int, tileCount: Int) {}

    override fun onFrameFinished(frameId: Int, outcome: String?) {
        finished.add("$frameId:$outcome")
    }

    override fun onFirmwareInfo(leftVersion: String?, rightVersion: String?, extension: String?) {}
}

private class Session {
    val platform = ClockPlatform(testPlatform())
    val link = FakeLink(platform)
    val host = FakeHost(platform)
    val listener = FakeListener()
    val frameTimings = FrameTimingsCore(platform)
    val core = GlassesSessionCore(link, host, frameTimings, platform, RIGHT, LEFT, "")

    init {
        link.core = core
        core.setListener(listener)
    }

    fun layoutCreated(): Boolean = core.monitor.withLock { core.fixedLayoutCreated }

    fun startAndAwaitLayout() {
        assertTrue(core.start())
        assertTrue(waitUntil(5_000) { layoutCreated() }, "layout never created; logs=${host.logs().takeLast(20)}")
    }

    /** A 64x32 surface frame with a marker byte at [marker]; returns the expected composite fingerprint. */
    fun submitFrame(marker: Int, value: Byte, frameId: Int): Unit {
        val pixels = ByteArray(64 * 32)
        pixels[marker] = value
        core.submitSurfaceFrame(ArrayByteReader(pixels), "s", 0, 0, 64, 32, "content-$marker-$value", 0, frameId, null)
    }

    fun displayedMatchesDesired(): Boolean = core.monitor.withLock {
        core.desiredTilesLock.locked { core.desiredFingerprint.isNotEmpty() && core.desiredFingerprint == core.displayedFingerprint }
    }
}

class GlassesSessionCoreTest {
    @Test
    fun connectsAuthenticatesPreludesAndCreatesTheLayout() {
        val s = Session()
        s.startAndAwaitLayout()
        val writes = s.link.writes
        assertEquals(setOf(RIGHT, LEFT), writes.filter { it.sid == BleProtocol.SID_SECURITY_AUTH }.map { it.address }.toSet())
        assertTrue(s.host.hasLog("security auth R=ok L=ok"), s.host.logs().toString())
        assertEquals(1, writes.count { it.kind == "prelude" })
        // The framebuffer lease is acquired on both arms (fire-and-forget settings writes, magic 0).
        val fbAcquire = byteArrayOf(70, 67, 1, BleProtocol.FACECLAW_FB_OP_ACQUIRE.toByte())
        assertEquals(setOf(RIGHT, LEFT), writes.filter { it.sid == BleProtocol.SID_UI_SETTING && it.pb.containsSequence(fbAcquire) }.map { it.address }.toSet())
        assertEquals(1, writes.count { it.kind == "battery" }, "settings query for firmware info")
        assertEquals(1, writes.count { it.kind == "create-layout" })
        assertTrue(s.core.isSessionReady())
        assertEquals(listOf("disconnected", "connecting", "connected"), s.listener.phases.distinct())
        s.core.disconnect()
        assertFalse(s.core.isSessionReady())
        assertEquals("disconnected", s.listener.phases.last())
        assertTrue(s.listener.phases.contains("disconnecting"))
        assertTrue(s.link.closed)
        assertEquals(listOf(RIGHT, LEFT), s.link.disconnected.takeLast(2))
        assertFalse(s.host.wakeLock)
        assertTrue(s.host.hasLog("communicator stop"))
    }

    @Test
    fun imagePipelineSendsAKeyframeThenABoundingBoxDelta() {
        val s = Session()
        s.startAndAwaitLayout()
        s.core.configureCompositorScreen(64, 32)
        s.core.configureSurface("s", 0, 0, 64, 32, 0, SurfaceCompositor.TRANSPARENCY_OPAQUE)
        s.submitFrame(100, 0x80.toByte(), 1)
        assertTrue(waitUntil(5_000) { s.link.cfwMessages().size >= 1 && s.displayedMatchesDesired() }, s.host.logs().takeLast(20).toString())
        assertTrue(s.listener.finished.contains("1:sent"), s.listener.finished.toString())
        s.submitFrame(101, 0x80.toByte(), 2)
        assertTrue(waitUntil(5_000) { s.link.cfwMessages().size >= 2 && s.displayedMatchesDesired() }, s.host.logs().takeLast(20).toString())
        val messages = s.link.cfwMessages()
        assertEquals(CFW_MSG_FULL_FRAME, messages[0][0].toInt() and CFW_MSG_TYPE_MASK, "first frame is a keyframe")
        assertEquals(CFW_MSG_BOUNDING_BOX, messages[1][0].toInt() and CFW_MSG_TYPE_MASK, "second frame is a delta")
        assertTrue(s.listener.finished.contains("2:sent"))
        // Identical content again: nothing is sent and the frame is finished as a no-change.
        s.submitFrame(101, 0x80.toByte(), 3)
        assertTrue(waitUntil(2_000) { s.listener.finished.any { it.startsWith("3:") } })
        assertTrue(s.listener.finished.any { it == "3:discarded: no change from displayed image" }, s.listener.finished.toString())
        assertEquals(2, s.link.cfwMessages().size)
        s.core.disconnect()
    }

    @Test
    fun heartbeatAndLeaseRenewalFollowTheClock() {
        val s = Session()
        s.startAndAwaitLayout()
        // The first heartbeat follows the layout at once (nothing has been acked yet); the
        // next one waits for HEARTBEAT_READY_MS since that ack.
        assertTrue(waitUntil(3_000) { s.link.writes.count { it.kind == "heartbeat" } == 1 }, s.host.logs().takeLast(10).toString())
        assertTrue(s.host.hasLog("Got ACK for heartbeat"))
        sleepMs(300)
        assertEquals(1, s.link.writes.count { it.kind == "heartbeat" })
        s.platform.offsetMs += ConnectionOptions.HEARTBEAT_READY_MS + 100L
        s.core.interruptibleSleep.interrupt()
        assertTrue(waitUntil(3_000) { s.link.writes.count { it.kind == "heartbeat" } == 2 }, s.host.logs().takeLast(10).toString())
        val leaseWritesBefore = s.link.writes.count { it.sid == BleProtocol.SID_UI_SETTING && it.pb.containsSequence(byteArrayOf(70, 67, 1, BleProtocol.FACECLAW_FB_OP_ACQUIRE.toByte())) }
        s.platform.offsetMs += GlassesSessionCore.FACECLAW_WAKE_LEASE_RENEW_MS + 100L
        s.core.interruptibleSleep.interrupt()
        assertTrue(waitUntil(3_000) {
            s.link.writes.count { it.sid == BleProtocol.SID_UI_SETTING && it.pb.containsSequence(byteArrayOf(70, 67, 1, BleProtocol.FACECLAW_FB_OP_ACQUIRE.toByte())) } == leaseWritesBefore + 2
        }, "framebuffer lease renewed on both arms")
        s.core.disconnect()
    }

    @Test
    fun deferredWakeIsClaimedAndReadyIsSentAfterResume() {
        val s = Session()
        s.startAndAwaitLayout()
        s.core.configureCompositorScreen(64, 32)
        s.core.configureSurface("s", 0, 0, 64, 32, 0, SurfaceCompositor.TRANSPARENCY_OPAQUE)
        s.submitFrame(7, 0x40, 1)
        assertTrue(waitUntil(5_000) { s.displayedMatchesDesired() })

        assertTrue(s.core.suspendEvenHubSession())
        assertTrue(s.core.monitor.withLock { s.core.shutdownRequested })
        assertEquals(1, s.link.writes.count { it.kind == "shutdown" })

        // CFW deferred double-tap wake on the right arm: field 102 [F,C,ver,event=1,nonce LE16].
        val nonce = 0x1234
        val event = byteArrayOf(70, 67, 1, 1, (nonce and 0xff).toByte(), (nonce ushr 8).toByte())
        val pb = BleProtocol.encodeVarintField(1, 1) + BleProtocol.encodeVarintField(2, 0) + BleProtocol.encodeBytesField(BleProtocol.FACECLAW_WAKE_EVENT_FIELD, event)
        s.core.onNotification(RIGHT, BleProtocol.NOTIFY_CHAR_UUID, BleProtocol.framePb(pb, BleProtocol.SID_UI_SETTING, BleProtocol.FLAG_NOTIFY, 9)[0])
        assertTrue(s.listener.events.contains("display-wake:${BleProtocol.EVENT_DOUBLE_CLICK}"), s.listener.events.toString())
        val claim = byteArrayOf(70, 67, 1, BleProtocol.FACECLAW_WAKE_OP_CLAIM.toByte(), (nonce and 0xff).toByte(), (nonce ushr 8).toByte())
        assertTrue(waitUntil(3_000) { s.link.writes.count { it.pb.containsSequence(claim) } == 2 }, "CLAIM written to both arms")
        assertEquals(RIGHT, s.link.writes.first { it.pb.containsSequence(claim) }.address, "right arm first")

        assertTrue(s.core.resumeEvenHubSession())
        assertEquals(2, s.link.writes.count { it.kind == "prelude" })
        assertTrue(waitUntil(5_000) { s.layoutCreated() && s.displayedMatchesDesired() }, s.host.logs().takeLast(20).toString())
        assertTrue(s.core.awaitEvenHubSessionReady(5_000))
        val ready = byteArrayOf(70, 67, 1, BleProtocol.FACECLAW_WAKE_OP_READY.toByte(), (nonce and 0xff).toByte(), (nonce ushr 8).toByte())
        assertEquals(2, s.link.writes.count { it.pb.containsSequence(ready) }, "READY written to both arms")
        s.core.disconnect()
    }

    @Test
    fun unexpectedAndDuplicateAcksAreLoggedNotApplied() {
        val s = Session()
        s.startAndAwaitLayout()
        val unknown = BleProtocol.framePb(BleProtocol.encodeVarintField(1, 1) + BleProtocol.encodeVarintField(2, 150), BleProtocol.SID_EVENHUB, 0, 5)[0]
        s.core.onNotification(RIGHT, BleProtocol.NOTIFY_CHAR_UUID, unknown)
        assertTrue(s.host.hasLog("unexpected ACK sid=${BleProtocol.SID_EVENHUB} magic=150"), s.host.logs().takeLast(5).toString())
        val layout = s.link.writes.first { it.kind == "create-layout" }
        val duplicate = BleProtocol.framePb(BleProtocol.encodeVarintField(1, 1) + BleProtocol.encodeVarintField(2, layout.magic), layout.sid, 0, 6)[0]
        s.core.onNotification(RIGHT, BleProtocol.NOTIFY_CHAR_UUID, duplicate)
        assertTrue(s.host.hasLog("duplicate ACK for already-acked message sid=${layout.sid} magic=${layout.magic}"), s.host.logs().takeLast(5).toString())
        assertTrue(s.layoutCreated())
        s.core.disconnect()
    }

    @Test
    fun ackTimeoutOnTheLayoutReconnects() {
        val s = Session()
        s.link.muted.add("create-layout")
        assertTrue(s.core.start())
        assertTrue(waitUntil(5_000) { s.link.writes.any { it.kind == "create-layout" } })
        assertFalse(s.layoutCreated())
        s.platform.offsetMs += ConnectionOptions.ACK_TIMEOUT_MS + ConnectionOptions.WRITE_TIMEOUT_MS + 1_000L
        s.core.interruptibleSleep.interrupt()
        assertTrue(waitUntil(3_000) { s.listener.phases.contains("retrying") }, s.host.logs().takeLast(10).toString())
        assertTrue(s.host.hasLog("message timed out: create-layout"))
        assertTrue(s.host.hasLog("Transport failure: ack timeout"))
        assertTrue(s.link.disconnected.containsAll(listOf(RIGHT, LEFT)))
        s.core.disconnect()
        assertEquals("disconnected", s.listener.phases.last())
    }

    @Test
    fun cfwNackTriggersReplayWithAFreshStreamId() {
        val s = Session()
        s.link.muted.add("image")
        s.startAndAwaitLayout()
        s.core.configureCompositorScreen(64, 32)
        s.core.configureSurface("s", 0, 0, 64, 32, 0, SurfaceCompositor.TRANSPARENCY_OPAQUE)
        s.submitFrame(3, 0x20, 1)
        assertTrue(waitUntil(5_000) { s.link.cfwMessages().size == 1 })
        val first = s.link.writes.first { it.sid == CfwTransport.SID && it.kind == "image" }
        val message = assertNotNull(s.core.monitor.withLock { s.core.inFlightMessages.firstOrNull { it.magic == first.magic } })
        // A NACK from lens 1 marks the message for replay; the window re-sends it under a new id.
        val nack = cfwAck(first.magic, 1, 0, 0).also { it[8] = 3; val crc = CfwTransport.crc(it.copyOfRange(8, 17)); it[17] = crc.toByte(); it[18] = (crc ushr 8).toByte() }
        s.core.onNotification(LEFT, BleProtocol.NOTIFY_CHAR_UUID, nack)
        assertTrue(waitUntil(3_000) { s.link.cfwMessages().size == 2 }, s.host.logs().takeLast(10).toString())
        assertTrue(s.host.hasLog("CFW replay id=${first.magic}"))
        val second = s.link.writes.filter { it.sid == CfwTransport.SID && it.kind == "image" }[1]
        assertTrue(second.magic != first.magic)
        assertEquals(1, message.cfwRetries)
        assertContentEquals(first.message, second.message)
        s.core.disconnect()
    }
}
