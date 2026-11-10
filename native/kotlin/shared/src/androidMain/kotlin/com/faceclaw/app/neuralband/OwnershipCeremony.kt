// Ported from callbacked/kinesis (MIT, Copyright (c) 2026 callbacked): Sources/KinesisCore/OwnershipCeremony.swift,
// by way of tetramo-labs/glassly (MIT).
package com.faceclaw.app.neuralband

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/**
 * The identity a band in pairing mode reports during the ownership ceremony.
 * The three values travel verbatim to the ownership HTTP endpoints.
 */
class BandIdentityInfo(
    val deviceCertificate: ByteArray,
    val serial: String,
    val secondaryCertificate: ByteArray,
)

/** What the app must send to `pair_request` after the band hands out a nonce. */
class CeremonyPairRequestData(
    val identity: BandIdentityInfo,
    val nonce: ByteArray,
    val appPublicKey: ByteArray,
)

/** What the app must send to `pair` after the band accepts the pending receipt. */
class CeremonyPairData(
    val receipt: String,
    val signature: ByteArray,
)

/**
 * A request the band ceremony cannot answer by itself: the app performs the
 * ownership HTTP exchange and resumes the session with [CeremonyCompletion].
 */
sealed class CeremonyHTTPRequest {
    class PairRequest(val data: CeremonyPairRequestData) : CeremonyHTTPRequest()
    class Pair(val data: CeremonyPairData) : CeremonyHTTPRequest()
}

/** The parsed result of one ownership HTTP exchange, fed back into the session. */
sealed class CeremonyCompletion {
    class PairRequest(val signature: ByteArray, val receipt: String) : CeremonyCompletion()
    class Pair(val signature: ByteArray, val receipt: String, val devicePublicKey: ByteArray?) : CeremonyCompletion()
}

/**
 * The BLE side of the enrollment ceremony, one step per band response. The
 * frames follow the captured live sequence: the identity read opens service
 * 0x24 on channel 0x8002, later requests reuse the open service.
 *
 * [appPrivateKey] is a fresh app identity for this attempt. It is stored in
 * [store] only after the band confirms the ownership change.
 */
