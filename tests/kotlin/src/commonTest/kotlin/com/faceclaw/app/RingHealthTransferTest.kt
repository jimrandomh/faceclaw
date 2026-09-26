package com.faceclaw.app

import kotlin.concurrent.Volatile
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private const val RING = "CC:00:00:00:00:03"

/**
 * A ring that answers health requests through the session's real notification
 * path: each REQ gets DATA page `cmd*10+1`, then its RSP; the ACK for a page
 * ending in 1 triggers page `+1`, so the transfer is ACK-paced like the real
 * ring's backlog.
 */
private class FakeRingLink(private val platform: ProtocolPlatform) : SessionLink {
    lateinit var core: GlassesSessionCore
    private val lock = platform.createLock()
    private val writesList = ArrayList<String>()
    @Volatile var failAck = false
    @Volatile var answer = true
    @Volatile var delayRsp = false
    @Volatile var requestStarted = false

    val writes: List<String>
        get() = lock.withLock { writesList.toList() }

    private fun deliver(frame: ByteArray) = core.onNotification(RING, BleProtocol.R1_NOTIFY_CHAR_UUID, frame)

    private fun page(cmdHi: Int, pageSeq: Int) =
        deliver(RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_DATA, cmdHi,
            RingProtocol.CMD_LO_HEALTH, pageSeq, byteArrayOf(0, 0)))

    private fun rsp(cmdHi: Int) =
        deliver(RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_RSP, cmdHi,
            RingProtocol.CMD_LO_HEALTH, 0, byteArrayOf(0, 0)))

    override fun writeFrames(address: String, characteristicUuid: String, frames: List<ByteArray>, mode: GattWriteMode, timeoutMs: Int): Boolean {
        assertEquals(RING, address)
        assertEquals(BleProtocol.R1_WRITE_CHAR_UUID, characteristicUuid)
        val frame = RingProtocol.parse(frames.single())!!
        if (frame.kind == RingProtocol.KIND_ACK) {
            if (failAck) return false
            val pageSeq = frame.payload[6].toInt() and 0xff
            val cmdHi = frame.payload[3].toInt() and 0xff
            lock.withLock { writesList.add("ack:$pageSeq") }
            // A write longer than the idle timeout: page two arrives only
            // after page one's ACK has actually completed.
            sleepMs(130)
            if (pageSeq % 10 == 1) {
                startThread("ring-page", true) {
                    sleepMs(5)
                    page(cmdHi, pageSeq + 1)
                }
            }
        } else if (frame.chan == RingProtocol.CHAN_HEALTH && frame.kind == RingProtocol.KIND_REQ) {
            requestStarted = true
            lock.withLock { writesList.add("req:" + frame.cmdHi) }
            if (answer) {
                page(frame.cmdHi, frame.cmdHi * 10 + 1)
                if (delayRsp) {
                    startThread("ring-rsp", true) {
                        sleepMs(20)
                        rsp(frame.cmdHi)
                    }
                } else {
                    rsp(frame.cmdHi)
                }
            }
        }
        // Device-channel pings between health types are not answered.
        return true
    }

    override fun connect(address: String, timeoutMs: Int): Boolean = true

    override fun requestHighPriority(address: String) {}

    override fun requestMtu(address: String, mtu: Int, timeoutMs: Int): Boolean = true

    override fun negotiatedMtu(address: String): Int = 247

    override fun discoverServices(address: String, timeoutMs: Int): Boolean = true

    override fun enableNotifications(address: String, characteristicUuid: String, enable: Boolean, timeoutMs: Int): Boolean = true

    override fun disconnect(address: String) {}

    override fun close() {}

    override fun isBonded(address: String): Boolean = true

    override fun prepareBenchmarkLink(address: String, mode: Int) {}

    override fun recordDisplayFrameSent() {}
}

private class RingHost : SessionHost {
    @Volatile var journalFails = false
    val journal = ArrayList<String>()

    override fun postToMain(action: () -> Unit) = action()

    override fun currentThreadDispatcher(): SessionDispatcher = SessionDispatcher { it() }

    override fun isPhoneLocked(): Boolean = false

    override fun setScreenWakeLock(on: Boolean) {}

    override fun isEvenAppActive(): Boolean = false

    override fun startWorker(body: () -> Unit) {}

    override fun joinWorker(timeoutMs: Long) {}

    override fun supportsRingHealth(): Boolean = true

    override fun appendRingFrameJournal(line: String) {
        if (journalFails) throw IllegalStateException("disk full")
        synchronizedAdd(line)
    }

    private val lock = testPlatform().createLock()

    private fun synchronizedAdd(line: String) = lock.withLock { journal.add(line) }

    override fun log(level: SessionLogLevel, tag: String, message: String, error: Throwable?) {}
}

