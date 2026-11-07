package com.faceclaw.app

import kotlin.concurrent.Volatile
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val LEFT = "F4:27:E9:CA:E8:3F"
private const val RIGHT = "CD:EB:89:BF:E9:EC"
private const val W = 640
private const val H = 480
private const val STRIDE = W / 2

private fun awaitTrue(timeoutMs: Long, condition: () -> Boolean): Boolean {
    val platform = testPlatform()
    val deadline = platform.elapsedRealtimeMs() + timeoutMs
    while (platform.elapsedRealtimeMs() < deadline) {
        if (condition()) return true
        sleepMs(10)
    }
    return condition()
}

private fun nibble(frame: ByteArray, x: Int, y: Int): Int {
    val v = frame[y * STRIDE + x / 2].toInt() and 255
    return if (x % 2 == 0) v ushr 4 else v and 15
}

private fun setNibble(frame: ByteArray, x: Int, y: Int, c: Int) {
    val i = y * STRIDE + x / 2
    val v = frame[i].toInt() and 255
    frame[i] = (if (x % 2 == 0) (v and 0x0f) or (c shl 4) else (v and 0xf0) or c).toByte()
}

/** What fc.c does with a draw message: bbox and clear calls into [frame]; returns the calls' rectangles. */
private fun applyDraw(frame: ByteArray, m: ByteArray): List<IntArray> {
    val rects = ArrayList<IntArray>()
    fun u16(p: Int) = (m[p].toInt() and 255) or ((m[p + 1].toInt() and 255) shl 8)
    val count = u16(1)
    var p = 3
    repeat(count) {
        val len = u16(p)
        p += 2
        val end = p + len
        assertEquals(0, m[p + 1].toInt(), "a G1 call carries no target, depth or clip")
        assertEquals(DRAW_OP_BOUNDING_BOX, m[p].toInt(), "only pixels on a G1")
        var q = p + 2
        val x: Int
        val y: Int
        val w: Int
        val h: Int
        if (m[q].toInt() == 0) {
            x = (m[q + 1].toInt() and 255) * 4
            y = (m[q + 2].toInt() and 255) * 2
            w = (m[q + 3].toInt() and 255) * 4
            h = (m[q + 4].toInt() and 255) * 2
            q += 5
        } else {
            x = u16(q + 1)
            y = u16(q + 3)
            w = u16(q + 5)
            h = u16(q + 7)
            q += 9
        }
        assertTrue(x + w <= W && y + h <= H, "rect $x,$y ${w}x$h")
        var left = w * h
        var cx = x
        var cy = y
        while (q < end) {
            val token = m[q++].toInt() and 255
            val color = token and 15
            var run = token ushr 4
            if (run == 0) {
                run = m[q++].toInt() and 255
                if (run == 0) {
                    run = u16(q)
                    q += 2
                }
            }
            left -= run
            assertTrue(left >= 0, "RLE overruns its rectangle")
            repeat(run) {
                setNibble(frame, cx, cy, color)
                cx++
                if (cx == x + w) {
                    cx = x
                    cy++
                }
            }
        }
        assertEquals(0, left, "RLE must cover the rectangle exactly")
        rects.add(intArrayOf(x, y, w, h))
        p = end
    }
    assertEquals(m.size, p)
    return rects
}

/** One arm on g1v0, as the phone sees it over GATT. */
private class FakeG1Arm(val left: Boolean) {
    val frame = ByteArray(STRIDE * H)
    /** What a look through the lens shows: the frame as of the last PRESENT while visible. */
    val panel = ByteArray(STRIDE * H)
    var visible = true
    var panelOn = false
    val records = ArrayList<ByteArray>()
    var current = ByteArray(0)
    val messageTypes = ArrayList<Int>()
    val rects = ArrayList<IntArray>()
    var nackNext = false
    var brightness = -1
    var wireBytes = 0
    var pairedWrites = 0
    var eventsMask = 0
    var healthOk = 0
    var bonded = false
    var inCase = 0
    var battery = 80
    val props = HashMap<Int, Int>()
    val propSets = ArrayList<Pair<Int, Int>>()
    val micRequests = ArrayList<Int>()
    var micStatus = 0
    var benchmarkMessages = 0
}

private class FakeG1Glasses(platform: ProtocolPlatform) : SessionLink {
    lateinit var core: GlassesSessionCore
    val lock = platform.createLock()
    val leftArm = FakeG1Arm(true)
    val rightArm = FakeG1Arm(false)
    @Volatile var hasDisplayPath = true
    /** HELLO's bit for the notification relay, the characteristic behind it, and what reaches it. */
    @Volatile var hasAncsRelay = false
    @Volatile var ancsCharacteristicMissing = false
    val ancsSubscribed = ArrayList<String>()
    val ancsWrites = ArrayList<Pair<String, ByteArray>>()
    /** Out of the case, or the OS said no: no bond can be made. */
    @Volatile var pairingRefused = false
    private val out = ArrayList<Pair<String, ByteArray>>()

    private fun arm(address: String) = if (address == LEFT) leftArm else rightArm

    /** Delivered off the writer's stack, as the BLE callback thread does: the session writes outside its monitor. */
    private fun event(address: String, type: Int, body: ByteArray) {
        val data = ByteArray(9) + body
        data[0] = type.toByte()
        core.onNotification(address, G1Ble.EVT_CHAR_UUID, data)
    }

    /** `MIC_DATA` from the right arm: [count] frames, each filled with its counter's low byte. */
    fun micData(first: Int, count: Int) {
        val body = ByteArray(3 + count * 40)
        body[0] = first.toByte()
        body[1] = (first ushr 8).toByte()
        body[2] = count.toByte()
        for (i in 0 until count) body.fill((first + i).toByte(), 3 + i * 40, 3 + (i + 1) * 40)
        event(RIGHT, G1Protocol.EV_MIC_DATA, body)
    }

    fun notice(address: String, kind: Int, vararg body: Byte) = event(address, G1Protocol.EV_NOTICE, byteArrayOf(kind.toByte()) + body)

    fun input(address: String, trigger: Int, value: Int) {
        val body = ByteArray(7)
        body[2] = trigger.toByte()
        for (i in 0..3) body[3 + i] = (value ushr (8 * i)).toByte()
        event(address, G1Protocol.EV_INPUT, body)
    }

    override fun connect(address: String, timeoutMs: Int): Boolean = true

    override fun isConnected(address: String): Boolean = true

    override fun requestHighPriority(address: String) {}

    override fun requestMtu(address: String, mtu: Int, timeoutMs: Int): Boolean = true

    override fun negotiatedMtu(address: String): Int = 185

