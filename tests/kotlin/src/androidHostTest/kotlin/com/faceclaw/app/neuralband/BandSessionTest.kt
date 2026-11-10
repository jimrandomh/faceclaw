// Ported from callbacked/kinesis (MIT, Copyright (c) 2026 callbacked): Tests/KinesisCoreTests/BandSessionTests.swift,
// by way of tetramo-labs/glassly (MIT). Faceclaw drops the raw EMG, band-model and recorded-capture tests
// along with those features.
package com.faceclaw.app.neuralband

import com.faceclaw.app.neuralband.BandEvent.Payload as P
import kotlin.math.abs
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

private fun field(number: Int, value: ULong) = BandWire.field(number, value)
private fun field(number: Int, bytes: ByteArray) = BandWire.field(number, bytes)

/** A synthetic peer using public P-256 scalar 1. All material is generated in tests. */
private class Peer(completeSetup: Boolean = true) {
    val session = BandSession()
    val sender: AirShieldCipher
    val receiver: AirShieldReceiver
    val datax = DataXReceiver()
    var startup: List<DataXFrame>

    /** The band's own clock for [spin], in microseconds. */
    var stamp: ULong = 1_000_000uL

    init {
        val request = session.request()
        assertArrayEquals(hex("806280018100000502000001"), request.copyOfRange(0, 12))
        val local = ProtoFields(request.dropFirst(12))
        val point = ScalarOne.point
        val challenge = range(0, 16)
        val seed = range(0, 32)
        val iv = range(16, 32)
        val peerRequest = BandWire.frame(
            0x8001,
            listOf(0x81000005u, 0x02000001u),
            field(1, point) + field(2, challenge) + field(3, 0uL) + field(4, 3uL),
        )
        val peerEnable = BandWire.frame(
            1,
            listOf(0x02000002u),
            field(1, point) + field(2, seed) + field(3, iv) + field(4, 42uL) + field(5, 3uL),
        )
        var output = ByteArray(0)
        for (byte in peerRequest + peerEnable) {
            val result = session.feed(byteArrayOf(byte), 100.0)
            output += result.outgoing
            assertTrue(result.events.isEmpty())
        }
        val size = (output.be16(0) and 0x7fff) + 4
        val enable = ProtoFields(output.copyOfRange(8, size))
        assertArrayEquals(local.bytes(1), enable.bytes(1))
        assertEquals(3uL, enable.integer(5))
        val secret = P256.sharedSecret(ScalarOne.privateKey, P256.publicKey(local.bytes(1)))
        sender = AirShieldCipher(AirShieldKeys(secret, local.bytes(2), seed), iv, 42u)
        receiver = AirShieldReceiver(
            AirShieldCipher(AirShieldKeys(secret, challenge, enable.bytes(2)), enable.bytes(3), enable.integer(4).toUInt()),
        )
        startup = requests(output.dropFirst(size))
        if (completeSetup) {
            startup = startup + exchange(0x8001, 0x02001000u, field(1, 1uL) + field(2, repeated(1, 16))).requests
            startup = startup + exchange(3, 0x02000315u, field(1, 1uL) + field(2, 1uL) + field(4, EMPTY)).requests
        }
    }

    fun exchange(channel: Int, kind: UInt, payload: ByteArray = EMPTY, now: Double = 0.0): Exchange {
        val frame = BandWire.frame(channel, listOf(kind), payload)
        val result = session.feed(sender.encrypt(frame), 100 + now)
        return Exchange(result.events, requests(result.outgoing))
    }

    fun send(kind: UInt, payload: ByteArray, now: Double): List<BandEvent> {
        val frame = BandWire.frame(if (kind == 0x02000315u) 0x5 else 0x8010, listOf(kind), payload)
        return session.feed(sender.encrypt(frame), 100 + now).events
    }

    /** Keeps motion flowing: one gyro sample every 10 ms, on the band's clock and the phone's. */
    fun spin(start: Double, end: Double): List<BandEvent> {
        val events = ArrayList<BandEvent>()
        var now = start
        while (now <= end + 1e-9) {
            stamp += 10_000uL
            events += gyro(stamp, now = now)
            now += 0.01
        }
        return events
    }

    fun gyro(stamp: ULong, x: Short = 1000, now: Double): List<BandEvent> =
        send(
            0x0200020fu,
            field(1, stamp) + field(2, stamp) + field(3, x.le() + 0.toShort().le() + 0.toShort().le()),
            now,
        )

    fun gesture(action: ULong, finger: ULong = 2uL, derived: ULong = 0uL, synthetic: ULong = 0uL, now: Double): List<BandEvent> =
        send(
            0x0200020du,
            field(1, 10uL) + field(2, 20uL) + field(3, finger) + field(4, action) + field(5, derived) + field(12, synthetic),
            now,
        )

    fun requests(bytes: ByteArray): List<DataXFrame> = receiver.feed(bytes).flatMap { datax.feed(it) }

    fun handReply(id: ULong, value: ULong?, status: ULong = 1uL, channel: Int = 6, now: Double = 1.0): Exchange {
        val config = (value?.let { field(10, it) } ?: EMPTY) + field(2, 2048uL)
        val payload = field(1, id) + field(2, status) + field(6, config)
        val frame = BandWire.frame(channel, listOf(0x02000315u), payload)
        val result = session.feed(sender.encrypt(frame), 100 + now)
        return Exchange(result.events, requests(result.outgoing))
    }
}

