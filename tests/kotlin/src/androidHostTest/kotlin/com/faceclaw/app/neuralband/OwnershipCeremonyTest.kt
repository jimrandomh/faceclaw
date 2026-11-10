// Ported from callbacked/kinesis (MIT, Copyright (c) 2026 callbacked): Tests/KinesisCoreTests/OwnershipCeremonyTests.swift.
package com.faceclaw.app.neuralband

import com.faceclaw.app.neuralband.BandEvent.Payload as P
import java.util.UUID
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

private fun field(number: Int, value: ULong) = BandWire.field(number, value)
private fun field(number: Int, bytes: ByteArray) = BandWire.field(number, bytes)

private val deviceCertificate = repeated(1, 967)
private val secondaryCertificate = repeated(2, 889)
private const val SERIAL = "TESTSERIAL0001"
private val nonce = range(0, 16)

private fun identityResponsePayload(): ByteArray =
    field(1, deviceCertificate) + field(2, SERIAL.toByteArray()) + field(5, secondaryCertificate)

private fun identityResponse(): ByteArray = BandWire.frame(2, listOf(0x02003001u), identityResponsePayload())

// The captured response payload is exactly 0a10 followed by the 16-byte nonce.
private fun skipChallengeResponsePayload(nonce: ByteArray): ByteArray = byteArrayOf(0x0a, 0x10) + nonce

private fun skipChallengeResponse(nonce: ByteArray): ByteArray =
    BandWire.frame(2, listOf(0x02002001u), skipChallengeResponsePayload(nonce))

private val pendingSignature = byteArrayOf(0x30, 0x45, 0x02, 0x20) + repeated(3, 67)
private const val PENDING_RECEIPT = """{"serial":"TESTSERIAL0001","receipt_type":"ServerPendingOwnershipReceipt"}"""
private val deviceSignature = byteArrayOf(0x30, 0x46, 0x02, 0x21) + repeated(4, 66)
private const val DEVICE_RECEIPT = """{"receipt_type":"DevicePendingOwnershipReceipt","additional_data":"{}"}"""
private val finalSignature = byteArrayOf(0x30, 0x45, 0x02, 0x21) + repeated(5, 67)
private const val FINAL_RECEIPT = """{"receipt_type":"ServerFinalOwnershipReceipt"}"""

private fun ceremony(bandID: String = "TEST", store: BandIdentityStore = InMemoryBandIdentityStore()) =
    OwnershipCeremony(bandID, store)

/** A synthetic pairing-mode band with the public scalar-1 transport key. */
private class CeremonyPeer(bandID: String, store: BandIdentityStore) {
    val ceremony = OwnershipCeremony(bandID, store)
    val bandKey = P256.Signing.PrivateKey()
    val session = BandSession(ceremony = ceremony)
    val sender: AirShieldCipher
    val receiver: AirShieldReceiver
    val datax = DataXReceiver()
    var cipherBytes: ByteArray
    val hostPoint: ByteArray
    val hostChallenge: ByteArray
    val bandPoint = ScalarOne.point
    val bandChallenge = range(0, 16)
    val bandSeed = range(0, 32)
    val hostSeed: ByteArray

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
        hostSeed = enable.bytes(2)
        cipherBytes = output.dropFirst(size)
        val secret = P256.sharedSecret(ScalarOne.privateKey, P256.publicKey(hostPoint))
        sender = AirShieldCipher(AirShieldKeys(secret, hostChallenge, bandSeed), iv, 42u)
        receiver = AirShieldReceiver(
            AirShieldCipher(AirShieldKeys(secret, bandChallenge, enable.bytes(2)), enable.bytes(3), enable.integer(4).toUInt()),
        )
    }

    fun send(frame: ByteArray): Exchange {
        val result = session.feed(sender.encrypt(frame), 100.0)
        return Exchange(result.events, drain(result.outgoing))
    }

    fun drain(bytes: ByteArray = EMPTY): List<DataXFrame> {
        val combined = cipherBytes + bytes
        cipherBytes = EMPTY
        return receiver.feed(combined).flatMap { datax.feed(it) }
    }

    /** The band's own EnableTrustEC proof over the host transcript. */
    fun proof(): ByteArray {
        val message = sha256(hostChallenge + hostPoint) + sha256(bandSeed + bandPoint)
        val signature = bandKey.signature(message)
        return BandWire.frame(
            0x8003,
            listOf(0x81000024u, 0x02001001u),
            field(1, repeated(7, 12)) + field(2, signature) + field(3, 1uL),
        )
    }
}

