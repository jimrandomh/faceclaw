package com.faceclaw.app

import kotlin.concurrent.Volatile
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import platform.Foundation.NSDate
import platform.Foundation.NSDefaultRunLoopMode
import platform.Foundation.NSRunLoop
import platform.Foundation.NSThread
import platform.Foundation.dateWithTimeIntervalSinceNow
import platform.Foundation.runMode

private const val RIGHT = "11111111-2222-3333-4444-555555555501"
private const val LEFT = "11111111-2222-3333-4444-555555555502"

/** Pump the main run loop (which drains the main dispatch queue) until [condition] or timeout. */
private fun pumpMainUntil(timeoutMs: Long, condition: () -> Boolean): Boolean {
    val deadline = IosProtocolPlatform.elapsedRealtimeMs() + timeoutMs
    while (IosProtocolPlatform.elapsedRealtimeMs() < deadline) {
        if (condition()) return true
        NSRunLoop.mainRunLoop.runMode(NSDefaultRunLoopMode, NSDate.dateWithTimeIntervalSinceNow(0.02))
    }
    return condition()
}

/** A GATT link that acks EvenHub/settings/auth requests and CFW stream messages like the firmware. */
private class FakeIosLink : SessionLink {
    lateinit var core: GlassesSessionCore
    private val lock = IosProtocolPlatform.createLock()
    val connected = HashSet<String>()
    val disconnected = ArrayList<String>()
    @Volatile var closed = false
    @Volatile var writes = 0
    private var seq = 0

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
        writes++
        val sid = frames[0][6].toInt() and 255
        val magic = if (sid == CfwTransport.SID) frames[0][2].toInt() and 255 else BleProtocol.parseFrame(frames[0]).msgSeq
        val inFlight = core.monitor.withLock { core.inFlightMessages.firstOrNull { it.sid == sid && it.magic == magic && magic != 0 } }
        if (inFlight != null) {
            if (sid == CfwTransport.SID) {
                for (lens in 1..2) core.onNotification(address, BleProtocol.NOTIFY_CHAR_UUID, cfwAck(magic, lens, inFlight.message.size, inFlight.cfwChecksum))
            } else {
                val joined = frames.flatMap { frame -> frame.slice(8 until 8 + (frame[3].toInt() and 255)) }.toByteArray()
                val pb = joined.copyOf(maxOf(0, joined.size - 2))
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
        return lock.withLock { BleProtocol.framePb(body, sid, 0x00, seq++)[0] }
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

private class MainThreadListener : FaceclawBleCommunicatorListener {
    val phases = ArrayList<String>()
    var offMainCallbacks = 0

    private fun record(phase: String) {
        if (!NSThread.isMainThread) offMainCallbacks++
        phases.add(phase)
    }

    override fun onStateChange(phase: String?, status: String?) = record(phase ?: "")

    override fun onRingEvent(kind: String?, containerName: String?, eventType: Int, eventSource: Int, systemExitReasonCode: Int, frameId: Int, ringTick: Long, ringType: Int, ringAux: Int, ringSpeed: Int) {}

    override fun onBatteryState(headsetBattery: Int, headsetCharging: Int, ringBattery: Int, ringCharging: Int) {
        if (!NSThread.isMainThread) offMainCallbacks++
    }

    override fun onSilentMode(silent: Boolean) {}

    override fun onWearState(wearing: Boolean) {}

    override fun onPhoneLockState(locked: Boolean) {}

    override fun onEvenAppConflict(message: String?) {}

    override fun onFrameMetrics(paintMs: Int, transmitMs: Int, tileCount: Int) {}

    override fun onFrameFinished(frameId: Int, outcome: String?) {}

    override fun onFirmwareInfo(leftVersion: String?, rightVersion: String?, extension: String?) {}
}

class IosSessionFacadeTest {
    @Test
    fun facadeSessionConnectsOverAnInjectedLinkAndReportsOnTheMainQueue() {
        assertTrue(NSThread.isMainThread, "tests drive the main run loop")
        val link = FakeIosLink()
        val host = IosSessionHost(threadName = "test-session")
        val session = IosGlassesSession(link, null, host, RIGHT, LEFT, "", IosProtocolPlatform)
        link.core = session.coreForTests()
        val listener = MainThreadListener()
        session.setListener(listener)
        assertTrue(session.start())
        assertFalse(session.start(), "already running")
        assertTrue(pumpMainUntil(5_000) { listener.phases.contains("connected") }, "phases=${listener.phases}")
        assertTrue(session.isSessionReady())
        assertEquals(0, listener.offMainCallbacks, "listener callbacks must arrive on the main queue")
        assertTrue(pumpMainUntil(5_000) { link.writes > 3 }, "auth, prelude, settings and layout writes (saw ${link.writes})")
        session.disconnect()
        assertTrue(pumpMainUntil(2_000) { listener.phases.lastOrNull() == "disconnected" }, "phases=${listener.phases}")
        assertFalse(session.isSessionReady())
        assertTrue(link.closed)
        assertEquals(listOf(RIGHT, LEFT), link.disconnected.takeLast(2))
        assertEquals(0, listener.offMainCallbacks)
    }

    @Test
    fun relayFramesReachTheAncsListenerOnMainAndOtherFramesDoNot() {
        val link = FakeIosLink()
        val host = IosSessionHost(threadName = "test-session-ancs")
        val session = IosGlassesSession(link, null, host, RIGHT, LEFT, "", IosProtocolPlatform)
        val core = session.coreForTests()
        link.core = core
        val relayed = ArrayList<ByteArray>()
        var offMain = 0
        session.setAncsListener(object : IosAncsListener {
            override fun onAncsAuthorization(authorized: Boolean) {}

            override fun onRelayFrame(data: platform.Foundation.NSData) {
                if (!NSThread.isMainThread) offMain++
                relayed.add(data.byteArray())
            }
        })
        val relay = byteArrayOf(65, 78, 1, 0, 9, 9, 9, 9, 0, 0, 0)
        core.onNotification(RIGHT, BleProtocol.NOTIFY_CHAR_UUID, relay)
        core.onNotification(LEFT, BleProtocol.NOTIFY_CHAR_UUID, relay) // wrong arm: ignored by the tap
        assertTrue(pumpMainUntil(2_000) { relayed.size == 1 })
        assertEquals(relay.toList(), relayed[0].toList())
        assertEquals(0, offMain)
        session.setAncsListener(null)
        core.onNotification(RIGHT, BleProtocol.NOTIFY_CHAR_UUID, relay)
        assertFalse(pumpMainUntil(200) { relayed.size > 1 })
    }

    @Test
    fun hostDispatchesToTheCallingQueueAndRunsTheWorker() {
        val host = IosSessionHost(threadName = "test-host")
        var onMain = false
        host.currentThreadDispatcher().post { onMain = NSThread.isMainThread }
        assertTrue(pumpMainUntil(1_000) { onMain })
        var workerThread = ""
        host.startWorker { workerThread = NSThread.currentThread.name ?: "" }
        host.joinWorker(2_000)
        assertEquals("test-host", workerThread)
        var posted = false
        host.postToMain { posted = NSThread.isMainThread }
        assertTrue(pumpMainUntil(1_000) { posted })
        assertFalse(host.isEvenAppActive())
    }

    @Test
    fun stockFlowFacadesConstructWithoutBluetooth() {
        // No CoreBluetooth on the simulator; construction and cancel/close must still be safe.
        val probe = IosDeviceInfoProbe(RIGHT, LEFT)
        probe.setListener(null)
        probe.close()
        val prompt = IosFlashPrompt(RIGHT, LEFT, "warn", true)
        prompt.close()
        val flasher = IosFirmwareFlasher(RIGHT, LEFT, "/nonexistent.bin")
        flasher.close()
        assertNotNull(IosFrameTimings.shared.core.buildExport())
    }
}