private fun reportedHands(events: List<BandEvent>): List<BandHand> = events.payloads<P.Handedness>().map { it.hand }

private fun engagement(events: List<BandEvent>): List<Boolean> = events.payloads<P.DialState>().map { it.engaged }

private fun movement(events: List<BandEvent>): List<Double> = events.payloads<P.DialTurn>().map { it.delta }

private fun streamReply(id: ULong, raw: ULong = 0uL): ByteArray =
    field(1, id) + field(2, 1uL) + field(5, field(2, raw) + field(3, 1uL) + field(6, 1uL) + field(8, 1uL))

private fun batteryReply(id: ULong, level: ULong = 84uL, charging: ULong? = 1uL): ByteArray {
    var battery = field(1, level)
    if (charging != null) battery += field(2, charging)
    return field(1, id) + field(2, 1uL) + field(3, field(1, battery))
}

/** The band's answer to a stream request: accepted, with these streams now on. */
private fun motionReply(peer: Peer, id: ULong, gyro: Boolean, orientation: Boolean, now: Double): Exchange =
    peer.exchange(
        5,
        0x02000315u,
        field(1, id) + field(2, 1uL) +
            field(5, field(3, 1uL) + field(6, if (gyro) 1uL else 0uL) + field(8, if (orientation) 1uL else 0uL)),
        now,
    )

private data class StreamAsk(val id: ULong, val gesture: ULong, val gyro: ULong, val orientation: ULong)

/** The id and the requested flags of one stream request. */
private fun streamAsk(frame: DataXFrame): StreamAsk {
    val fields = ProtoFields(frame.payload)
    val control = ProtoFields(fields.bytes(4))
    return StreamAsk(fields.integer(1), control.integer(3), control.integer(6), control.integer(8))
}

private fun motionConfirmations(events: List<BandEvent>): List<Pair<MotionStreams, Boolean>> =
    events.payloads<P.MotionStreamsChanged>().map { it.streams to it.accepted }

class BandSessionTest {
    @Test
    fun nativeCryptoMatchesIndependentPythonVectors() {
        val keys = AirShieldKeys(range(0, 32), range(0, 16), range(32, 64))
        assertArrayEquals(hex("5080496832e72e0a4de90f22e7797a3c6277197b4bd29f296bd7142850db1998"), keys.encryption)
        val fixedKeys = AirShieldKeys(encryption = range(0, 32), mac = range(0, 32))
        val first = hex("40c9f748fb0f0ae8e0018675352ee743a1e58ccd288d25d27f6e72551887e4aad6fc68175e7287a1eee1")
        val second = hex("4038cb0decaa0692b900d5962230f8734c8a3de4d262936261f1")
        val receiver = AirShieldReceiver(AirShieldCipher(fixedKeys, range(0, 16), UInt.MAX_VALUE))
        val wire = first + byteArrayOf(0x81.toByte(), 0, 1, 2, 42, 43, 44) + second
        val decoded = ArrayList<ByteArray>()
        for (byte in wire) decoded += receiver.feed(byteArrayOf(byte))
        receiver.finish()
        assertEquals(2, decoded.size)
        assertArrayEquals("first block.....second block....".toByteArray(), decoded[0])
        assertArrayEquals("last block......".toByteArray(), decoded[1])
        assertEquals(1u, receiver.cipher.counter)
        val sender = AirShieldCipher(fixedKeys, range(0, 16), UInt.MAX_VALUE)
        assertArrayEquals(first, sender.encrypt(decoded[0]))
        assertArrayEquals(second, sender.encrypt(decoded[1]))
        for (index in listOf(1, 12)) {
            val corrupted = first.copyOf()
            corrupted[index] = (corrupted[index].toInt() xor 1).toByte()
            val bad = AirShieldReceiver(AirShieldCipher(fixedKeys, range(0, 16), UInt.MAX_VALUE))
            assertThrows(BandProtocolError::class.java) { bad.feed(corrupted) }
            assertEquals(UInt.MAX_VALUE, bad.cipher.counter)
            assertArrayEquals(range(0, 16), bad.cipher.iv)
        }
        val truncated = AirShieldReceiver(AirShieldCipher(fixedKeys, range(0, 16), UInt.MAX_VALUE))
        assertTrue(truncated.feed(first.copyOf(first.size - 1)).isEmpty())
        assertThrows(BandProtocolError::class.java) { truncated.finish() }
    }