    override fun discoverServices(address: String, timeoutMs: Int): Boolean = true

    override fun enableNotifications(address: String, characteristicUuid: String, enable: Boolean, timeoutMs: Int): Boolean {
        if (characteristicUuid == G1Ble.ANCS_CHAR_UUID && !ancsCharacteristicMissing) {
            lock.withLock { ancsSubscribed.add(address) }
            return true
        }
        return characteristicUuid == G1Ble.EVT_CHAR_UUID
    }

    override fun requestBond(address: String) {
        if (!pairingRefused) lock.withLock { arm(address).bonded = true }
    }

    override fun writeFrames(address: String, characteristicUuid: String, frames: List<ByteArray>, mode: GattWriteMode, timeoutMs: Int): Boolean {
        val a = arm(address)
        when (characteristicUuid) {
            G1Ble.PAIR_CHAR_UUID -> {
                assertEquals(GattWriteMode.WITH_RESPONSE, mode, "only a write with response can make the OS pair")
                if (pairingRefused) return false
                lock.withLock {
                    a.pairedWrites++
                    a.bonded = true
                }
            }
            G1Ble.CTRL_CHAR_UUID -> for (f in frames) control(address, a, f)
            G1Ble.FC_CHAR_UUID -> {
                assertEquals(GattWriteMode.WITHOUT_RESPONSE, mode)
                assertTrue(frames.all { it.size <= 182 }, "writes must fit the MTU")
                for (f in frames) packet(address, a, f)
            }
            G1Ble.ANCS_CHAR_UUID -> {
                assertEquals(GattWriteMode.WITH_RESPONSE, mode, "the arm's refusals come back as ATT errors")
                lock.withLock { for (f in frames) ancsWrites.add(address to f) }
            }
            else -> throw AssertionError("write to $characteristicUuid")
        }
        return true
    }

    private fun reply(address: String, op: Int, tag: Int, status: Int, body: ByteArray = ByteArray(0)) =
        event(address, 0x80 or op, byteArrayOf(tag.toByte(), status.toByte()) + body)

    private fun control(address: String, a: FakeG1Arm, f: ByteArray) {
        val op = f[0].toInt() and 255
        val tag = f[1].toInt() and 255
        when (op) {
            G1Protocol.OP_HELLO -> {
                val body = ByteArray(35)
                body[0] = 5
                body[1] = 0
                body[2] = 5
                body[3] = 63
                body[4] = (if (a.left) 1 else 0).toByte()
                body[5] = (2 or 64).toByte()
                body[6] = ((if (a.left) 0 else 4) or (if (hasAncsRelay) 8 else 0)).toByte()
                reply(address, op, tag, 0, body)
            }
            G1Protocol.OP_FC_INFO -> if (hasDisplayPath) {
                val body = ByteArray(26)
                body[0] = 1
                reply(address, op, tag, 0, body)
            } else reply(address, op, tag, 2)
            G1Protocol.OP_EVENTS -> {
                lock.withLock { a.eventsMask = (f[2].toInt() and 255) or ((f[3].toInt() and 255) shl 8) }
                reply(address, op, tag, 0, f.copyOfRange(2, 4))
            }
            G1Protocol.OP_HEALTH_OK -> {
                lock.withLock { a.healthOk++ }
                reply(address, op, tag, 0, ByteArray(1))
            }
            G1Protocol.OP_PROPS -> {
                val ids = f.drop(2).map { it.toInt() and 255 }
                val values = lock.withLock {
                    ids.map {
                        when (it) {
                            G1Protocol.PROP_BATT_PCT -> a.battery
                            G1Protocol.PROP_CHARGE -> 0
                            G1Protocol.PROP_IN_CASE -> a.inCase
                            G1Protocol.PROP_WORN -> 1
                            else -> a.props[it] ?: G1Protocol.UNKNOWN
                        }
                    }
                }
                val body = ByteArray(4 * values.size)
                for (i in values.indices) for (b in 0..3) body[4 * i + b] = (values[i] ushr (8 * b)).toByte()
                reply(address, op, tag, 0, body)
            }
            G1Protocol.OP_PROP_SET -> {
                val id = f[2].toInt() and 255
                val value = (f[3].toInt() and 255) or ((f[4].toInt() and 255) shl 8)
                lock.withLock {
                    a.propSets.add(id to value)
                    a.props[id] = value
                }
                reply(address, op, tag, 0)
            }
            G1Protocol.OP_MIC -> {
                lock.withLock { a.micRequests.add(f[2].toInt()) }
                reply(address, op, tag, a.micStatus)
            }
            else -> reply(address, op, tag, 2)
        }
    }

    private fun packet(address: String, a: FakeG1Arm, p: ByteArray) {
        val opts = p[0].toInt() and 255
        val stream = p[1].toInt() and 255
        val complete = lock.withLock {
            if (opts and 0x80 != 0) a.current = ByteArray(0)
            a.current += p.copyOfRange(2, p.size)
            if (opts and 0x40 != 0) a.current.also { a.current = ByteArray(0) } else null
        } ?: return
        var size = 0
        val crc = (complete[3].toInt() and 255) or ((complete[4].toInt() and 255) shl 8)
        var ok = false
        lock.withLock {
            a.wireBytes += complete.size
            val lens = complete[0].toInt() and CfwTransport.BOTH
            assertEquals(if (a.left) 1 else 2, lens, "a record names the arm it goes to")
            if (a.nackNext) {
                a.nackNext = false
            } else {
                if (complete[0].toInt() and CfwTransport.RESET_CONTEXT != 0) a.records.clear()
                a.records.add(complete)
                val message = inflateRecords(a.records).last()
                size = message.size
                assertTrue(size <= 16384, "the firmware's limit on a decoded message: $size")
                if (CfwTransport.crc(message) == crc) {
                    ok = true
                    apply(a, message)
                }
            }
        }
        val body = byteArrayOf((if (ok) 1 else 3).toByte(), stream.toByte(), 0, 0, (if (a.left) 1 else 2).toByte(),
            size.toByte(), (size ushr 8).toByte(), crc.toByte(), (crc ushr 8).toByte())
        event(address, G1Protocol.EV_FC_ACK, body)
    }

    private fun apply(a: FakeG1Arm, m: ByteArray) {
        val type = m[0].toInt() and 255
        a.messageTypes.add(type)
        when (type) {
            CFW_MSG_DRAW_CALLS -> a.rects.addAll(applyDraw(a.frame, m))
            CFW_MSG_PRESENT -> if (a.visible) {
                a.frame.copyInto(a.panel)
                a.panelOn = true
            }
            CFW_MSG_BRIGHTNESS -> {
                a.brightness = m[2].toInt() and 255
                if (a.visible && m[3].toInt() == 0) a.panelOn = false
                a.visible = m[3].toInt() != 0
            }
            CFW_MSG_DIAGNOSTICS -> a.benchmarkMessages++
            else -> throw AssertionError("message type $type must not reach a G1")
        }
    }