class OwnershipCeremonyTest {
    @Test
    fun ceremonyStartOpensTheIdentityServiceLikeTheCapturedSequence() {
        val ceremony = ceremony()
        val identityRead = BandWire.frame(0x8002, listOf(0x81000024u, 0x02003000u))
        assertArrayEquals(identityRead, ceremony.start())
        val skip = ceremony.identityRead(identityResponsePayload())
        // The captured SkipChallengeRequest reuses the open service with one word.
        assertArrayEquals(BandWire.frame(0x8002, listOf(0x02002000u)), skip)
        val identity = ceremony.identity!!
        assertArrayEquals(deviceCertificate, identity.deviceCertificate)
        assertEquals(SERIAL, identity.serial)
        assertArrayEquals(secondaryCertificate, identity.secondaryCertificate)
    }

    @Test
    fun theNonceParserAcceptsExactlySixteenBytes() {
        val ceremony = ceremony()
        ceremony.identityRead(identityResponsePayload())
        val request = ceremony.skipChallenge(skipChallengeResponsePayload(nonce))
        assertArrayEquals(nonce, request.nonce)
        assertEquals(SERIAL, request.identity.serial)
        assertArrayEquals(ceremony.appPublicKey, request.appPublicKey)
        assertEquals(64, request.appPublicKey.size)
        val short = BandWire.frame(2, listOf(0x02002001u), byteArrayOf(0x0a, 0x0f) + range(0, 15))
        assertThrows(BandProtocolError::class.java) { ceremony.skipChallenge(short) }
    }

    @Test
    fun ceremonyBuildersMatchTheCapturedStartChangeOwnerFrameLayout() {
        val ceremony = ceremony()
        ceremony.identityRead(identityResponsePayload())
        ceremony.skipChallenge(skipChallengeResponsePayload(nonce))
        val start = ceremony.pairRequestCompleted(pendingSignature, PENDING_RECEIPT)
        val expectedStart = BandWire.frame(
            0x8002,
            listOf(0x02002002u),
            field(1, pendingSignature) + field(2, PENDING_RECEIPT.toByteArray()),
        )
        assertArrayEquals(expectedStart, start)
        // The captured payload (fuzz-seeds/startchangeowner.bin) is field 1 = a
        // 71-byte DER signature introduced by 0a 47, then field 2 = a 1777-byte
        // receipt string whose length varint is the three bytes f1 0d.
        val payload = start.dropFirst(8)
        assertArrayEquals(byteArrayOf(0x0a, 0x47, 0x30, 0x45), payload.copyOfRange(0, 4))
        assertEquals(0x12.toByte(), payload[73])
        val longReceipt = "x".repeat(1777)
        val long = ceremony()
        long.identityRead(identityResponsePayload())
        long.skipChallenge(skipChallengeResponsePayload(nonce))
        val longPayload = long.pairRequestCompleted(pendingSignature, longReceipt).dropFirst(8)
        assertArrayEquals(byteArrayOf(0xf1.toByte(), 0x0d), longPayload.copyOfRange(74, 76))
        assertArrayEquals(longReceipt.toByteArray(), longPayload.dropFirst(76))
    }

    @Test
    fun startChangeOwnerResponsesCarrySignatureThenReceiptVerbatim() {
        val ceremony = ceremony()
        ceremony.identityRead(identityResponsePayload())
        ceremony.skipChallenge(skipChallengeResponsePayload(nonce))
        ceremony.pairRequestCompleted(pendingSignature, PENDING_RECEIPT)
        // The captured StartChangeOwnerResponse holds the signature in field 1 and
        // the device pending receipt string in field 2.
        val pair = ceremony.startChangeOwner(field(1, deviceSignature) + field(2, DEVICE_RECEIPT.toByteArray()))
        assertArrayEquals(deviceSignature, pair.signature)
        assertEquals(DEVICE_RECEIPT, pair.receipt)
    }