    @Test
    fun startupWaitsForItsLinkAndDeviceInfoBeforeOpeningInput() {
        val peer = Peer(completeSetup = false)
        assertEquals(listOf(0x8002, 0x8001), peer.startup.map { it.channel })
        assertTrue(peer.session.tick(106.0).isEmpty())
        val ready = field(1, 1uL) + field(2, repeated(1, 16))
        val unrelated = peer.exchange(0x8003, 0x02001000u, ready)
        assertTrue(unrelated.requests.isEmpty() && unrelated.events.isEmpty())
        val device = peer.exchange(0x8001, 0x02001000u, ready, now = 7.0)
        assertEquals(listOf(0x8003), device.requests.map { it.channel })
        assertTrue(device.events.isEmpty())
        val duplicate = peer.exchange(0x8001, 0x02001000u, ready, now = 7.0)
        assertTrue(duplicate.requests.isEmpty())
        for (channel in listOf(0x8001, 0x8003)) {
            val closed = peer.exchange(channel, 0x01000000u, now = 7.0)
            assertTrue(closed.events.isEmpty() && closed.requests.isEmpty())
        }
        val wrongID = peer.exchange(3, 0x02000315u, field(1, 2uL) + field(2, 1uL), now = 7.0)
        assertTrue(wrongID.requests.isEmpty())
        val accepted = peer.exchange(3, 0x02000315u, field(1, 1uL) + field(2, 1uL) + field(4, EMPTY), now = 7.0)
        assertEquals(listOf(0x8005, 0x8005, 0x8006, 0x8006), accepted.requests.map { it.channel })
        assertTrue(accepted.events.isEmpty() && !peer.session.streamsEnabled)
        val repeatedLink = peer.exchange(0x8001, 0x02001000u, ready, now = 7.0)
        val repeatedDevice = peer.exchange(3, 0x02000315u, field(1, 1uL) + field(2, 1uL) + field(4, EMPTY), now = 7.0)
        assertTrue(repeatedLink.requests.isEmpty() && repeatedLink.events.isEmpty())
        assertTrue(repeatedDevice.requests.isEmpty() && repeatedDevice.events.isEmpty())
        assertTrue(peer.session.tick(108.0).isEmpty())
        assertEquals(listOf(BandHand.RIGHT), reportedHands(peer.handReply(1uL, 0uL, now = 9.0).events))
    }

    @Test
    fun startupIgnoresInputUntilDeviceInfoSucceeds() {
        for (linkReady in listOf(false, true)) {
            val peer = Peer(completeSetup = false)
            if (linkReady) peer.exchange(0x8001, 0x02001000u, field(1, 1uL))
            assertTrue(peer.gyro(1_000_000uL, now = 0.0).isEmpty())
            assertTrue(peer.gesture(1uL, now = 0.01).isEmpty())
            val orientation = field(1, 1uL) + field(2, 1_000_000uL) + field(3, hex("0000000000000000000000000000803f"))
            assertTrue(peer.send(0x02000212u, orientation, now = 0.02).isEmpty())
            val flags = field(3, 1uL) + field(6, 1uL) + field(8, 1uL)
            for (id in listOf(3uL, 5uL)) {
                val premature = peer.exchange(5, 0x02000315u, field(1, id) + field(2, 1uL) + field(5, flags))
                assertTrue(premature.events.isEmpty() && premature.requests.isEmpty())
            }
            assertTrue(!peer.session.streamsEnabled && peer.session.motionMessages == 0)
            assertTrue(peer.session.queryStreamState().isEmpty())
            if (!linkReady) peer.exchange(0x8001, 0x02001000u, field(1, 1uL))
            val device = peer.exchange(3, 0x02000315u, field(1, 1uL) + field(2, 1uL) + field(4, EMPTY))
            assertEquals(listOf(0x8005, 0x8005, 0x8006, 0x8006), device.requests.map { it.channel })
            val enabled = peer.exchange(5, 0x02000315u, field(1, 3uL) + field(2, 1uL) + field(5, flags))
            assertTrue(enabled.events.has<P.Connected>())
            assertTrue(peer.session.streamsEnabled)
            peer.gyro(1_010_000uL, now = 0.03)
            assertEquals(1, peer.session.motionMessages)
        }
    }

    @Test
    fun orientationPreservesTheWireOrderAndDeviceTimestamp() {
        val peer = Peer()
        val payload = field(1, 1uL) + field(2, 1_234_000uL) + field(3, hex("0000003f000000bf0000003f0000003f"))
        val events = peer.send(0x02000212u, payload, now = 101.0)
        val orientation = events.payloads<P.Orientation>().first()
        assertEquals(1_234_000uL, orientation.timestamp)
        assertEquals(Quaternion(0.5, -0.5, 0.5, 0.5), orientation.values)
        assertTrue(events.has<P.DataSeen>())
    }

    @Test
    fun rejectedStartupChannelsFailImmediatelyWithoutReportingReady() {
        val peer = Peer(completeSetup = false)
        peer.exchange(0x8001, 0x02001000u, field(1, 1uL))
        assertThrows(BandProtocolError::class.java) { peer.exchange(3, 0x0300c001u) }
        assertFalse(peer.session.streamsEnabled)
        val subscribing = Peer()
        val unrelated = subscribing.exchange(7, 0x0300c001u)
        assertTrue(unrelated.events.isEmpty() && unrelated.requests.isEmpty())
        assertThrows(BandProtocolError::class.java) { subscribing.exchange(5, 0x0300c001u) }
        assertFalse(subscribing.session.streamsEnabled)
    }

    @Test
    fun stoppingDuringSetupNeverOpensAnInputSubscription() {
        for (linkReady in listOf(false, true)) {
            val peer = Peer(completeSetup = false)
            if (linkReady) peer.exchange(0x8001, 0x02001000u, field(1, 1uL))
            assertTrue(peer.session.stop().isEmpty())
            val late = peer.exchange(0x8001, 0x02001000u, field(1, 1uL))
            assertTrue(late.events.isEmpty() && late.requests.isEmpty())
            val device = peer.exchange(3, 0x02000315u, field(1, 1uL) + field(2, 1uL) + field(4, EMPTY))
            assertTrue(device.events.isEmpty() && device.requests.isEmpty())
            for (channel in listOf(3, 5)) {
                val closed = peer.exchange(channel, 0x0300c001u)
                assertTrue(closed.events.isEmpty() && closed.requests.isEmpty())
            }
            assertFalse(peer.session.streamsEnabled)
        }
    }