    override fun disconnect(address: String) {}

    override fun close() {}

    override fun isBonded(address: String): Boolean = lock.withLock { arm(address).bonded }

    override fun prepareBenchmarkLink(address: String, mode: Int) {}

    override fun recordDisplayFrameSent() {}
}

private class G1Listener(platform: ProtocolPlatform) : FaceclawBleCommunicatorListener {
    private val lock = platform.createLock()
    private val phaseList = ArrayList<String>()
    private val eventList = ArrayList<String>()
    private val batteryList = ArrayList<String>()
    private val firmwareList = ArrayList<String>()
    private val wearList = ArrayList<Boolean>()
    @Volatile var lastStatus = ""
    val phases get() = lock.withLock { phaseList.toList() }
    val events get() = lock.withLock { eventList.toList() }
    val batteries get() = lock.withLock { batteryList.toList() }
    val firmware get() = lock.withLock { firmwareList.toList() }
    val wear get() = lock.withLock { wearList.toList() }

    override fun onStateChange(phase: String?, status: String?) {
        lock.withLock { phaseList.add(phase ?: "") }
        lastStatus = status ?: ""
    }

    override fun onRingEvent(kind: String?, containerName: String?, eventType: Int, eventSource: Int, systemExitReasonCode: Int, frameId: Int, ringTick: Long, ringType: Int, ringAux: Int, ringSpeed: Int) {
        lock.withLock { eventList.add("$kind:$eventType:$eventSource") }
    }

    override fun onBatteryState(headsetBattery: Int, headsetCharging: Int, ringBattery: Int, ringCharging: Int) {
        lock.withLock { batteryList.add("$headsetBattery/$headsetCharging") }
    }

    override fun onSilentMode(silent: Boolean) {}

    override fun onWearState(wearing: Boolean) {
        lock.withLock { wearList.add(wearing) }
    }

    override fun onPhoneLockState(locked: Boolean) {}

    override fun onCaseState(caseBattery: Int, caseCharging: Int, caseDocked: Boolean) {}

    override fun onEvenAppConflict(message: String?) {}

    override fun onFrameMetrics(paintMs: Int, transmitMs: Int, tileCount: Int) {}

    override fun onFrameFinished(frameId: Int, outcome: String?) {}

    override fun onFirmwareInfo(leftVersion: String?, rightVersion: String?, extension: String?) {
        lock.withLock { firmwareList.add("$leftVersion|$rightVersion|$extension") }
    }
}

private class G1Session {
    val platform = testPlatform()
    val glasses = FakeG1Glasses(platform)
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
            startThread("g1-test-session", true) {
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
    val listener = G1Listener(platform)
    val core = GlassesSessionCore(glasses, host, FrameTimingsCore(platform), platform, RIGHT, LEFT, "")

    init {
        glasses.core = core
        core.setListener(listener)
        core.setRequiredFirmwareRevision(38)
        core.useG1()
        core.configureCompositorScreen(W, H)
        core.configureSurface("s", 0, 0, W, 64, 0, SurfaceCompositor.TRANSPARENCY_OPAQUE)
    }

    fun ready(): Boolean = core.monitor.withLock { core.sessionReady && core.fixedLayoutCreated }

    fun displayedMatchesDesired(): Boolean = core.monitor.withLock {
        core.desiredTilesLock.locked { core.desiredFingerprint.isNotEmpty() && core.desiredFingerprint == core.displayedFingerprint }
    }

    fun pixels(seed: Int) = ByteArray(W * 64) { if ((it + seed) % 11 == 0) 0xF0.toByte() else if (it % 17 == 0) 0x70 else 0 }

    fun submit(seed: Int, frameId: Int) =
        core.submitSurfaceFrame(ArrayByteReader(pixels(seed)), "s", 0, 0, W, 64, "content-$seed", 0, frameId, null)

    /** The packed picture the surface's gray pixels should give on both lenses. */
    fun expected(seed: Int): ByteArray {
        val packed = ByteArray(STRIDE * H)
        BmpUtil.pack4bppFromGray8(pixels(seed), W, 64).copyInto(packed)
        return packed
    }

    fun tail(): String = host.logs().takeLast(30).joinToString("\n")

    fun shownOnBoth(picture: ByteArray): Boolean = glasses.lock.withLock {
        glasses.leftArm.panel.contentEquals(picture) && glasses.rightArm.panel.contentEquals(picture)
    }
}

class G1SessionTest {
    @Test
    fun pairsOnFirstConnectAndShowsEachLensItsFrame() {
        val s = G1Session()
        try {
            assertTrue(s.core.start())
            assertTrue(awaitTrue(5_000) { s.ready() }, "never ready:\n" + s.tail())
            assertTrue(s.core.isEvenG1())
            assertEquals(1, s.glasses.leftArm.pairedWrites, "each arm's encryption is proved by a PAIR write")
            assertEquals(1, s.glasses.rightArm.pairedWrites)
            assertEquals(G1Protocol.EVENTS_MASK, s.glasses.leftArm.eventsMask)
            assertEquals(G1Protocol.EVENTS_MASK, s.glasses.rightArm.eventsMask)
            assertEquals(1, s.glasses.leftArm.healthOk, "the boot is confirmed healthy")
            assertTrue(s.listener.firmware.single().startsWith("g1v0 0.5.63|g1v0 0.5.63|Faceclaw/"), s.listener.firmware.toString())

            s.submit(1, 1)
            assertTrue(awaitTrue(5_000) { s.displayedMatchesDesired() }, "frame never displayed:\n" + s.tail())
            val picture = s.expected(1)
            assertTrue(s.shownOnBoth(picture), "both lenses show the whole frame:\n" + s.tail())
            for (arm in listOf(s.glasses.leftArm, s.glasses.rightArm)) {
                assertEquals(CFW_MSG_PRESENT, arm.messageTypes.last(), "an update ends in PRESENT")
                assertTrue(arm.messageTypes.all { it == CFW_MSG_DRAW_CALLS || it == CFW_MSG_PRESENT || it == CFW_MSG_BRIGHTNESS },
                    arm.messageTypes.toString())
            }
        } finally {
            s.core.disconnect()
        }
    }