    @Test
    fun finishChangeOwnerUsesTheCapturedFieldMapAndCompleteStoresTheIdentity() {
        val band = "TEST-${UUID.randomUUID()}"
        val store = InMemoryBandIdentityStore()
        val ceremony = ceremony(band, store)
        ceremony.identityRead(identityResponsePayload())
        ceremony.skipChallenge(skipChallengeResponsePayload(nonce))
        ceremony.pairRequestCompleted(pendingSignature, PENDING_RECEIPT)
        ceremony.startChangeOwner(field(1, deviceSignature) + field(2, DEVICE_RECEIPT.toByteArray()))
        val bandPoint64 = P256.Signing.PrivateKey().publicKey.rawRepresentation
        val finish = ceremony.pairCompleted(finalSignature, FINAL_RECEIPT, bandPoint64)
        val expectedFinish = BandWire.frame(
            0x8002,
            listOf(0x02002004u),
            field(1, finalSignature) + field(2, FINAL_RECEIPT.toByteArray()),
        )
        assertArrayEquals(expectedFinish, finish)
        val enrollment = ceremony.complete(listOf(0x02002005u), EMPTY)
        assertArrayEquals(ceremony.appPrivateKey.rawRepresentation, enrollment.privateKey.rawRepresentation)
        assertArrayEquals(bandPoint64, enrollment.bandPublicKey?.rawRepresentation)
        val stored = store.load(band)!!
        assertArrayEquals(ceremony.appPrivateKey.rawRepresentation, stored.privateKey.rawRepresentation)
        assertArrayEquals(bandPoint64, stored.bandPublicKey?.rawRepresentation)
        // The band must confirm with an empty response; anything else is an error.
        val retried = ceremony(band, store)
        retried.identityRead(identityResponsePayload())
        retried.skipChallenge(skipChallengeResponsePayload(nonce))
        retried.pairRequestCompleted(pendingSignature, PENDING_RECEIPT)
        retried.startChangeOwner(field(1, deviceSignature) + field(2, DEVICE_RECEIPT.toByteArray()))
        retried.pairCompleted(finalSignature, FINAL_RECEIPT, bandPoint64)
        assertThrows(BandProtocolError::class.java) { retried.complete(listOf(0x02002005u), byteArrayOf(1)) }
    }

    @Test
    fun ceremonyStepsRejectOutOfOrderResponses() {
        val ceremony = ceremony()
        // Nothing precedes the identity read, and the nonce waits for it.
        assertThrows(BandProtocolError::class.java) { ceremony.skipChallenge(skipChallengeResponsePayload(nonce)) }
        assertThrows(BandProtocolError::class.java) { ceremony.pairRequestCompleted(pendingSignature, PENDING_RECEIPT) }
        ceremony.identityRead(identityResponsePayload())
        // A nonce that isn't sixteen bytes never reaches the HTTP step.
        assertThrows(BandProtocolError::class.java) { ceremony.skipChallenge(byteArrayOf(0x0a, 0x0f) + range(0, 15)) }
        assertThrows(BandProtocolError::class.java) { ceremony.pairRequestCompleted(pendingSignature, PENDING_RECEIPT) }
        ceremony.skipChallenge(skipChallengeResponsePayload(nonce))
        ceremony.pairRequestCompleted(pendingSignature, PENDING_RECEIPT)
        // Identity result codes map onto the reference error strings.
        assertEquals(
            "this band belongs to a different meta account. sign in with that account, or factory reset the band " +
                "(hold its button for about 16 seconds) to claim it with this one.",
            OwnershipCeremony.failureMessage(0x1042u),
        )
        assertTrue(OwnershipCeremony.failureMessage(0x1044u).contains("signature"))
    }