    @Test
    fun nativeHandSelectionWritesOnlyHandednessAndChecksAnIndependentReadback() {
        for (selected in listOf(BandHand.LEFT, BandHand.RIGHT)) {
            val peer = Peer()
            val initial = if (selected == BandHand.LEFT) 0uL else 1uL
            val desired = if (selected == BandHand.LEFT) 1uL else 0uL
            val query = peer.startup[peer.startup.size - 2]
            assertEquals(0x8006, query.channel)
            assertEquals(listOf(0x8100ce56u, 0x02000314u), query.words)
            assertArrayEquals(hex("08012a00"), query.payload)
            val active = peer.startup.last()
            assertEquals(0x8006, active.channel)
            assertTrue(active.words.isEmpty())
            assertArrayEquals(field(1, 1uL shl 20) + field(5, field(6, 2uL)), active.payload)
            assertThrows(BandProtocolError::class.java) { peer.session.setHandedness(selected, 100.0) }
            val read = peer.handReply(1uL, initial)
            assertEquals(listOf(if (selected == BandHand.LEFT) BandHand.RIGHT else BandHand.LEFT), reportedHands(read.events))
            assertTrue(read.requests.isEmpty())
            peer.send(
                0x02000315u,
                field(1, 3uL) + field(2, 1uL) + field(5, field(3, 1uL) + field(6, 1uL) + field(8, 1uL)),
                now = 1.0,
            )
            val request = peer.requests(peer.session.setHandedness(selected, 101.0))
            assertEquals(1, request.size)
            assertTrue(request[0].channel == 0x8006 && request[0].words.isEmpty())
            assertArrayEquals(byteArrayOf(0x08, 0x02, 0x2a, 0x02, 0x50, desired.toByte()), request[0].payload)
            assertThrows(BandProtocolError::class.java) { peer.session.setHandedness(selected, 101.0) }
            val stale = peer.handReply(1uL, desired)
            assertTrue(reportedHands(stale.events).isEmpty() && stale.requests.isEmpty())
            val wrongChannel = peer.handReply(2uL, desired, channel = 7)
            assertTrue(reportedHands(wrongChannel.events).isEmpty() && wrongChannel.requests.isEmpty())
            val written = peer.handReply(2uL, desired, now = 2.0)
            assertTrue(reportedHands(written.events).isEmpty())
            assertEquals(1, written.requests.size)
            assertEquals(0x8006, written.requests[0].channel)
            assertArrayEquals(hex("08032a00"), written.requests[0].payload)
            val confirmed = peer.handReply(3uL, desired, now = 3.0)
            assertEquals(listOf(selected), reportedHands(confirmed.events))
            assertEquals(selected, peer.session.hand)
            assertTrue(confirmed.requests.isEmpty())
        }
    }

    @Test
    fun nativeHandReadRejectsMissingInvalidAndLateValues() {
        for (value in listOf(null, 2uL)) {
            val peer = Peer()
            val result = peer.handReply(1uL, value)
            assertTrue(reportedHands(result.events).isEmpty())
            assertTrue(result.events.has<P.HandednessFailure>())
            assertNull(peer.session.hand)
        }
        val peer = Peer()
        val expired = peer.session.tick(106.0)
        assertTrue(expired.has<P.HandednessFailure>())
        val late = peer.handReply(1uL, 1uL, now = 7.0)
        assertTrue(reportedHands(late.events).isEmpty() && late.requests.isEmpty())
        assertNull(peer.session.hand)
        val unticked = Peer()
        val delayed = unticked.handReply(1uL, 1uL, now = 7.0)
        assertTrue(reportedHands(delayed.events).isEmpty() && delayed.requests.isEmpty())
        assertTrue(delayed.events.has<P.HandednessFailure>())
        assertNull(unticked.session.hand)
    }

    @Test
    fun nativeHandWriteRejectionAndMismatchedReadbackNeverConfirmTheRequestedHand() {
        for (rejected in listOf(true, false)) {
            val peer = Peer()
            peer.handReply(1uL, 0uL)
            peer.send(
                0x02000315u,
                field(1, 3uL) + field(2, 1uL) + field(5, field(3, 1uL) + field(6, 1uL) + field(8, 1uL)),
                now = 1.0,
            )
            peer.requests(peer.session.setHandedness(BandHand.LEFT, 101.0))
            val write = peer.handReply(2uL, 1uL, status = if (rejected) 2uL else 1uL, now = 2.0)
            val result = if (rejected) write else peer.handReply(3uL, 0uL, now = 3.0)
            assertFalse(reportedHands(result.events).contains(BandHand.LEFT))
            assertTrue(result.events.has<P.HandednessFailure>())
            assertTrue(result.requests.isEmpty())
            assertTrue(peer.session.hand != BandHand.LEFT)
        }
    }