    @Test
    fun aRelayFirmwareIsListenedToOnTheRightArmOnly() {
        val s = G1Session()
        val frames = ArrayList<ByteArray>()
        val lock = testPlatform().createLock()
        s.glasses.hasAncsRelay = true
        s.core.setRawFrameTap { frame -> lock.withLock { frames.add(frame) } }
        try {
            assertTrue(s.core.start())
            assertTrue(awaitTrue(5_000) { s.ready() }, s.tail())
            assertTrue(s.core.ancsRelayAvailable())
            assertEquals(listOf(RIGHT), s.glasses.lock.withLock { s.glasses.ancsSubscribed.toList() })

            // A command goes to the relay's characteristic; a G2's would go to its command characteristic.
            val start = byteArrayOf(0x41, 0x4e, 1, 0, 9, 0, 0, 0)
            assertTrue(s.core.writeRawPacket("R", start))
            val written = s.glasses.lock.withLock { s.glasses.ancsWrites.single() }
            assertEquals(RIGHT, written.first)
            assertTrue(written.second.contentEquals(start))

            // A frame reaches the client untouched, and isn't taken for an event; a stray one doesn't reach it.
            val frame = byteArrayOf(0x41, 0x4e, 1, 0, 9, 0, 0, 0, 0, 0, 3, 1)
            s.core.onNotification(RIGHT, G1Ble.ANCS_CHAR_UUID, frame)
            s.core.onNotification(LEFT, G1Ble.ANCS_CHAR_UUID, frame)
            s.core.onNotification(RIGHT, G1Ble.ANCS_CHAR_UUID, byteArrayOf(1, 2, 3))
            s.core.onNotification(RIGHT, G1Ble.EVT_CHAR_UUID.uppercase(), byteArrayOf(0x41, 0x4e, 1, 0, 9, 0, 0, 0, 0, 0, 3))
            lock.withLock {
                assertEquals(1, frames.size, "only the right arm's relay frames")
                assertTrue(frames[0].contentEquals(frame))
            }
        } finally {
            s.core.disconnect()
        }
    }

    @Test
    fun theRelayIsAvailableOnlyWithFirmwareAHostThatListensAndTheCharacteristic() {
        // Android: no client, so nothing to subscribe for, whatever the firmware has.
        val android = G1Session()
        android.glasses.hasAncsRelay = true
        try {
            assertTrue(android.core.start())
            assertTrue(awaitTrue(5_000) { android.ready() }, android.tail())
            assertFalse(android.core.ancsRelayAvailable())
            assertEquals(emptyList(), android.glasses.lock.withLock { android.glasses.ancsSubscribed.toList() })
        } finally {
            android.core.disconnect()
        }
        // Firmware before the relay still runs Faceclaw, and doesn't get a subscription it can't answer.
        val old = G1Session()
        old.core.setRawFrameTap { }
        try {
            assertTrue(old.core.start())
            assertTrue(awaitTrue(5_000) { old.ready() }, old.tail())
            assertFalse(old.core.ancsRelayAvailable())
            assertEquals(emptyList(), old.glasses.lock.withLock { old.glasses.ancsSubscribed.toList() })
        } finally {
            old.core.disconnect()
        }
        // The OS still has the layout from before the update: the session goes on without it.
        val stale = G1Session()
        stale.glasses.hasAncsRelay = true
        stale.glasses.ancsCharacteristicMissing = true
        stale.core.setRawFrameTap { }
        try {
            assertTrue(stale.core.start())
            assertTrue(awaitTrue(5_000) { stale.ready() }, stale.tail())
            assertFalse(stale.core.ancsRelayAvailable())
        } finally {
            stale.core.disconnect()
        }
    }

    @Test
    fun aSecondFrameIsADeltaThatCostsLittle() {
        val s = G1Session()
        try {
            assertTrue(s.core.start())
            assertTrue(awaitTrue(5_000) { s.ready() }, s.tail())
            s.submit(1, 1)
            assertTrue(awaitTrue(5_000) { s.displayedMatchesDesired() }, s.tail())
            val first = s.glasses.lock.withLock { s.glasses.leftArm.wireBytes }
            val rectsBefore = s.glasses.lock.withLock { s.glasses.leftArm.rects.size }
            // One small area of the surface changes.
            val pixels = s.pixels(1)
            for (y in 10 until 14) for (x in 100 until 120) pixels[y * W + x] = 0x80.toByte()
            s.core.submitSurfaceFrame(ArrayByteReader(pixels), "s", 0, 0, W, 64, "content-delta", 0, 2, null)
            assertTrue(awaitTrue(5_000) { s.displayedMatchesDesired() }, s.tail())
            val packed = ByteArray(STRIDE * H)
            BmpUtil.pack4bppFromGray8(pixels, W, 64).copyInto(packed)
            assertTrue(s.shownOnBoth(packed), s.tail())
            s.glasses.lock.withLock {
                val rects = s.glasses.leftArm.rects.drop(rectsBefore)
                assertTrue(rects.isNotEmpty() && rects.all { it[2] * it[3] < 64 * 16 }, "tight rects: " + rects.map { it.toList() })
                assertTrue(s.glasses.leftArm.wireBytes - first < first, "${s.glasses.leftArm.wireBytes - first} after $first")
            }
        } finally {
            s.core.disconnect()
        }
    }

    @Test
    fun anUnchangedFrameSendsNothing() {
        val s = G1Session()
        try {
            assertTrue(s.core.start())
            assertTrue(awaitTrue(5_000) { s.ready() }, s.tail())
            s.submit(1, 1)
            assertTrue(awaitTrue(5_000) { s.displayedMatchesDesired() }, s.tail())
            val before = s.glasses.lock.withLock { s.glasses.leftArm.messageTypes.size }
            s.core.submitSurfaceFrame(ArrayByteReader(s.pixels(1)), "s", 0, 0, W, 64, "content-again", 0, 2, null)
            assertTrue(awaitTrue(5_000) { s.displayedMatchesDesired() }, s.tail())
            assertEquals(before, s.glasses.lock.withLock { s.glasses.leftArm.messageTypes.size })
        } finally {
            s.core.disconnect()
        }
    }

    @Test
    fun aNackReplaysFromAResetStreamAndTheFrameStillArrives() {
        val s = G1Session()
        try {
            assertTrue(s.core.start())
            assertTrue(awaitTrue(5_000) { s.ready() }, s.tail())
            s.glasses.lock.withLock { s.glasses.rightArm.nackNext = true }
            s.submit(2, 1)
            assertTrue(awaitTrue(8_000) { s.displayedMatchesDesired() }, "never displayed:\n" + s.tail())
            assertTrue(s.shownOnBoth(s.expected(2)), s.tail())
            assertFalse(s.glasses.lock.withLock { s.glasses.rightArm.nackNext })
        } finally {
            s.core.disconnect()
        }
    }

