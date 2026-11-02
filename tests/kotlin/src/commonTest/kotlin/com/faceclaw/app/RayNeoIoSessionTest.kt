package com.faceclaw.app

import kotlin.concurrent.Volatile
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private const val IO = "00:6A:5E:5F:33:C2"
private const val RING = "FF:AA:F1:F6:7E:28"
private val PHONE_ID = byteArrayOf(1, 2, 3, 4, 5, 6)

private class IoClock(private val base: ProtocolPlatform) : ProtocolPlatform by base {
    @Volatile var offsetMs = 0L

    override fun elapsedRealtimeMs(): Long = base.elapsedRealtimeMs() + offsetMs
}

private fun awaitTrue(timeoutMs: Long, condition: () -> Boolean): Boolean {
    val platform = testPlatform()
    val deadline = platform.elapsedRealtimeMs() + timeoutMs
    while (platform.elapsedRealtimeMs() < deadline) {
        if (condition()) return true
        sleepMs(10)
    }
    return condition()
}

/**
 * A RayNeo iO running faceclaw-rayneo-cfw, as the phone sees it over GATT: answers the
 * handshake, guest auth, launcher status, OS version, QUERY and page controls, reassembles
 * and inflates CFW records, and ACKs each lens of every record whose CRC checks out.
 */
private class FakeIoGlasses(platform: ProtocolPlatform) : SessionLink {
    lateinit var core: GlassesSessionCore
    private val lock = platform.createLock()
    val glassesId = byteArrayOf(0x00, 0x6a, 0x5e, 0x5f, 0x33, 0xc2.toByte())
    /** The phone id the glasses accept; null = pairing mode (they bind to the next one). */
    @Volatile var boundTo: ByteArray? = null
    @Volatile var faceclaw = true
    @Volatile var pageOpen = false
    @Volatile var hangUps = 0
    private val controlsList = ArrayList<Int>()
    private val messagesList = ArrayList<ByteArray>()
    private val launcherList = ArrayList<String>()
    val launcher: List<String> get() = lock.withLock { launcherList.toList() }
    private val records = ArrayList<ByteArray>()
    private var current = ByteArray(0)
    private val inbound = RayNeoIoProtocol.FrameReassembler()
    private var number = 1

    val controls: List<Int> get() = lock.withLock { controlsList.toList() }
    val messages: List<ByteArray> get() = lock.withLock { messagesList.toList() }
    /** Writes to the R1 on [RING] (characteristic, bytes), and the CCCDs the session enabled on it. */
    private val ringWritesList = ArrayList<Pair<String, ByteArray>>()
    private val ringCccdsList = ArrayList<String>()
    val ringWrites: List<Pair<String, ByteArray>> get() = lock.withLock { ringWritesList.toList() }
    val ringCccds: List<String> get() = lock.withLock { ringCccdsList.toList() }

    /** A notification from the R1, as its link delivers it. */
    fun ringNotify(characteristicUuid: String, data: ByteArray) = core.onNotification(RING, characteristicUuid, data)

    fun notify(business: Int, payload: ByteArray) {
        val frame = lock.withLock { RayNeoIoProtocol.encodeFrame(number++, business, payload) }
        core.onNotification(IO, RayNeoIoBle.NOTIFY_CHAR_UUID, frame)
    }

    fun page(state: Int, reason: Int) = notify(0xf0, byteArrayOf(0x13, state.toByte(), reason.toByte()))

    override fun connect(address: String, timeoutMs: Int): Boolean = true

    override fun isConnected(address: String): Boolean = true

    override fun requestHighPriority(address: String) {}

    override fun requestMtu(address: String, mtu: Int, timeoutMs: Int): Boolean = true

    override fun negotiatedMtu(address: String): Int = 185

    override fun discoverServices(address: String, timeoutMs: Int): Boolean = true

    override fun enableNotifications(address: String, characteristicUuid: String, enable: Boolean, timeoutMs: Int): Boolean {
        if (address == RING) {
            lock.withLock { ringCccdsList.add(characteristicUuid) }
            return true
        }
        return characteristicUuid == RayNeoIoBle.NOTIFY_CHAR_UUID
    }

    override fun writeFrames(address: String, characteristicUuid: String, frames: List<ByteArray>, mode: GattWriteMode, timeoutMs: Int): Boolean {
        if (address == RING) {
            lock.withLock { for (frame in frames) ringWritesList.add(characteristicUuid to frame) }
            return true
        }
        assertEquals(RayNeoIoBle.WRITE_CHAR_UUID, characteristicUuid)
        assertTrue(frames.all { it.size <= 185 - 3 }, "writes must fit the MTU")
        val decoded = lock.withLock { frames.flatMap { inbound.ingest(it) } }
        for (frame in decoded) handle(frame)
        return true
    }