    @Test
    fun nativeHandshakeSubscribesAndStopsTheSameStreamsOnTheSameChannel() {
        val peer = Peer()
        assertEquals(listOf(0x8002, 0x8001, 0x8003, 0x8005, 0x8005, 0x8006, 0x8006), peer.startup.map { it.channel })
        assertEquals(listOf(0x81000024u, 0x02003000u), peer.startup[0].words)
        assertEquals(listOf(0x02001000u), peer.startup[1].words)
        val end = ProtoFields(peer.startup[1].payload)
        assertEquals(1uL, end.integer(1))
        assertEquals(16, end.bytes(2).size)
        assertEquals(listOf(0x8100ce56u, 0x02000314u), peer.startup[3].words)
        assertTrue(peer.startup[4].words.isEmpty())
        val enabled = ProtoFields(ProtoFields(peer.startup[4].payload).bytes(4))
        for (field in listOf(3, 6, 8)) assertEquals(1uL, enabled.integer(field))
        assertFalse(enabled.contains(2))
        val frame = peer.requests(peer.session.stop()).first()
        assertEquals(0x8005, frame.channel)
        assertTrue(frame.words.isEmpty())
        val request = ProtoFields(frame.payload)
        assertEquals(4uL, request.integer(1))
        val disabled = ProtoFields(request.bytes(4))
        for (field in listOf(3, 6, 8)) assertEquals(0uL, disabled.requiredInteger(field))
        val partial = field(1, 4uL) + field(2, 1uL) + field(5, field(3, 0uL))
        peer.send(0x02000315u, partial, now = 1.0)
        assertFalse(peer.session.stopAcknowledged)
        val complete = field(1, 4uL) + field(2, 1uL) + field(5, field(3, 0uL) + field(6, 0uL) + field(8, 0uL))
        peer.send(0x02000315u, complete, now = 2.0)
        assertTrue(peer.session.stopAcknowledged)
        assertTrue(peer.gesture(1uL, now = 3.0).isEmpty())
        assertTrue(peer.session.stop().isEmpty())
    }

    @Test
    fun lateSubscriptionRepliesDoNotInterruptShutdown() {
        val enabled = field(3, 1uL) + field(6, 1uL) + field(8, 1uL)
        val disabled = field(3, 0uL) + field(6, 0uL) + field(8, 0uL)
        val replies = listOf(
            field(2, 1uL) + field(5, enabled),
            field(2, 2uL),
            field(2, 1uL) + field(5, disabled),
        )
        for (requestID in listOf(3uL, 5uL)) {
            for (reply in replies) {
                val peer = Peer()
                if (requestID == 5uL) {
                    val ready = peer.exchange(5, 0x02000315u, field(1, 3uL) + field(2, 1uL) + field(5, enabled))
                    assertTrue(ready.events.has<P.Connected>())
                    val query = peer.requests(peer.session.queryStreamState())
                    assertTrue(query.isNotEmpty())
                }
                assertEquals(requestID == 5uL, peer.session.streamsEnabled)
                val stop = peer.requests(peer.session.stop())
                assertTrue(stop.isNotEmpty() && !peer.session.stopAcknowledged)
                val late = BandWire.frame(5, listOf(0x02000315u), field(1, requestID) + reply)
                val stopAck = BandWire.frame(5, payload = field(1, 4uL) + field(2, 1uL) + field(5, disabled))
                // A late reply must not prevent the following stop acknowledgement in the same record.
                val result = peer.session.feed(peer.sender.encrypt(late + stopAck), 101.0)
                assertTrue(result.events.isEmpty() && result.outgoing.isEmpty())
                assertEquals(requestID == 5uL, peer.session.streamsEnabled)
                assertTrue(peer.session.stopAcknowledged)
                assertTrue(peer.session.queryStreamState().isEmpty())
                assertTrue(peer.session.stop().isEmpty())
            }
        }
    }

    @Test
    fun encryptedGyroExposesAllThreeSignedAxesWithoutChangingSubscriptions() {
        val peer = Peer()
        val payload = field(1, 7uL) + field(2, 1_234_567uL) +
            field(3, (-123).toShort().le() + 456.toShort().le() + (-789).toShort().le())
        val events = peer.send(0x0200020fu, payload, now = 1.0)
        val event = events.first { it.payload is P.Gyro }
        val gyro = event.payload as P.Gyro
        assertEquals(1_234_567uL, gyro.timestamp)
        assertEquals(Vector3(-123.0, 456.0, -789.0), gyro.values)
        assertEquals(101.0, event.receivedAt, 0.0)
    }