    @Test
    fun gesturesWearAndBatteryReachTheListener() {
        val s = G1Session()
        try {
            assertTrue(s.core.start())
            assertTrue(awaitTrue(5_000) { s.ready() }, s.tail())
            s.glasses.input(LEFT, G1Protocol.TRIGGER_TOUCH, G1Protocol.GESTURE_TAP)
            s.glasses.input(RIGHT, G1Protocol.TRIGGER_TOUCH, G1Protocol.GESTURE_TAP)
            s.glasses.input(RIGHT, G1Protocol.TRIGGER_TOUCH, G1Protocol.GESTURE_DOUBLE_TAP)
            s.glasses.input(LEFT, G1Protocol.TRIGGER_TOUCH, G1Protocol.GESTURE_LONG_START)
            s.glasses.input(LEFT, G1Protocol.TRIGGER_TOUCH, G1Protocol.GESTURE_LONG_END)
            assertEquals(
                listOf(
                    "sys-event:${BleProtocol.EVENT_SCROLL_TOP}:${BleProtocol.EVENT_SOURCE_GLASSES_L}",
                    "sys-event:${BleProtocol.EVENT_SCROLL_BOTTOM}:${BleProtocol.EVENT_SOURCE_GLASSES_R}",
                    "sys-event:${BleProtocol.EVENT_CLICK}:${BleProtocol.EVENT_SOURCE_GLASSES_R}",
                    "sys-event:${BleProtocol.EVENT_DOUBLE_CLICK}:${BleProtocol.EVENT_SOURCE_GLASSES_L}",
                ),
                s.listener.events,
            )
            // The first props poll tells battery and wear; the pair reads its lower arm.
            assertTrue(awaitTrue(3_000) { s.listener.batteries.contains("80/0") }, s.listener.batteries.toString())
            assertTrue(awaitTrue(3_000) { s.listener.wear.contains(true) }, s.listener.wear.toString())
            s.glasses.input(LEFT, G1Protocol.TRIGGER_BATTERY, 55)
            assertTrue(awaitTrue(3_000) { s.listener.batteries.contains("55/0") }, s.listener.batteries.toString())
        } finally {
            s.core.disconnect()
        }
    }

    @Test
    fun blankingHidesThePanelsAndWakingIsADelta() {
        val s = G1Session()
        try {
            assertTrue(s.core.start())
            assertTrue(awaitTrue(5_000) { s.ready() }, s.tail())
            s.submit(1, 1)
            assertTrue(awaitTrue(5_000) { s.displayedMatchesDesired() }, s.tail())
            val wire = s.glasses.lock.withLock { s.glasses.leftArm.wireBytes }
            val draws = s.glasses.lock.withLock { s.glasses.leftArm.messageTypes.count { it == CFW_MSG_DRAW_CALLS } }

            s.core.setScreenBlanked(true)
            assertTrue(awaitTrue(5_000) { s.glasses.lock.withLock { !s.glasses.leftArm.visible && !s.glasses.rightArm.visible } }, s.tail())
            assertTrue(s.shownOnBoth(s.expected(1)), "the arms keep the picture for the wake")
            assertFalse(s.glasses.lock.withLock { s.glasses.leftArm.panelOn })

            // In the dark a tap is for the Glanceboard and a double tap wakes, as on a G2.
            s.glasses.input(LEFT, G1Protocol.TRIGGER_TOUCH, G1Protocol.GESTURE_TAP)
            s.glasses.input(RIGHT, G1Protocol.TRIGGER_TOUCH, G1Protocol.GESTURE_DOUBLE_TAP)
            assertEquals(
                listOf("sys-event:${BleProtocol.EVENT_CLICK}:${BleProtocol.EVENT_SOURCE_GLASSES_L}",
                    "display-wake:${BleProtocol.EVENT_DOUBLE_CLICK}:0"),
                s.listener.events,
            )

            s.core.setScreenBlanked(false)
            assertTrue(awaitTrue(5_000) {
                s.glasses.lock.withLock { s.glasses.leftArm.visible && s.glasses.leftArm.panelOn && s.glasses.rightArm.panelOn }
            }, "the panels must come back with a PRESENT:\n" + s.tail())
            assertEquals(draws, s.glasses.lock.withLock { s.glasses.leftArm.messageTypes.count { it == CFW_MSG_DRAW_CALLS } },
                "the same picture needs no pixels")
            assertTrue(s.glasses.lock.withLock { s.glasses.leftArm.wireBytes } - wire < 256)
        } finally {
            s.core.disconnect()
        }
    }

    @Test
    fun bothArmsInTheCaseDarkenThePanelsAndStopFrames() {
        val s = G1Session()
        try {
            assertTrue(s.core.start())
            assertTrue(awaitTrue(5_000) { s.ready() }, s.tail())
            s.submit(1, 1)
            assertTrue(awaitTrue(5_000) { s.displayedMatchesDesired() }, s.tail())
            s.glasses.input(LEFT, G1Protocol.TRIGGER_CASE, 1)
            assertFalse(s.core.monitor.withLock { s.core.chargingMode }, "one arm isn't the pair")
            s.glasses.input(RIGHT, G1Protocol.TRIGGER_CASE, 1)
            assertTrue(awaitTrue(3_000) { s.listener.phases.contains("charging") }, s.listener.phases.toString())
            assertTrue(awaitTrue(3_000) { s.glasses.lock.withLock { !s.glasses.leftArm.visible && !s.glasses.rightArm.visible } }, s.tail())
        } finally {
            s.core.disconnect()
        }
    }

    @Test
    fun anArmThatCannotBondParksWithInstructions() {
        val s = G1Session()
        s.glasses.pairingRefused = true
        try {
            // A short window for the test: the session waits for the OS's pairing dialog.
            assertTrue(s.core.start())
            assertTrue(awaitTrue(40_000) { s.listener.phases.contains("unpaired") }, s.listener.phases.toString() + "\n" + s.tail())
            assertTrue(s.listener.lastStatus.contains("case"), s.listener.lastStatus)
            assertFalse(s.ready())
        } finally {
            s.core.disconnect()
        }
    }