    @Test
    fun theSessionRunsTheWholeCeremonyAndRejoinsTheEnrolledStartup() {
        val band = "TEST-${UUID.randomUUID()}"
        val store = InMemoryBandIdentityStore()
        val peer = CeremonyPeer(band, store)
        // After the transport handshake the session opens the identity service.
        val identityRead = peer.drain().first()
        assertEquals(0x8002, identityRead.channel)
        assertEquals(listOf(0x81000024u, 0x02003000u), identityRead.words)
        // IdentityResponse -> SkipChallenge.
        val skip = peer.send(identityResponse()).requests
        assertTrue(skip.size == 1 && skip.first().channel == 0x8002 && skip.first().words == listOf(0x02002000u))
        // SkipChallengeResponse -> pair_request event with the nonce.
        val challenge = peer.send(skipChallengeResponse(nonce))
        val request = challenge.events.payloads<P.CeremonyHTTP>()
            .mapNotNull { (it.request as? CeremonyHTTPRequest.PairRequest)?.data }
            .first()
        assertArrayEquals(nonce, request.nonce)
        assertArrayEquals(peer.ceremony.appPublicKey, request.appPublicKey)
        assertEquals(SERIAL, request.identity.serial)
        // The app's HTTP reply becomes StartChangeOwner on channel 0x8002.
        val startBytes = peer.session.ceremonyPairRequestCompleted(pendingSignature, PENDING_RECEIPT)
        val start = peer.drain(startBytes).first()
        assertTrue(start.channel == 0x8002 && start.words == listOf(0x02002002u))
        assertArrayEquals(PENDING_RECEIPT.toByteArray(), ProtoFields(start.payload).bytes(2))
        // StartChangeOwnerResponse -> pair event with the verbatim receipt.
        val response = peer.send(
            BandWire.frame(2, listOf(0x02002003u), field(1, deviceSignature) + field(2, DEVICE_RECEIPT.toByteArray())),
        )
        val pair = response.events.payloads<P.CeremonyHTTP>()
            .mapNotNull { (it.request as? CeremonyHTTPRequest.Pair)?.data }
            .first()
        assertEquals(DEVICE_RECEIPT, pair.receipt)
        assertArrayEquals(deviceSignature, pair.signature)
        // The final receipt becomes FinishChangeOwner; the empty confirmation then
        // hands the fresh identity to the enrolled trust flow.
        val bandPoint64 = peer.bandKey.publicKey.rawRepresentation
        val finishBytes = peer.session.ceremonyPairCompleted(finalSignature, FINAL_RECEIPT, bandPoint64)
        val finish = peer.drain(finishBytes).first()
        assertTrue(finish.channel == 0x8002 && finish.words == listOf(0x02002004u))
        val done = peer.send(BandWire.frame(2, listOf(0x02002005u)))
        val trust = done.requests.first()
        // The service is already open on 0x8002, so the trust proof uses one word.
        assertTrue(trust.channel == 0x8002 && trust.words == listOf(0x02001000u))
        val trustFields = ProtoFields(trust.payload)
        val appPoint = peer.ceremony.appPrivateKey.publicKey.rawRepresentation
        assertArrayEquals(sha256(appPoint), trustFields.bytes(1))
        val message = sha256(peer.bandChallenge + peer.bandPoint) + sha256(peer.hostSeed + peer.hostPoint)
        assertTrue(peer.ceremony.appPrivateKey.publicKey.isValidSignature(trustFields.bytes(2, 64), message))
        // The stored identity matches the ceremony key and the band key from the receipt.
        val stored = store.load(band)!!
        assertArrayEquals(peer.ceremony.appPrivateKey.rawRepresentation, stored.privateKey.rawRepresentation)
        assertArrayEquals(peer.bandKey.publicKey.x963Representation, stored.bandPublicKey?.x963Representation)
        // From here the standard enrolled startup continues: band proof accepted,
        // then EndLinkSetup.
        assertTrue(peer.send(BandWire.frame(2, listOf(0x03001000u))).requests.isEmpty())
        val acknowledged = peer.send(peer.proof())
        assertEquals(3, acknowledged.requests.first().channel)
        val end = acknowledged.requests.last()
        assertTrue(end.channel == 0x8001 && end.words == listOf(0x02001000u))
    }

    @Test
    fun identityResultCodesFailTheCeremonySession() {
        val peer = CeremonyPeer("TEST-${UUID.randomUUID()}", InMemoryBandIdentityStore())
        peer.drain()
        peer.send(identityResponse())
        try {
            peer.send(BandWire.frame(2, listOf(0x03001043u)))
            fail("An ownership result code must fail the ceremony")
        } catch (error: BandProtocolError) {
            assertTrue(error.message.contains("identity"))
        }
    }
}