    @Test
    fun encryptedInputDrivesTheDialAndReleasesOnMotionLoss() {
        val peer = Peer()
        val first = peer.gyro(1_000_000uL, now = 0.0)
        assertTrue(first.has<P.Connected>())
        assertTrue(first.has<P.Heartbeat>())
        assertTrue(engagement(peer.gesture(1uL, synthetic = 1uL, now = 0.01)).isEmpty())
        val press = peer.gesture(1uL, now = 0.02)
        // A press alone never arms the dial. A tap is over before a hold begins.
        assertTrue(engagement(press).isEmpty())
        val gesture = (press[0].payload as P.Gesture).gesture
        assertTrue(gesture.finger == "index" && gesture.action == "press" && !gesture.synthetic)
        assertTrue(gesture.sequence == 10uL && gesture.timestampUs == 20uL && gesture.receivedAt == 100.02)
        assertTrue(engagement(peer.gesture(0uL, derived = 9uL, now = 0.021)).isEmpty())
        // Held with motion flowing, it arms once the pinch has outlasted a tap, and turns from there.
        val held = peer.spin(0.03, 0.22)
        assertEquals(listOf(true), engagement(held))
        // Turns are coalesced to one per 20 ms, so the count is not the point. The first one is.
        val turn = movement(held)
        assertTrue(turn.isNotEmpty())
        assertTrue(abs(turn.first() - 0.7) < 1e-9)
        // Motion stops arriving: the dial lets go.
        assertEquals(listOf(false), engagement(peer.session.tick(100.6)))
        assertTrue(movement(peer.spin(0.61, 0.61)).isEmpty())
        // A gap in the band's own clock lets go too.
        assertTrue(engagement(peer.gesture(1uL, now = 0.62)).isEmpty())
        assertEquals(listOf(true), engagement(peer.spin(0.63, 0.82)))
        peer.stamp += 1_000_000uL
        assertEquals(listOf(false), engagement(peer.spin(0.83, 0.83)))
        assertTrue(movement(peer.spin(0.84, 0.84)).isEmpty())
        // So does the release.
        assertTrue(engagement(peer.gesture(1uL, now = 0.85)).isEmpty())
        assertEquals(listOf(true), engagement(peer.spin(0.86, 1.05)))
        assertEquals(listOf(false), engagement(peer.gesture(2uL, now = 1.06)))
        assertTrue(movement(peer.spin(1.07, 1.07)).isEmpty())
    }

    @Test
    fun theTwoPressesOfADoubleTapNeverArmTheDial() {
        val peer = Peer()
        peer.spin(0.0, 0.02)
        val events = ArrayList<BandEvent>()
        // Two quick pinches with the wrist moving the whole time.
        for (start in listOf(0.03, 0.22)) {
            events += peer.gesture(1uL, now = start)
            events += peer.spin(start + 0.01, start + 0.12)
            events += peer.gesture(2uL, now = start + 0.13)
            events += peer.spin(start + 0.14, start + 0.18)
        }
        assertTrue(engagement(events).isEmpty() && movement(events).isEmpty())
        // The same pinch, held, does arm.
        val held = peer.gesture(1uL, now = 0.5) + peer.spin(0.51, 0.75)
        assertTrue(engagement(held) == listOf(true) && movement(held).isNotEmpty())
    }

    @Test
    fun nativeFramingPreservesSplitMessagesAndRejectsMalformedInput() {
        val receiver = DataXReceiver()
        val payload = range(0, 40)
        val frame = BandWire.frame(0x8005, listOf(0x0200020du), payload)
        val head = frame.copyOfRange(0, 13) + repeated(0xc3, 3)
        assertTrue(receiver.feed(head).isEmpty())
        val tail = frame.dropFirst(13) + repeated(0xcd, 13)
        val frames = receiver.feed(tail)
        assertEquals(listOf(0x8005), frames.map { it.channel })
        assertEquals(listOf(0x0200020du), frames.first().words)
        assertArrayEquals(payload, frames.first().payload)
        assertThrows(BandProtocolError::class.java) { ProtoFields(byteArrayOf(0x08, 0x80.toByte())) }
        assertThrows(BandProtocolError::class.java) { ProtoFields(byteArrayOf(0x08, 1, 0x08, 2)).requiredInteger(1) }
        assertThrows(BandProtocolError::class.java) { ProtoFields(byteArrayOf(0x1a, 12, 1)) }
        val session = BandSession()
        assertThrows(BandProtocolError::class.java) { session.feed(byteArrayOf(0, 0, 0, 0), 0.0) }
    }

    @Test
    fun aQuietBandStaysConnectedThroughAcknowledgedStatusQueries() {
        val peer = Peer()
        val flags = field(3, 1uL) + field(6, 1uL) + field(8, 1uL)
        fun status(id: ULong) = field(1, id) + field(2, 1uL) + field(5, flags)
        val started = peer.send(0x02000315u, status(3uL), now = 0.0)
        assertTrue(started.has<P.Connected>())
        assertTrue(started.has<P.Heartbeat>())
        assertTrue(peer.session.streamsEnabled)
        assertEquals(0, peer.session.motionMessages)
        val frame = peer.requests(peer.session.queryStreamState()).first()
        assertTrue(frame.channel == 0x8005 && frame.words.isEmpty())
        val fields = ProtoFields(frame.payload)
        assertEquals(5uL, fields.integer(1))
        assertTrue(fields.bytes(4).isEmpty())
        val reply = peer.send(0x02000315u, status(5uL), now = 2.0)
        assertTrue(reply.has<P.Heartbeat>())
        assertFalse(reply.has<P.Connected>())
        assertTrue(movement(reply).isEmpty())
        peer.session.stop()
        assertTrue(peer.session.queryStreamState().isEmpty())
    }