    private fun handle(frame: RayNeoIoProtocol.Frame) {
        val p = frame.payload
        when (frame.business) {
            0x10 -> {
                val tlvs = RayNeoIoProtocol.decodeTlvs(p)!!
                val version = tlvs.firstOrNull { it.tag == 0x11 }
                val auth = tlvs.firstOrNull { it.tag == 0x18 }
                if (version != null) {
                    val phone = RayNeoIoProtocol.decodeTlvs(version.value)!!.first { it.tag == 0x11 }.value
                    val bound = boundTo
                    if (bound != null && !bound.contentEquals(phone)) {
                        hangUps++
                        core.onConnectionStateChange(IO, false)
                        return
                    }
                    notify(0x10, RayNeoIoProtocol.tlv(0x11, RayNeoIoProtocol.tlv(0x10, byteArrayOf(2)) +
                        RayNeoIoProtocol.tlv(0x11, glassesId) + RayNeoIoProtocol.tlv(0x14, "006A5E5F33C2229".encodeToByteArray())))
                } else if (auth != null) {
                    val fields = RayNeoIoProtocol.decodeTlvs(auth.value)!!
                    val phoneRandom = fields.first { it.tag == 0x10 }.value
                    val phone = PHONE_ID
                    assertTrue(RayNeoIoProtocol.authProof(phoneRandom, phone, glassesId).contentEquals(fields.first { it.tag == 0x11 }.value))
                    boundTo = phone
                    val random = byteArrayOf(9, 8, 7, 6)
                    notify(0x10, RayNeoIoProtocol.tlv(0x19, RayNeoIoProtocol.tlv(0x10, random) +
                        RayNeoIoProtocol.tlv(0x11, RayNeoIoProtocol.authProof(random, phone, glassesId))))
                }
            }
            15 -> {
                lock.withLock { launcherList.add(RayNeoIoProtocol.decodeEnvelope(p)!!.json) }
                notify(15, RayNeoIoProtocol.encodeEnvelope(RayNeoIoProtocol.Envelope(1,
                """{"generalStatus":{"battery":77,"isCharging":false}}""", sequence = RayNeoIoProtocol.decodeEnvelope(p)!!.sequence, mode = 2)))
            }
            9 -> notify(9, RayNeoIoProtocol.encodeEnvelope(RayNeoIoProtocol.Envelope(1, """{"OsVersion":"Strix OS 1.0.4.12"}""")))
            0xf0 -> cfw(p)
        }
    }

    private fun cfw(p: ByteArray) {
        val opt = p[0].toInt() and 255
        val stream = p[1].toInt() and 255
        if (opt and RayNeoIoProtocol.OPT_CONTROL != 0) {
            val ctrl = p[2].toInt() and 255
            lock.withLock { controlsList.add(ctrl) }
            when (ctrl) {
                RayNeoIoProtocol.CTRL_QUERY -> if (faceclaw) notify(0xf0, ident())
                RayNeoIoProtocol.CTRL_PAGE_OPEN, RayNeoIoProtocol.CTRL_KEEPALIVE -> { pageOpen = true; page(1, 0) }
                RayNeoIoProtocol.CTRL_PAGE_CLOSE -> { pageOpen = false; page(0, 0) }
            }
            return
        }
        val complete = lock.withLock {
            if (opt and RayNeoIoProtocol.OPT_RESET != 0) current = ByteArray(0)
            current += p.copyOfRange(2, p.size)
            val len = if (current.size >= 5) (current[1].toInt() and 255) or ((current[2].toInt() and 255) shl 8) else -1
            if (len >= 0 && current.size == 5 + len) current.also { records.add(it); current = ByteArray(0) } else null
        } ?: return
        val message = lock.withLock { inflateRecords(records).last() }
        val crc = (complete[3].toInt() and 255) or ((complete[4].toInt() and 255) shl 8)
        val ok = pageOpen && CfwTransport.crc(message) == crc && ioSupportsCfwType(message[0].toInt() and 255)
        if (ok) lock.withLock { messagesList.add(message) }
        for (lens in 1..2) {
            notify(0xf0, byteArrayOf(if (ok) 1 else 3, stream.toByte(), 0, 0, lens.toByte(),
                message.size.toByte(), (message.size ushr 8).toByte(), crc.toByte(), (crc ushr 8).toByte()))
        }
    }

