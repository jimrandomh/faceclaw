// Ported from callbacked/kinesis (MIT, Copyright (c) 2026 callbacked): Tests/KinesisCoreTests/EnrolledIdentityTests.swift.
package com.faceclaw.app.neuralband

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

private fun field(number: Int, value: ULong) = BandWire.field(number, value)
private fun field(number: Int, bytes: ByteArray) = BandWire.field(number, bytes)

/**
 * A synthetic enrolled band. Its transport key uses public P-256 scalar 1 and
 * every identity key is generated in the test.
 */
private class EnrolledPeer(bandKeyInRecord: Boolean = true) {
    val appKey = P256.Signing.PrivateKey()
    val bandKey = P256.Signing.PrivateKey()
    val session = BandSession(
        enrollment = BandEnrollmentIdentity(appKey, if (bandKeyInRecord) bandKey.publicKey else null),
    )
    val sender: AirShieldCipher
    val receiver: AirShieldReceiver
    val datax = DataXReceiver()
    val hostPoint: ByteArray
    val hostChallenge: ByteArray
    val bandPoint = ScalarOne.point
    val bandChallenge = range(0, 16)
    val bandSeed = range(0, 32)

    init {
        val request = session.request()
        val local = ProtoFields(request.dropFirst(12))
        hostPoint = local.bytes(1)
        hostChallenge = local.bytes(2)
        val iv = range(16, 32)
        val peerRequest = BandWire.frame(
            0x8001,
            listOf(0x81000005u, 0x02000001u),
            field(1, bandPoint) + field(2, bandChallenge) + field(3, 0uL) + field(4, 3uL),
        )
        val peerEnable = BandWire.frame(
            1,
            listOf(0x02000002u),
            field(1, bandPoint) + field(2, bandSeed) + field(3, iv) + field(4, 42uL) + field(5, 3uL),
        )
        var output = ByteArray(0)
        for (byte in peerRequest + peerEnable) output += session.feed(byteArrayOf(byte), 100.0).outgoing
        val size = (output.be16(0) and 0x7fff) + 4
        val enable = ProtoFields(output.copyOfRange(8, size))
        val secret = P256.sharedSecret(ScalarOne.privateKey, P256.publicKey(hostPoint))
        sender = AirShieldCipher(AirShieldKeys(secret, hostChallenge, bandSeed), iv, 42u)
        receiver = AirShieldReceiver(
            AirShieldCipher(AirShieldKeys(secret, bandChallenge, enable.bytes(2)), enable.bytes(3), enable.integer(4).toUInt()),
        )
        val frames = requests(output.dropFirst(size))
        // Enrolled startup replaces the empty identity query with one EnableTrust proof.
        assertEquals(1, frames.size)
        val proof = frames.first()
        assertEquals(0x8002, proof.channel)
        assertEquals(listOf(0x81000024u, 0x02001000u), proof.words)
        val fields = ProtoFields(proof.payload)
        assertArrayEquals(sha256(appKey.publicKey.rawRepresentation), fields.bytes(1))
        // Independently rebuild the confirmed transcript and verify the proof.
        val message = transcript(bandChallenge, bandPoint, enable.bytes(2), hostPoint)
        assertTrue(appKey.publicKey.isValidSignature(fields.bytes(2, 64), message))
    }

    fun send(frame: ByteArray): List<DataXFrame> = requests(session.feed(sender.encrypt(frame), 100.0).outgoing)

    fun requests(bytes: ByteArray): List<DataXFrame> = receiver.feed(bytes).flatMap { datax.feed(it) }

    /** The band's EnableTrustEC proof over the host transcript. */
    fun proof(signingKey: P256.Signing.PrivateKey? = null): ByteArray {
        val signature = (signingKey ?: bandKey).signature(transcript(hostChallenge, hostPoint, bandSeed, bandPoint))
        return BandWire.frame(
            0x8003,
            listOf(0x81000024u, 0x02001001u),
            field(1, repeated(7, 12)) + field(2, signature) + field(3, 1uL),
        )
    }

    fun result(code: UInt): ByteArray = BandWire.frame(2, listOf(code))

    companion object {
        /**
         * The input of SHA256(SHA256(receiver challenge || receiver key) || SHA256(sender seed || sender key));
         * SHA256withECDSA over it signs that digest.
         */
        fun transcript(challenge: ByteArray, receiver: ByteArray, seed: ByteArray, sender: ByteArray): ByteArray =
            sha256(challenge + receiver) + sha256(seed + sender)
    }
}