    @Test
    fun startupMotionDoesNotTurnAnOldPressIntoANewPinch() {
        val peer = Peer()
        assertTrue(engagement(peer.gesture(1uL, now = 0.0)).isEmpty())
        peer.gyro(1_000_000uL, now = 0.01)
        assertTrue(engagement(peer.gesture(0uL, derived = 9uL, now = 0.02)).isEmpty())
        assertTrue(movement(peer.gyro(1_010_000uL, now = 0.03)).isEmpty())
        // Held long past the arming delay, the old press still never becomes a pinch.
        peer.stamp = 1_010_000uL
        val stale = peer.spin(0.04, 0.3)
        assertTrue(engagement(stale).isEmpty() && movement(stale).isEmpty())
        peer.gesture(2uL, now = 0.31)
        // A press made while motion is flowing does.
        assertTrue(engagement(peer.gesture(1uL, now = 0.32)).isEmpty())
        val fresh = peer.spin(0.33, 0.55)
        assertTrue(engagement(fresh) == listOf(true) && movement(fresh).isNotEmpty())
    }

    @Test
    fun unknownRepeatedFieldsDoNotBreakKnownGestureMessages() {
        val peer = Peer()
        val payload = field(1, 42uL) + field(2, 1000uL) + field(3, 1uL) + field(4, 8uL) + field(99, 1uL) + field(99, 2uL)
        val events = peer.send(0x0200020du, payload, now = 0.0)
        val gesture = (events.first().payload as P.Gesture).gesture
        assertTrue(gesture.finger == "thumb" && gesture.action == "left")
        assertTrue(gesture.sequence == 42uL && gesture.timestampUs == 1000uL)
        assertTrue(peer.send(0x0200020du, payload + field(1, 43uL), now = 1.0).isEmpty())
    }

    @Test
    fun rejectedSubscriptionsFailWithoutReportingAReadyConnection() {
        val peer = Peer()
        assertThrows(BandProtocolError::class.java) {
            peer.send(0x02000315u, field(1, 3uL) + field(2, 2uL), now = 0.0)
        }
        assertFalse(peer.session.streamsEnabled)
    }

    @Test
    fun anotherRPCChannelCannotAcknowledgeTheInputSubscription() {
        for (channel in listOf(7, 0x8005)) {
            val peer = Peer()
            val flags = field(3, 1uL) + field(6, 1uL) + field(8, 1uL)
            val payload = field(1, 3uL) + field(2, 1uL) + field(5, flags)
            val unrelated = peer.exchange(channel, 0x02000315u, payload)
            assertTrue(unrelated.events.isEmpty() && unrelated.requests.isEmpty())
            assertFalse(peer.session.streamsEnabled)
            val accepted = peer.exchange(5, 0x02000315u, payload)
            assertTrue(accepted.events.has<P.Connected>())
            assertTrue(peer.session.streamsEnabled)
        }
    }

    @Test
    fun batteryStatusReadsChargingWithoutChangingTheSensorSubscription() {
        val peer = Peer()
        peer.exchange(5, 0x02000315u, streamReply(3uL))
        val query = peer.requests(peer.session.queryBatteryStatus(100.0)).first()
        assertTrue(query.channel == 0x8008 && query.words == listOf(0x8100ce56u, 0x02000314u))
        assertArrayEquals(hex("08011200"), query.payload)
        assertTrue(peer.session.queryBatteryStatus(101.0).isEmpty())
        val unrelated = peer.exchange(8, 0x02000315u, batteryReply(9uL))
        assertFalse(unrelated.events.has<P.BatteryStatus>())
        val charged = peer.exchange(8, 0x02000315u, batteryReply(1uL))
        assertTrue(charged.events.payloads<P.BatteryStatus>().any { it.status == BandBatteryStatus(84, true) })
        val next = peer.requests(peer.session.queryBatteryStatus(105.0)).first()
        assertTrue(next.channel == 0x8008 && next.words.isEmpty())
        val off = peer.exchange(8, 0x02000315u, batteryReply(2uL, charging = 0uL), now = 5.0)
        assertTrue(off.events.payloads<P.BatteryStatus>().any { it.status?.charging == false })
        assertTrue(peer.session.streamsEnabled)
    }

    @Test
    fun unavailableBatteryStatusNeverBreaksGestures() {
        val peer = Peer()
        peer.exchange(5, 0x02000315u, streamReply(3uL))
        peer.requests(peer.session.queryBatteryStatus(100.0))
        assertTrue(peer.session.tick(104.0).payloads<P.BatteryStatus>().any { it.status == null })
        peer.requests(peer.session.queryBatteryStatus(105.0))
        val rejected = peer.exchange(8, 0x0300c001u, now = 5.0)
        assertTrue(rejected.events.payloads<P.BatteryStatus>().any { it.status == null })
        assertTrue(peer.session.queryBatteryStatus(110.0).isEmpty())
        assertTrue(peer.session.streamsEnabled)
        assertTrue(peer.gyro(1_000_000uL, now = 10.0).has<P.DataSeen>())
    }

    @Test
    fun batteryDecoderRejectsInvalidValuesAndKeepsAnAbsentChargingFlagUnknown() {
        assertNull(BandBatteryStatus(response = batteryReply(1uL, charging = null)).charging)
        assertThrows(BandProtocolError::class.java) { BandBatteryStatus(response = batteryReply(1uL, level = 101uL)) }
        assertThrows(BandProtocolError::class.java) { BandBatteryStatus(response = batteryReply(1uL, charging = 2uL)) }
        val truncated = batteryReply(1uL).let { it.copyOf(it.size - 1) }
        assertThrows(BandProtocolError::class.java) { BandBatteryStatus(response = truncated) }
    }