    @Test
    fun firmwareWithoutTheDisplayPathIsIncompatible() {
        val s = G1Session()
        s.glasses.hasDisplayPath = false
        try {
            assertTrue(s.core.start())
            assertTrue(awaitTrue(5_000) { s.listener.phases.contains("incompatible-firmware") }, s.listener.phases.toString() + "\n" + s.tail())
            assertTrue(s.listener.firmware.single().endsWith("|"), s.listener.firmware.toString())
        } finally {
            s.core.disconnect()
        }
    }
}

private class G1AudioSink(platform: ProtocolPlatform) : FaceclawAudioPacketListener {
    private val lock = platform.createLock()
    private val list = ArrayList<Pair<ByteArray, String>>()
    val packets get() = lock.withLock { list.toList() }

    override fun onAudioPacket(data: ByteArray?, arm: String?, arrivalMs: Long) {
        lock.withLock { list.add(data!! to arm!!) }
    }
}

class G1FeaturesTest {
    private fun ready(): G1Session {
        val s = G1Session()
        assertTrue(s.core.start())
        assertTrue(awaitTrue(5_000) { s.ready() }, s.tail())
        return s
    }

    private fun requests(s: G1Session) = s.glasses.lock.withLock { s.glasses.rightArm.micRequests.toList() }

    @Test
    fun theMicIsRenewedAndItsFramesBecomeG2Packets() {
        val s = ready()
        try {
            val sink = G1AudioSink(s.platform)
            assertTrue(s.core.startG2AudioCapture(sink))
            assertTrue(s.core.isAudioCaptureActive())
            assertTrue(awaitTrue(2_000) { requests(s).contains(1) }, s.tail())
            assertTrue(awaitTrue(3_000) { requests(s).count { it == 1 } >= 2 }, "the lease must be renewed:\n" + s.tail())
            assertEquals(emptyList(), s.glasses.lock.withLock { s.glasses.leftArm.micRequests.toList() }, "the left arm has no mic")

            s.glasses.micData(100, 5)
            s.glasses.micData(105, 5)
            val packets = sink.packets
            assertEquals(2, packets.size)
            for ((packet, arm) in packets) {
                assertEquals("R", arm)
                assertEquals(Lc3PacketFramer.PACKET_BYTES, packet.size)
            }
            assertEquals(20, packets[0].first[Lc3PacketFramer.COUNTER_OFFSET].toInt())
            assertEquals(21, packets[1].first[Lc3PacketFramer.COUNTER_OFFSET].toInt())
            assertEquals(104.toByte(), packets[0].first[199], "the frames in order")
            assertEquals(0.toByte(), packets[0].first[Lc3PacketFramer.SSR_OFFSET])

            s.core.stopG2AudioCapture()
            assertFalse(s.core.isAudioCaptureActive())
            assertTrue(awaitTrue(2_000) { requests(s).last() == 0 }, requests(s).toString())
            s.glasses.micData(110, 5)
            assertEquals(2, sink.packets.size, "nothing reaches a stopped capture")
        } finally {
            s.core.disconnect()
        }
    }

    @Test
    fun aRefusedOrFaultedMicEndsTheCaptureAndALateRenewalDoesNot() {
        val s = ready()
        try {
            val sink = G1AudioSink(s.platform)
            assertTrue(s.core.startG2AudioCapture(sink))
            assertTrue(awaitTrue(2_000) { requests(s).isNotEmpty() }, s.tail())
            val before = requests(s).size
            s.glasses.notice(RIGHT, G1Protocol.NOTICE_MIC_STOPPED, G1Protocol.MIC_STOPPED_LEASE.toByte())
            assertTrue(s.core.isAudioCaptureActive())
            assertTrue(awaitTrue(900) { requests(s).size > before }, "asked again at once")
            s.glasses.notice(RIGHT, G1Protocol.NOTICE_MIC_STOPPED, 2)
            assertFalse(s.core.isAudioCaptureActive(), "a capture fault ends it")

            s.glasses.lock.withLock { s.glasses.rightArm.micStatus = 12 }
            assertTrue(s.core.startG2AudioCapture(sink))
            assertTrue(awaitTrue(2_000) { !s.core.isAudioCaptureActive() }, s.tail())
        } finally {
            s.core.disconnect()
        }
    }

    @Test
    fun lightReadingsDriveTheBrightnessPolicy() {
        val s = ready()
        try {
            s.core.configureBrightness(true, 50, 20, 100, "0:0,50:24,200:60,1000:98,2000:100", 280)
            s.submit(1, 1)
            assertTrue(awaitTrue(5_000) { s.displayedMatchesDesired() }, s.tail())
            // 1000 lux on the right arm's sensor, reported in 0.01 lux; the policy filters it towards the curve's top.
            s.glasses.lock.withLock { s.glasses.rightArm.props[G1Protocol.PROP_LIGHT] = 100_000 }
            assertTrue(awaitTrue(6_000) { s.glasses.lock.withLock { s.glasses.rightArm.brightness > 60 && s.glasses.leftArm.brightness > 60 } },
                "both eyes follow: " + s.glasses.lock.withLock { s.glasses.rightArm.brightness } + "\n" + s.tail())
            // In the dark, a lower level, again on both.
            s.glasses.lock.withLock { s.glasses.rightArm.props[G1Protocol.PROP_LIGHT] = 500 }
            assertTrue(awaitTrue(12_000) { s.glasses.lock.withLock { s.glasses.rightArm.brightness < 50 && s.glasses.leftArm.brightness < 50 } },
                "brightness " + s.glasses.lock.withLock { s.glasses.rightArm.brightness } + "\n" + s.tail())
        } finally {
            s.core.disconnect()
        }
    }

    @Test
    fun onePanelGuardsCapHoldsBothEyes() {
        val s = ready()
        try {
            s.glasses.notice(RIGHT, G1Protocol.NOTICE_GUARD, 12, 12)
            assertTrue(awaitTrue(2_000) { s.glasses.lock.withLock { s.glasses.leftArm.props[G1Protocol.PROP_BRIGHTNESS_MAX] == 12 } }, s.tail())
            assertEquals(G1Protocol.BRIGHTNESS_LEVEL_MAX, s.glasses.lock.withLock { s.glasses.rightArm.props[G1Protocol.PROP_BRIGHTNESS_MAX] },
                "only the other eye: the arm's own cap already holds it")
            s.glasses.notice(RIGHT, G1Protocol.NOTICE_GUARD, 42, 21)
            assertTrue(awaitTrue(2_000) { s.glasses.lock.withLock { s.glasses.leftArm.props[G1Protocol.PROP_BRIGHTNESS_MAX] == 42 } }, s.tail())
        } finally {
            s.core.disconnect()
        }
    }