/** A core whose ring link is up, without running the glasses worker. */
private class RingSession {
    val platform = testPlatform()
    val link = FakeRingLink(platform)
    val host = RingHost()
    val core = GlassesSessionCore(link, host, FrameTimingsCore(platform), platform,
        "AA:00:00:00:00:01", "AA:00:00:00:00:02", RING)

    init {
        link.core = core
        core.ringHealthRspTimeoutMs = 500
        core.ringHealthDataIdleMs = 100
        core.monitor.withLock {
            core.running = true
            core.ringConnected = true
            core.ringNotificationsReady = true
        }
    }

    fun outboundSize(): Int = core.monitor.withLock { core.ringOutbound.size }
}

class RingHealthTransferTest {
    @Test fun shutdownCancelsAnRspWait() {
        val s = RingSession()
        s.link.answer = false
        s.core.ringHealthRspTimeoutMs = 10_000
        val done = Latch(1, s.platform)
        startThread("ring-pull", true) {
            s.core.requestRingHealth()
            done.countDown()
        }
        val deadline = s.platform.elapsedRealtimeMs() + 1000
        while (!s.link.requestStarted && s.platform.elapsedRealtimeMs() < deadline) sleepMs(5)
        assertTrue(s.link.requestStarted, "no request")
        val start = s.platform.elapsedRealtimeMs()
        s.core.monitor.withLock {
            s.core.running = false
            s.core.monitor.signalAll()
        }
        assertTrue(done.await(300), "ring pull did not stop")
        assertTrue(s.platform.elapsedRealtimeMs() - start < 300, "session lock blocked")
    }

    @Test fun ackPacedPagesDrainBeforeTheNextType() {
        val s = RingSession()
        s.link.delayRsp = true
        assertTrue(s.core.requestRingHealth(), "pull failed")
        val expected = RingProtocol.HEALTH_COMMANDS.flatMap { command ->
            listOf("req:$command", "ack:" + (command * 10 + 1), "ack:" + (command * 10 + 2))
        }
        assertEquals(expected, s.link.writes, "premature next type")
        // Every intact frame (each page and each RSP) was journaled.
        assertEquals(expected.count { it.startsWith("ack:") } + RingProtocol.HEALTH_COMMANDS.size, s.host.journal.size)
    }

    @Test fun failedAckAbortsAndStaysQueuedForRetry() {
        val s = RingSession()
        s.link.failAck = true
        assertFalse(s.core.requestRingHealth(), "failed ACK completed pull")
        assertEquals(1, s.link.writes.size, "advanced after failed ACK")
        assertEquals(1, s.outboundSize(), "failed ACK was discarded")
        s.link.failAck = false
        assertTrue(s.core.awaitRingHealthDataIdle(s.core.ringHealthDataIdleMs), "retry failed")
        assertEquals(0, s.outboundSize(), "retry did not drain ACKs")
    }

    @Test fun missingRspAbortsWithoutAdvancing() {
        val s = RingSession()
        s.link.answer = false
        assertFalse(s.core.requestRingHealth(), "missing RSP completed pull")
        assertEquals(1, s.link.writes.size, "advanced without RSP")
    }

    @Test fun disconnectFailsTheDataWait() {
        val s = RingSession()
        s.core.monitor.withLock { s.core.ringConnected = false }
        assertFalse(s.core.awaitRingHealthDataIdle(100), "disconnect completed transfer")
    }

    @Test fun unjournaledPageIsNotAcknowledged() {
        val s = RingSession()
        s.host.journalFails = true
        s.core.onNotification(RING, BleProtocol.R1_NOTIFY_CHAR_UUID,
            RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_DATA, RingProtocol.CMD_HI_HEART_RATE,
                RingProtocol.CMD_LO_HEALTH, 7, byteArrayOf(0, 0)))
        assertEquals(0, s.outboundSize())
    }

    @Test fun batchWatermarkOnlyClearsWhatWasTaken() {
        val s = RingSession()
        // A decodable one-group heart-rate page: count 1, tz 0, anchor 1000, then [hour][avg][max][min].
        val payload = byteArrayOf(0, 0, 1, 0, 0, 0xe8.toByte(), 0x03, 0, 0, 2, 60, 70, 50)
        fun deliver(seq: Int) = s.core.onNotification(RING, BleProtocol.R1_NOTIFY_CHAR_UUID,
            RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_DATA, RingProtocol.CMD_HI_HEART_RATE,
                RingProtocol.CMD_LO_HEALTH, seq, payload))
        deliver(1)
        deliver(2)
        val batch = s.core.takeRingHealthBatch()
        assertEquals(2, batch.records.size)
        assertEquals(2L, batch.watermark)
        deliver(3)
        assertEquals(2, s.core.clearRingHealthRecordsBelow(batch.watermark))
        val rest = s.core.getRingHealthRecords()
        assertEquals(1, rest.size)
        val record = rest.single() as RingProtocol.HourlyRecord
        assertEquals(60, record.groups.single().avg)
        assertEquals(1000L + 2 * 3600L, record.groups.single().unixSeconds)
    }
}