    @Test
    fun motionStreamsSwitchWhileConnectedAndRestartOnRequest() {
        val peer = Peer()
        motionReply(peer, 3uL, gyro = true, orientation = true, now = 1.0)
        assertTrue(peer.session.streamsEnabled && peer.session.motionStreams == MotionStreams.ALL)
        // Orientation off: gestures and gyro stay on, and every flag is explicit.
        val off = peer.requests(peer.session.setMotionStreams(MotionStreams(gyro = true, orientation = false), 101.0))
        val ask = streamAsk(off.first())
        assertTrue(off.size == 1 && off[0].channel == 0x8005)
        assertTrue(ask.gesture == 1uL && ask.gyro == 1uL && ask.orientation == 0uL)
        // A second change waits until the first is answered.
        assertTrue(peer.session.setMotionStreams(MotionStreams.ALL, 101.0).isEmpty())
        val answered = motionReply(peer, ask.id, gyro = true, orientation = false, now = 2.0)
        assertEquals(listOf(true), motionConfirmations(answered.events).map { it.second })
        assertEquals(MotionStreams(gyro = true, orientation = false), peer.session.motionStreams)
        // With orientation off, a status reply without it is still a live subscription.
        motionReply(peer, 5uL, gyro = true, orientation = false, now = 2.0)
        assertTrue(peer.session.streamsEnabled)
        val back = peer.requests(peer.session.flushMotion(102.0))
        val backAsk = streamAsk(back.first())
        assertTrue(backAsk.orientation == 1uL && backAsk.gyro == 1uL)
        motionReply(peer, backAsk.id, gyro = true, orientation = true, now = 3.0)
        assertEquals(MotionStreams.ALL, peer.session.motionStreams)
        // A restart turns motion off, and on again as soon as the band confirms.
        val restart = peer.requests(peer.session.restartMotionStreams(103.0))
        val offAsk = streamAsk(restart.first())
        assertTrue(offAsk.gyro == 0uL && offAsk.orientation == 0uL && offAsk.gesture == 1uL)
        val quiet = motionReply(peer, offAsk.id, gyro = false, orientation = false, now = 4.0)
        val onAsk = streamAsk(quiet.requests.first())
        assertTrue(onAsk.gyro == 1uL && onAsk.orientation == 1uL)
        motionReply(peer, onAsk.id, gyro = true, orientation = true, now = 5.0)
        assertEquals(MotionStreams.ALL, peer.session.motionStreams)
        // A band that never answers is given up on, so the next change can go out.
        val lost = peer.requests(peer.session.setMotionStreams(MotionStreams.NONE, 106.0))
        assertEquals(1, lost.size)
        assertEquals(listOf(false), motionConfirmations(peer.session.tick(114.5)).map { it.second })
        assertEquals(1, peer.requests(peer.session.setMotionStreams(MotionStreams.NONE, 115.0)).size)
    }

    @Test
    fun aSubscriptionAsksOnlyForTheWantedMotionAndStopTurnsEverythingOff() {
        val peer = Peer(completeSetup = false)
        // Set before the subscription: it simply asks for less.
        assertTrue(peer.session.setMotionStreams(MotionStreams(gyro = true, orientation = false), 100.0).isEmpty())
        val ready = field(1, 1uL) + field(2, repeated(1, 16))
        peer.exchange(0x8001, 0x02001000u, ready)
        val opened = peer.exchange(3, 0x02000315u, field(1, 1uL) + field(2, 1uL) + field(4, EMPTY))
        val subscribe = opened.requests.first {
            try {
                ProtoFields(it.payload).integer(1) == 3uL
            } catch (e: BandProtocolError) {
                false
            }
        }
        val ask = streamAsk(subscribe)
        assertTrue(ask.gesture == 1uL && ask.gyro == 1uL && ask.orientation == 0uL)
        motionReply(peer, 3uL, gyro = true, orientation = false, now = 1.0)
        assertTrue(peer.session.streamsEnabled)
        val stop = streamAsk(peer.requests(peer.session.stop()).first())
        assertTrue(stop.id == 4uL && stop.gesture == 0uL && stop.gyro == 0uL && stop.orientation == 0uL)
    }

    @Test
    fun aRestartQueuedBehindAnUnansweredChangeStillGoesOut() {
        val peer = Peer()
        motionReply(peer, 3uL, gyro = true, orientation = true, now = 1.0)
        // A change goes out and is never answered. A restart asked for meanwhile waits.
        val first = peer.requests(peer.session.setMotionStreams(MotionStreams(gyro = true, orientation = false), 100.0))
        assertEquals(1, first.size)
        assertTrue(peer.session.restartMotionStreams(101.0).isEmpty())
        // The unanswered change is given up. The restart must not be given up with it.
        assertEquals(listOf(false), motionConfirmations(peer.session.tick(108.5)).map { it.second })
        val off = peer.requests(peer.session.flushMotion(109.0))
        val offAsk = streamAsk(off.first())
        assertTrue(offAsk.gyro == 0uL && offAsk.orientation == 0uL)
        // Once off, it comes back on as the unanswered change asked: gyro without orientation.
        val quiet = motionReply(peer, offAsk.id, gyro = false, orientation = false, now = 110.0)
        val onAsk = streamAsk(quiet.requests.first())
        assertTrue(onAsk.gyro == 1uL && onAsk.orientation == 0uL)
    }

}