class EnrolledIdentityTest {
    @Test
    fun enrolledStartupVerifiesBothTrustDirectionsBeforeLinkSetup() {
        for (proofFirst in listOf(false, true)) {
            val peer = EnrolledPeer()
            val first: List<DataXFrame>
            val second: List<DataXFrame>
            if (proofFirst) {
                first = peer.send(peer.proof())
                second = peer.send(peer.result(0x03001000u))
                // The band proof is acknowledged at once, but link setup waits for the result.
                assertEquals(listOf(listOf(0x03001000u)), first.map { it.words })
                assertEquals(listOf(3), first.map { it.channel })
                val end = second.first()
                assertTrue(second.size == 1 && end.channel == 0x8001 && end.words == listOf(0x02001000u))
            } else {
                first = peer.send(peer.result(0x03001000u))
                second = peer.send(peer.proof())
                assertTrue(first.isEmpty())
                assertEquals(2, second.size)
                assertEquals(3, second.first().channel)
                assertEquals(listOf(0x03001000u), second.first().words)
                val end = second.last()
                assertTrue(end.channel == 0x8001 && end.words == listOf(0x02001000u))
            }
            val endFields = ProtoFields((if (proofFirst) second.first() else second.last()).payload)
            assertEquals(1uL, endFields.integer(1))
            assertEquals(16, endFields.bytes(2).size)
            // The band's link-setup acknowledgement reopens the shared startup flow.
            val endAck = peer.send(
                BandWire.frame(0x8001, listOf(0x02001000u), field(1, 1uL) + field(2, repeated(1, 16))),
            )
            assertEquals(1, endAck.size)
            assertEquals(0x8003, endAck.first().channel)
            val info = peer.send(BandWire.frame(3, listOf(0x02000315u), field(1, 1uL) + field(2, 1uL) + field(4, EMPTY)))
            assertEquals(listOf(0x8005, 0x8005, 0x8006, 0x8006), info.map { it.channel })
            val flags = field(3, 1uL) + field(6, 1uL) + field(8, 1uL)
            val enabled = peer.send(BandWire.frame(5, listOf(0x02000315u), field(1, 3uL) + field(2, 1uL) + field(5, flags)))
            assertTrue(enabled.isEmpty())
            assertTrue(peer.session.streamsEnabled)
        }
    }

    @Test
    fun aDifferentKeyRejectionSurfacesTheIdentityError() {
        val peer = EnrolledPeer()
        try {
            peer.send(peer.result(0x03001043u))
            fail("A different-key rejection must fail the session")
        } catch (error: BandIdentityMismatchError) {
            assertTrue(error.message.contains("band enrolled to a different key"))
        }
        assertFalse(peer.session.streamsEnabled)
    }

    @Test
    fun aBandProofFromTheWrongKeyIsNeverAcknowledged() {
        val peer = EnrolledPeer()
        assertTrue(peer.send(peer.result(0x03001000u)).isEmpty())
        assertThrows(BandProtocolError::class.java) { peer.send(peer.proof(P256.Signing.PrivateKey())) }
        // The rejected proof left no acknowledgement or link setup behind.
        val retried = peer.send(peer.proof())
        assertEquals(listOf(listOf(0x03001000u), listOf(0x02001000u)), retried.map { it.words })
    }

    @Test
    fun anUnverifiableBandProofIsAcceptedWhenNoRecordIsStored() {
        val peer = EnrolledPeer(bandKeyInRecord = false)
        assertTrue(peer.send(peer.result(0x03001000u)).isEmpty())
        // Signed by a key that matches no stored record; band acceptance is what matters.
        val frames = peer.send(peer.proof(P256.Signing.PrivateKey()))
        assertEquals(listOf(listOf(0x03001000u), listOf(0x02001000u)), frames.map { it.words })
    }

    @Test
    fun legacyStartupNeverChangesWithoutAnIdentity() {
        val session = BandSession()
        session.request()
        val point = ScalarOne.point
        val peerRequest = BandWire.frame(
            0x8001,
            listOf(0x81000005u, 0x02000001u),
            field(1, point) + field(2, range(0, 16)) + field(3, 0uL) + field(4, 3uL),
        )
        val peerEnable = BandWire.frame(
            1,
            listOf(0x02000002u),
            field(1, point) + field(2, range(0, 32)) + field(3, range(16, 32)) + field(4, 42uL) + field(5, 3uL),
        )
        var output = ByteArray(0)
        for (byte in peerRequest + peerEnable) output += session.feed(byteArrayOf(byte), 100.0).outgoing
        // Without an identity the legacy wire shape stays: an empty identity query
        // and EndLinkSetup, two encrypted frames instead of one EnableTrust proof.
        var records = 0
        var outgoing = output.dropFirst((output.be16(0) and 0x7fff) + 4)
        while (outgoing.size >= 10 && outgoing[0] == 0x40.toByte()) {
            val size = 10 + ((outgoing[9].toInt() and 0xff) + 1) * 16
            if (outgoing.size < size) break
            records += 1
            outgoing = outgoing.dropFirst(size)
        }
        assertTrue(records == 2 && outgoing.isEmpty())
    }

}