class OwnershipCeremony(
    val bandID: String,
    private val store: BandIdentityStore,
    val appPrivateKey: P256.Signing.PrivateKey = P256.Signing.PrivateKey(),
) {
    enum class Stage { IDENTITY_READ, SKIP_CHALLENGE, START_CHANGE_OWNER, PAIR, FINISH_CHANGE_OWNER, DONE }

    var stage = Stage.IDENTITY_READ
        private set
    var identity: BandIdentityInfo? = null
        private set
    var nonce: ByteArray? = null
        private set
    private var devicePublicKey: ByteArray? = null
    private var bandKey: P256.Signing.PublicKey? = null

    /** The raw 64-byte point of the fresh app identity public key. */
    val appPublicKey: ByteArray get() = appPrivateKey.publicKey.rawRepresentation

    /** The identity read that opens the identity service on channel 0x8002. */
    fun start(): ByteArray {
        if (stage != Stage.IDENTITY_READ) throw BandProtocolError("The enrollment is past its identity read")
        return BandWire.frame(0x8002, listOf(0x81000024u, 0x02003000u))
    }

    /** Parse the IdentityResponse (fields 1, 2, 5) and return SkipChallenge. */
    fun identityRead(payload: ByteArray): ByteArray {
        if (stage != Stage.IDENTITY_READ) throw BandProtocolError("The band sent an unexpected identity response")
        val fields = ProtoFields(payload)
        val certificate = fields.bytes(1)
        val serialBytes = fields.bytes(2)
        val secondary = fields.bytes(5)
        val serial = if (serialBytes.all { it >= 0 }) String(serialBytes, Charsets.US_ASCII) else null
        if (certificate.size <= 256 || secondary.size <= 256 || serial.isNullOrEmpty()) {
            throw BandProtocolError("The band didn't report a usable identity")
        }
        identity = BandIdentityInfo(certificate, serial, secondary)
        stage = Stage.SKIP_CHALLENGE
        return BandWire.frame(0x8002, listOf(0x02002000u))
    }

    /** Parse the SkipChallengeResponse: field 1 holds the 16-byte ownership nonce. */
    fun skipChallenge(payload: ByteArray): CeremonyPairRequestData {
        val identity = identity
        if (stage != Stage.SKIP_CHALLENGE || identity == null) {
            throw BandProtocolError("The band sent an unexpected challenge response")
        }
        val nonce = ProtoFields(payload).bytes(1, 16)
        this.nonce = nonce
        stage = Stage.START_CHANGE_OWNER
        return CeremonyPairRequestData(identity, nonce, appPublicKey)
    }

    /**
     * Build StartChangeOwner: field 1 is the receipt signature (DER), field 2
     * the pending receipt string verbatim, exactly as the captured frame.
     */
    fun pairRequestCompleted(signature: ByteArray, receipt: String): ByteArray {
        if (stage != Stage.START_CHANGE_OWNER) throw BandProtocolError("The enrollment isn't waiting for its claim")
        if (signature.isEmpty() || receipt.isEmpty()) {
            throw BandProtocolError("The server didn't return a pending ownership receipt")
        }
        stage = Stage.PAIR
        return BandWire.frame(
            0x8002,
            listOf(0x02002002u),
            BandWire.field(1, signature) + BandWire.field(2, receipt.toByteArray()),
        )
    }

    /**
     * Parse the band's StartChangeOwnerResponse: field 1 signature, field 2
     * the device pending receipt string verbatim.
     */
    fun startChangeOwner(payload: ByteArray): CeremonyPairData {
        if (stage != Stage.PAIR) throw BandProtocolError("The band sent an unexpected ownership response")
        val fields = ProtoFields(payload)
        val signature = fields.bytes(1)
        val receipt = utf8OrNull(fields.bytes(2))
        if (receipt.isNullOrEmpty()) throw BandProtocolError("The band didn't return its pending ownership receipt")
        stage = Stage.FINISH_CHANGE_OWNER
        return CeremonyPairData(receipt, signature)
    }

    /** Build FinishChangeOwner: same field map as StartChangeOwner. */
    fun pairCompleted(signature: ByteArray, receipt: String, devicePublicKey: ByteArray?): ByteArray {
        if (stage != Stage.FINISH_CHANGE_OWNER) throw BandProtocolError("The enrollment isn't waiting for its final receipt")
        if (signature.isEmpty() || receipt.isEmpty()) {
            throw BandProtocolError("The server didn't return a final ownership receipt")
        }
        // The reference app tolerates a missing device key here; verification
        // of the band's trust proof then stays advisory for this band.
        this.devicePublicKey = devicePublicKey
        bandKey = bandKey(devicePublicKey)
        store.save(bandID, appPrivateKey, bandKey)
        stage = Stage.DONE
        return BandWire.frame(
            0x8002,
            listOf(0x02002004u),
            BandWire.field(1, signature) + BandWire.field(2, receipt.toByteArray()),
        )
    }

    private fun bandKey(devicePublicKey: ByteArray?): P256.Signing.PublicKey? {
        var point = devicePublicKey ?: return null
        if (point.size == 65 && point[0].toInt() == 4) point = point.copyOfRange(1, 65)
        if (point.size != 64) return null
        return runCatching { P256.Signing.PublicKey(point) }.getOrNull()
    }

    /**
     * Confirm the empty FinishChangeOwnerResponse, store the fresh app key
     * with the band's identity key under the band identifier, and hand the
     * identity to the enrolled startup.
     */
    fun complete(words: List<UInt>, payload: ByteArray): BandEnrollmentIdentity {
        if (stage != Stage.DONE) throw BandProtocolError("The enrollment isn't ready to finish")
        if (words != listOf(0x02002005u) || payload.isNotEmpty()) {
            throw BandProtocolError("The band didn't confirm the ownership change")
        }
        return BandEnrollmentIdentity(appPrivateKey, bandKey)
    }

    companion object {
        /** How to wipe a band completely. Forgetting it in the app clears only the phone's side. */
        const val FACTORY_RESET_HINT = "hold its button for about 16 seconds"

        /** The reference error map for identity service result codes. */
        fun failureMessage(code: UInt): String = when (code) {
            0x1040u -> "the band rejected the ownership receipt."
            0x1041u -> "the band rejected the ownership challenge."
            0x1042u -> "this band belongs to a different meta account. sign in with that account, or factory reset the band ($FACTORY_RESET_HINT) to claim it with this one."
            0x1043u -> "the band rejected this app's identity."
            0x1044u -> "the band rejected a signature."
            0x1045u -> "the band rejected the receipt timing."
            0xd001u, 0xd004u, 0xd021u -> "the band couldn't read the ownership request."
            0xc001u -> "the band has no identity service."
            0xc004u -> "the band couldn't parse the ownership request."
            else -> "the band reported an ownership error (${code.toString(16)})."
        }
    }
}

internal fun utf8OrNull(bytes: ByteArray): String? =
    try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    } catch (e: CharacterCodingException) {
        null
    }