    private fun ident(): ByteArray {
        val name = "GLASSLYCFW-IO/13".encodeToByteArray()
        return byteArrayOf(0x11, 13, 0x1c, 0x02, 0xdc.toByte(), 0x00, 0xf0.toByte(), 0x00, 0x00, 0x01, 0x0d, 0x00, 0xff.toByte()) +
            name + byteArrayOf(0, 25) + "Faceclaw/38".encodeToByteArray() + byteArrayOf(0)
    }

    override fun disconnect(address: String) {}

    override fun close() {}

    override fun isBonded(address: String): Boolean = false

    override fun prepareBenchmarkLink(address: String, mode: Int) {}

    override fun recordDisplayFrameSent() {}
}

private class IoListener : FaceclawBleCommunicatorListener {
    val phases = ArrayList<String>()
    @Volatile var lastStatus = ""
    val events = ArrayList<String>()
    val batteries = ArrayList<String>()
    val ringBatteries = ArrayList<String>()
    val firmware = ArrayList<String>()

    override fun onStateChange(phase: String?, status: String?) {
        phases.add(phase ?: "")
        lastStatus = status ?: ""
    }

    override fun onRingEvent(kind: String?, containerName: String?, eventType: Int, eventSource: Int, systemExitReasonCode: Int, frameId: Int, ringTick: Long, ringType: Int, ringAux: Int, ringSpeed: Int) {
        events.add("$kind:$eventType:$eventSource")
    }

    override fun onBatteryState(headsetBattery: Int, headsetCharging: Int, ringBattery: Int, ringCharging: Int) {
        batteries.add("$headsetBattery/$headsetCharging")
        if (ringBattery >= 0) ringBatteries.add("$ringBattery/$ringCharging")
    }

    override fun onSilentMode(silent: Boolean) {}

    override fun onWearState(wearing: Boolean) {}

    override fun onPhoneLockState(locked: Boolean) {}

    override fun onEvenAppConflict(message: String?) {}

    override fun onFrameMetrics(paintMs: Int, transmitMs: Int, tileCount: Int) {}

    override fun onFrameFinished(frameId: Int, outcome: String?) {}

    override fun onFirmwareInfo(leftVersion: String?, rightVersion: String?, extension: String?) {
        firmware.add("$leftVersion|$extension")
    }
}