    @Test
    fun imuSamplesArePolledWhileWanted() {
        val s = ready()
        try {
            val lock = s.platform.createLock()
            val readings = ArrayList<List<Double>>()
            s.core.addImuListener(object : FaceclawImuListener {
                override fun onImuData(x: Double, y: Double, z: Double, eventSource: Int) {
                    lock.withLock { readings.add(listOf(x, y, z, eventSource.toDouble())) }
                }
            })
            s.glasses.lock.withLock {
                s.glasses.rightArm.props[G1Protocol.PROP_ACC_X] = 100
                s.glasses.rightArm.props[G1Protocol.PROP_ACC_Y] = -1000
                s.glasses.rightArm.props[G1Protocol.PROP_ACC_Z] = 250
            }
            s.core.setImuReportEnabled(true, 200)
            assertTrue(awaitTrue(3_000) { lock.withLock { readings.size >= 5 } }, "samples: " + lock.withLock { readings.size } + "\n" + s.tail())
            assertEquals(listOf(0.1, -1.0, 0.25, BleProtocol.EVENT_SOURCE_GLASSES_R.toDouble()), lock.withLock { readings.first() })
            assertTrue(awaitTrue(1_000) { s.glasses.lock.withLock { s.glasses.rightArm.props[G1Protocol.PROP_IMU_RATE] == G1Protocol.IMU_RATE_STREAM } })
            s.core.setImuReportEnabled(false, 0)
            assertTrue(awaitTrue(1_000) { s.glasses.lock.withLock { s.glasses.rightArm.props[G1Protocol.PROP_IMU_RATE] == G1Protocol.IMU_RATE_IDLE } })
            sleepMs(200)
            val count = lock.withLock { readings.size }
            sleepMs(300)
            assertEquals(count, lock.withLock { readings.size }, "the polling stops")
        } finally {
            s.core.disconnect()
        }
    }

    @Test
    fun theBandwidthBenchmarkRunsOverBothArms() {
        val s = ready()
        try {
            s.submit(1, 1)
            assertTrue(awaitTrue(5_000) { s.displayedMatchesDesired() }, s.tail())
            assertTrue(s.core.startBandwidthBenchmarkWithLinkMode(1000, 3, 1_000, 0))
            assertTrue(awaitTrue(8_000) { !s.core.monitor.withLock { s.core.benchmarkActive } }, s.tail())
            assertTrue(s.core.monitor.withLock { !s.core.benchmarkAborted && s.core.benchmarkMessagesAcked > 2 && s.core.benchmarkTimeouts == 0 },
                s.core.getBandwidthBenchmarkStatus() + "\n" + s.tail())
            val left = s.glasses.lock.withLock { s.glasses.leftArm.benchmarkMessages }
            val right = s.glasses.lock.withLock { s.glasses.rightArm.benchmarkMessages }
            assertTrue(left > 0 && kotlin.math.abs(left - right) <= 1, "left $left right $right")
        } finally {
            s.core.disconnect()
        }
    }
}

class G1ProtocolTest {
    @Test
    fun micFramesFillPacketsAcrossEventsAndAGapDropsTheRemainder() {
        fun frames(first: Int, count: Int) = ByteArray(count * 40) { (first + it / 40).toByte() }
        val out = ArrayList<ByteArray>()
        val a = G1MicAssembler()
        // MTU too small for five frames an event: two, two, then one completes a packet.
        a.ingest(10, 2, frames(10, 2), 0) { out.add(it) }
        a.ingest(12, 2, frames(12, 2), 0) { out.add(it) }
        assertTrue(out.isEmpty())
        a.ingest(14, 3, frames(14, 3), 0) { out.add(it) }
        assertEquals(1, out.size)
        assertEquals(2, out[0][Lc3PacketFramer.COUNTER_OFFSET].toInt(), "frame 10's packet")
        assertEquals(14.toByte(), out[0][160])
        // 15 and 16 are waiting; 20 comes next, so they are gone and a new packet starts there.
        a.ingest(20, 5, frames(20, 5), 0) { out.add(it) }
        assertEquals(2, out.size)
        assertEquals(4, out[1][Lc3PacketFramer.COUNTER_OFFSET].toInt())
        assertEquals(20.toByte(), out[1][0])
    }

    @Test
    fun aLightReadingBecomesAReportThePolicyTakes() {
        val report = G1Protocol.alsReport(123_400, 40, 5000)
        assertEquals(24, report.size)
        val policy = BrightnessPolicy()
        policy.configure(true, 50, 2, 100, "0:0,1000:100", 280)
        policy.sample(report, 1000)
        assertTrue(policy.target > 90, "1234 lux on this curve: ${policy.target}")
    }

    @Test
    fun aPropertySetIsIdAndLittleEndianValue() {
        assertTrue(byteArrayOf(0x29, 42, 0, 0, 0).contentEquals(G1Protocol.propSet(G1Protocol.PROP_BRIGHTNESS_MAX, 42)))
    }

    @Test
    fun packetsCarryARecordWithinTheMtu() {
        val record = ByteArray(1000) { it.toByte() }
        val packets = G1Protocol.packets(record, 42, 185)
        assertTrue(packets.all { it.size <= 182 })
        assertEquals(0x80, packets.first()[0].toInt() and 0xC0)
        assertEquals(0x40, packets.last()[0].toInt() and 0xC0)
        assertTrue(packets.drop(1).dropLast(1).all { it[0].toInt() == 0 })
        assertTrue(packets.all { it[1].toInt() == 42 })
        assertTrue(record.contentEquals(packets.flatMap { it.drop(2) }.toByteArray()))
        val one = G1Protocol.packets(byteArrayOf(1, 2, 3, 4, 5), 7, 247)
        assertEquals(1, one.size)
        assertEquals(0xC0, one[0][0].toInt() and 0xC0)
    }

    @Test
    fun theFirmwaresPacketLimitHoldsAtAnyMtu() {
        assertEquals(244, G1Protocol.packets(ByteArray(5000), 1, 512).maxOf { it.size })
    }

    @Test
    fun eventsAreParsed() {
        val ack = ByteArray(9) + byteArrayOf(1, 9, 0, 0, 2, 0x34, 0x12, 0x78, 0x56)
        ack[0] = G1Protocol.EV_FC_ACK.toByte()
        val parsed = assertNotNull(G1Protocol.parseFcAck(ack))
        assertFalse(parsed.nack)
        assertEquals(9, parsed.streamId)
        assertEquals(2, parsed.lens)
        assertEquals(0x1234, parsed.size)
        assertEquals(0x5678, parsed.checksum)
        ack[9] = 3
        assertTrue(assertNotNull(G1Protocol.parseFcAck(ack)).nack)
        ack[9] = 2
        assertNull(G1Protocol.parseFcAck(ack))
        assertNull(G1Protocol.parseFcAck(ByteArray(5)))

        val input = ByteArray(9) + byteArrayOf(1, 0, G1Protocol.TRIGGER_TOUCH.toByte(), 2, 0, 0, 0)
        input[0] = G1Protocol.EV_INPUT.toByte()
        val parsedInput = assertNotNull(G1Protocol.parseInput(input))
        assertEquals(G1Protocol.TRIGGER_TOUCH, parsedInput.trigger)
        assertEquals(2, parsedInput.value)

        val reply = assertNotNull(G1Protocol.parseReply(ByteArray(9).also { it[0] = 0x81.toByte() } + byteArrayOf(7, 0, 42)))
        assertEquals(1, reply.op)
        assertEquals(7, reply.tag)
        assertEquals(42, reply.body[0].toInt())
    }