/** An iO session; with [ring], also the phone's own link to an R1 in the glasses role (Direct). */
private class IoSession(ring: String = "") {
    val platform = IoClock(testPlatform())
    val glasses = FakeIoGlasses(platform)
    private val host = object : SessionHost {
        private val lock = platform.createLock()
        private val lines = ArrayList<String>()
        private var done: Latch? = null

        fun logs(): List<String> = lock.withLock { lines.toList() }

        override fun postToMain(action: () -> Unit) = action()

        override fun currentThreadDispatcher(): SessionDispatcher = SessionDispatcher { it() }

        override fun isPhoneLocked(): Boolean = false

        override fun setScreenWakeLock(on: Boolean) {}

        override fun isEvenAppActive(): Boolean = false

        override fun startWorker(body: () -> Unit) {
            val latch = Latch(1, platform)
            done = latch
            startThread("io-test-session", true) {
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
    val listener = IoListener()
    val core = GlassesSessionCore(glasses, host, FrameTimingsCore(platform), platform, IO, IO, ring)

    init {
        glasses.core = core
        core.setListener(listener)
        core.setRequiredFirmwareRevision(38)
        core.useRayNeoIo(PHONE_ID, "Pixel", "Google", "Pixel 11")
        if (ring.isNotEmpty()) core.setDirectRingRole("glasses")
    }

    fun pageUp(): Boolean = core.monitor.withLock { core.sessionReady && core.fixedLayoutCreated }

    fun displayedMatchesDesired(): Boolean = core.monitor.withLock {
        core.desiredTilesLock.locked { core.desiredFingerprint.isNotEmpty() && core.desiredFingerprint == core.displayedFingerprint }
    }

    fun submitFrame(value: Byte, frameId: Int) {
        val pixels = ByteArray(64 * 32) { if (it % 7 == 0) value else 0 }
        core.submitSurfaceFrame(ArrayByteReader(pixels), "s", 0, 0, 64, 32, "content-$value", 0, frameId, null)
    }

    fun tail(): String = host.logs().takeLast(25).joinToString("\n")
}

class RayNeoIoSessionTest {
    @Test
    fun connectsAuthenticatesOpensThePageAndPresentsFrames() {
        val s = IoSession()
        s.core.configureBrightness(false, 70, 2, 100, "0:0,1000:100", 280)
        s.core.configureCompositorScreen(540, 220)
        s.core.configureSurface("s", 0, 0, 64, 32, 0, SurfaceCompositor.TRANSPARENCY_OPAQUE)
        try {
            assertTrue(s.core.start())
            assertTrue(awaitTrue(5_000) { s.pageUp() }, "page never opened:\n" + s.tail())
            assertTrue(s.core.isRayNeoIo())
            assertTrue(s.listener.firmware.contains("Strix OS 1.0.4.12|Faceclaw/38"), s.listener.firmware.toString())
            assertTrue(awaitTrue(2_000) { s.listener.batteries.contains("77/0") }, s.listener.batteries.toString())
            assertEquals(listOf(RayNeoIoProtocol.CTRL_QUERY, RayNeoIoProtocol.CTRL_PAGE_OPEN), s.glasses.controls.take(2))

            s.submitFrame(0x7f, 1)
            assertTrue(awaitTrue(5_000) { s.displayedMatchesDesired() }, "frame never displayed:\n" + s.tail())
            val types = s.glasses.messages.map { it[0].toInt() and 255 }
            assertTrue(types.contains(CFW_MSG_PRESENT), types.toString())
            // nothing G2-only (brightness 30, ENTER_EVENHUB 31, debug flags 7, ...) reaches the iO
            assertTrue(types.all { ioSupportsCfwType(it) }, types.toString())
            // a visible frame wakes the screen through the launcher's brightness (70% -> level 6)
            assertTrue(awaitTrue(3_000) { s.glasses.launcher.any { it.contains("brightness_change") && it.contains("\"value\":6") } },
                s.glasses.launcher.toString())

            // a second, different frame goes out as an update
            val before = s.glasses.messages.size
            s.submitFrame(0x30, 2)
            assertTrue(awaitTrue(5_000) { s.displayedMatchesDesired() && s.glasses.messages.size > before })
        } finally {
            s.core.close()
        }
        // disconnect closes the page so the glasses go back to their own UI at once
        assertEquals(RayNeoIoProtocol.CTRL_PAGE_CLOSE, s.glasses.controls.last())
    }

    @Test
    fun refusalAsksForPairingModeAndConnectsOnceItIsOn() {
        val s = IoSession()
        s.glasses.boundTo = byteArrayOf(9, 9, 9, 9, 9, 9)
        try {
            assertTrue(s.core.start())
            assertTrue(awaitTrue(5_000) { s.glasses.hangUps >= 1 && s.listener.lastStatus.contains("pairing mode") },
                "no pairing-mode prompt:\n" + s.tail())
            assertFalse(s.pageUp())
            s.glasses.boundTo = null // the wearer held the button
            s.platform.offsetMs += 5_000
            s.core.interruptibleSleep.interrupt()
            assertTrue(awaitTrue(5_000) { s.pageUp() }, "never connected after pairing mode:\n" + s.tail())
            assertTrue(s.glasses.boundTo!!.contentEquals(PHONE_ID))
        } finally {
            s.core.close()
        }
    }

    @Test
    fun stockFirmwareIsIncompatible() {
        val s = IoSession()
        s.glasses.faceclaw = false
        try {
            assertTrue(s.core.start())
            assertTrue(awaitTrue(8_000) { s.listener.phases.contains("incompatible-firmware") }, "not halted:\n" + s.tail())
            assertTrue(s.listener.firmware.contains("Strix OS 1.0.4.12|"))
            assertFalse(s.glasses.controls.contains(RayNeoIoProtocol.CTRL_PAGE_OPEN))
        } finally {
            s.core.close()
        }
    }

    @Test
    fun gesturesPageLossAndKeepalive() {
        val s = IoSession()
        s.core.configureCompositorScreen(540, 220)
        try {
            assertTrue(s.core.start())
            assertTrue(awaitTrue(5_000) { s.pageUp() }, s.tail())
            // taps/crown arrive as G2 sys-events from the right temple; head up wakes; head down is dropped
            s.glasses.notify(0xf0, byteArrayOf(7, 3, 1, 0, 0, 0, 0))
            s.glasses.notify(0xf0, byteArrayOf(7, 1, 0, 0, 0, 0, 0))
            s.glasses.notify(0xf0, byteArrayOf(7, 12, 2, 0, 0, 0, 0))
            s.glasses.notify(0xf0, byteArrayOf(7, 15, 2, 0, 0, 0, 0))
            assertEquals(listOf("sys-event:3:1", "sys-event:1:1", "display-wake:12:1"), s.listener.events)

            // the lease ran out on the glasses: the session reopens the page
            s.glasses.pageOpen = false
            s.glasses.page(0, 3)
            assertFalse(s.pageUp())
            s.platform.offsetMs += 4_000
            s.core.interruptibleSleep.interrupt()
            assertTrue(awaitTrue(5_000) { s.pageUp() }, "page not reopened:\n" + s.tail())

            // keepalives well inside the 120 s lease
            val keepalives = s.glasses.controls.count { it == RayNeoIoProtocol.CTRL_KEEPALIVE }
            s.platform.offsetMs += 31_000
            s.core.interruptibleSleep.interrupt()
            assertTrue(awaitTrue(5_000) { s.glasses.controls.count { it == RayNeoIoProtocol.CTRL_KEEPALIVE } > keepalives })

            // the wearer closed it: stay closed until they touch the glasses again
            s.glasses.pageOpen = false
            s.glasses.page(0, 4)
            s.platform.offsetMs += 4_000
            s.core.interruptibleSleep.interrupt()
            sleepMs(300)
            assertFalse(s.pageUp())
            s.glasses.notify(0xf0, byteArrayOf(7, 0, 1, 0, 0, 0, 0))
            s.core.interruptibleSleep.interrupt()
            assertTrue(awaitTrue(5_000) { s.pageUp() }, "touch did not reopen:\n" + s.tail())
        } finally {
            s.core.close()
        }
    }

    @Test
    fun anR1BesideTheIoIsTheSessionsOwnRingInput() {
        val s = IoSession(RING)
        s.core.configureCompositorScreen(540, 220)
        try {
            assertTrue(s.core.start())
            assertTrue(awaitTrue(5_000) { s.pageUp() }, s.tail())
            // The phone takes the ring's glasses role itself: legacy CCCD, the glasses
            // pair-auth, then the touch source on, all on the ring's link.
            assertTrue(awaitTrue(5_000) { s.glasses.ringWrites.size >= 2 }, "ring setup not sent:\n" + s.tail())
            assertTrue(BleProtocol.R1_LEGACY_NOTIFY_CHAR_UUID in s.glasses.ringCccds)
            val (authChar, auth) = s.glasses.ringWrites[0]
            assertEquals(BleProtocol.R1_LEGACY_WRITE_CHAR_UUID, authChar)
            assertTrue(auth.contentEquals(RingProtocol.LEGACY_GLASSES_PAIR_AUTH))

            // Its battery and gestures reach the listener as they do beside a G2,
            // not the iO's protocol parser.
            s.glasses.ringNotify(BleProtocol.R1_LEGACY_NOTIFY_CHAR_UUID, byteArrayOf(0x00, 0x09, 0x8b.toByte(), 0x00, 64, 1))
            assertTrue(awaitTrue(2_000) { "64/1" in s.listener.ringBatteries }, s.listener.ringBatteries.toString())
            val swipe = byteArrayOf(0x00, 0x09, 0x61, 0x00, 0x04, 0x35, 0x00, 0x09, 0xcc.toByte(), 0x00, 0x00)
            s.glasses.ringNotify(BleProtocol.R1_LEGACY_NOTIFY_CHAR_UUID, swipe)
            assertTrue(awaitTrue(2_000) { s.listener.events.isNotEmpty() }, s.tail())
            val expected = FaceclawRingEventDecoder.decode(swipe)!!.event
            assertEquals("${expected.kind}:${expected.eventType}:${expected.eventSource}", s.listener.events.single())

            // The wearer closed the page: a ring gesture takes it back, as a temple touch does.
            s.glasses.pageOpen = false
            s.glasses.page(0, 4)
            s.platform.offsetMs += 4_000
            s.core.interruptibleSleep.interrupt()
            sleepMs(300)
            assertFalse(s.pageUp())
            s.glasses.ringNotify(BleProtocol.R1_LEGACY_NOTIFY_CHAR_UUID, byteArrayOf(0x00, 0x09, 0x61, 0x00, 0x01, 0x00, 0x00, 0x10, 0xcc.toByte(), 0x00, 0x00))
            s.core.interruptibleSleep.interrupt()
            assertTrue(awaitTrue(5_000) { s.pageUp() }, "ring input did not reopen:\n" + s.tail())
        } finally {
            s.core.close()
        }
    }
}