    @Test
    fun helloAndPropsAreParsed() {
        val body = ByteArray(35)
        body[0] = 5
        body[1] = 0
        body[2] = 5
        body[3] = 62
        body[4] = 1
        body[5] = (2 or 64 or 128).toByte()
        body[6] = 4
        val hello = assertNotNull(G1Protocol.parseHello(body))
        assertEquals("0.5.62", hello.version)
        assertTrue(hello.mic)
        assertFalse(hello.ancs, "firmware before the relay")
        assertTrue(hello.leftArm && hello.panelOk && hello.encrypted && hello.inCase)
        body[6] = 8
        assertTrue(assertNotNull(G1Protocol.parseHello(body)).ancs)
        assertFalse(assertNotNull(G1Protocol.parseHello(body)).mic)
        assertFalse(hello.safeMode)
        body[0] = 4
        assertNull(G1Protocol.parseHello(body), "protocol 4 is not this firmware")

        val unknown = byteArrayOf(0, 0, 0, 0x80.toByte(), 7, 0, 0, 0)
        val props = assertNotNull(G1Protocol.parseProps(unknown, 2))
        assertEquals(G1Protocol.UNKNOWN, props[0])
        assertEquals(7, props[1])
        assertNull(G1Protocol.parseProps(unknown, 3))
    }

    @Test
    fun gesturesMapToWhatTheUiExpects() {
        assertEquals(BleProtocol.EVENT_SCROLL_TOP, G1Protocol.gestureEventType(G1Protocol.GESTURE_TAP, true))
        assertEquals(BleProtocol.EVENT_SCROLL_BOTTOM, G1Protocol.gestureEventType(G1Protocol.GESTURE_TAP, false))
        assertEquals(BleProtocol.EVENT_CLICK, G1Protocol.gestureEventType(G1Protocol.GESTURE_DOUBLE_TAP, true))
        assertEquals(BleProtocol.EVENT_DOUBLE_CLICK, G1Protocol.gestureEventType(G1Protocol.GESTURE_TRIPLE_TAP, false))
        assertEquals(BleProtocol.EVENT_DOUBLE_CLICK, G1Protocol.gestureEventType(G1Protocol.GESTURE_LONG_START, true))
        assertNull(G1Protocol.gestureEventType(G1Protocol.GESTURE_LONG_END, true))
        assertEquals(BleProtocol.EVENT_CLICK, G1Protocol.gestureEventType(G1Protocol.GESTURE_TAP, false, dark = true))
        assertEquals(BleProtocol.EVENT_DOUBLE_CLICK, G1Protocol.gestureEventType(G1Protocol.GESTURE_DOUBLE_TAP, false, dark = true))
    }
}

class G1FramePlannerTest {
    private fun noise(seed: Int): ByteArray {
        var state = seed
        return ByteArray(STRIDE * H) {
            state = state * 1103515245 + 12345
            (state ushr 16).toByte()
        }
    }

    private fun replay(start: ByteArray?, messages: List<ByteArray>): ByteArray {
        val frame = start?.copyOf() ?: ByteArray(STRIDE * H)
        for (m in messages) applyDraw(frame, m)
        return frame
    }

    @Test
    fun aFullFrameOfNoiseFitsTheMessageLimit() {
        val next = noise(5)
        val messages = G1FramePlanner.plan(null, next, W, H)
        assertTrue(messages.size > 1)
        assertTrue(messages.all { it.size <= G1FramePlanner.MAX_MESSAGE }, messages.maxOf { it.size }.toString())
        assertTrue(replay(null, messages).contentEquals(next))
    }

    @Test
    fun nothingChangedIsEmpty() {
        val next = noise(5)
        assertTrue(G1FramePlanner.plan(next, next.copyOf(), W, H).isEmpty())
    }

    @Test
    fun deltasReconstructTheFrameAtAnyPosition() {
        val before = noise(5)
        for ((x, y, w, h) in listOf(listOf(0, 0, 1, 1), listOf(639, 479, 1, 1), listOf(101, 51, 33, 17), listOf(0, 100, 640, 3), listOf(300, 0, 2, 480))) {
            val next = before.copyOf()
            for (yy in y until y + h) for (xx in x until x + w) setNibble(next, xx, yy, 15 - nibble(next, xx, yy))
            val messages = G1FramePlanner.plan(before, next, W, H)
            assertTrue(messages.isNotEmpty())
            assertTrue(replay(before, messages).contentEquals(next), "rect $x,$y ${w}x$h")
        }
        // Two far-apart changes
        val next = before.copyOf()
        setNibble(next, 3, 3, 15 - nibble(next, 3, 3))
        setNibble(next, 600, 440, 15 - nibble(next, 600, 440))
        assertTrue(replay(before, G1FramePlanner.plan(before, next, W, H)).contentEquals(next))
    }
}

class G1ShellSceneTest {
    @Test
    fun aSceneWithNoLayersIsTheScreen() {
        val screen = ByteArray(STRIDE * H)
        assertTrue(ShellScene.EMPTY.composed(screen, W, H, false) === screen)
        assertFalse(ShellScene.EMPTY.hasStereoDepth)
    }

    @Test
    fun depthShiftsEachLensItsOwnWay() {
        val screen = ByteArray(STRIDE * H)
        setNibble(screen, 100, 50, 9)
        val scene = ShellScene(emptyList(), screenDepth = 2)
        assertTrue(scene.hasStereoDepth)
        val left = scene.composed(screen, W, H, false)
        val right = scene.composed(screen, W, H, true)
        assertEquals(9, nibble(left, 101, 50), "depth +2 moves the left lens +1")
        assertEquals(9, nibble(right, 99, 50), "and the right lens -1")
        assertEquals(0, nibble(left, 100, 50))
        assertEquals(9, nibble(screen, 100, 50), "the screen itself is left alone")
    }
}
