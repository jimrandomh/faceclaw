// Ported from callbacked/kinesis (MIT, Copyright (c) 2026 callbacked): Sources/KinesisCore/BandSession.swift,
// by way of tetramo-labs/glassly (MIT) at 11c0697d10. Faceclaw keeps the handshake, the ownership
// ceremony, enrolled trust, the input subscription, hand, battery, motion and haptics; it drops
// glassly's raw EMG readings, band-model (handwriting) capture and firmware updates, which share
// the configuration channels but no state with what is kept.
package com.faceclaw.app.neuralband

import java.io.ByteArrayOutputStream
import java.security.SecureRandom
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey

interface BandLog {
    fun info(message: String)
    fun error(message: String)

    companion object {
        val NONE: BandLog = object : BandLog {
            override fun info(message: String) {}
            override fun error(message: String) {}
        }
    }
}

class FeedResult(val outgoing: ByteArray, val events: List<BandEvent>) {
    operator fun component1(): ByteArray = outgoing
    operator fun component2(): List<BandEvent> = events
}

/** The observed band handshake and input subscription. It never exports session keys. */
class BandSession(
    private var enrollment: BandEnrollmentIdentity? = null,
    private val ceremony: OwnershipCeremony? = null,
    /**
     * Gestures (3) are always on. Gyro (6) and orientation (8) stream at 128 Hz each,
     * which is most of the link's load, so each can be switched while connected.
     */
    private var motion: MotionStreams = MotionStreams.ALL,
    private val log: BandLog = BandLog.NONE,
    private val schemeGuess: Int = 0,
) {
    private var guessing = false
    private var variant = AirShieldVariant.SCHEME_3
    private var peerParameters = 0uL

    val schemeGuessInUse: Int? get() = if (guessing) schemeGuess else null

    private enum class SetupStage { LINK, CEREMONY, IDENTITY, DEVICE_INFO, INPUT }

    private class HandRequest(val id: ULong, val hand: BandHand?, val reading: Boolean, val deadline: Double)

    private class MotionRequest(val id: ULong, val wanted: MotionStreams, val sentAt: Double)

    private class BatteryRequest(val id: ULong, val deadline: Double)

    private val keyPair = P256.generateKeyPair()
    private val privateKey = keyPair.private as ECPrivateKey
    private val publicKey = P256.rawPublic(keyPair.public as ECPublicKey)
    private val challenge = random(16)
    private val seed = random(32)
    private val iv = random(16)
    private val base: UInt = random(4).let {
        (it[0].toUInt() and 0xffu) or ((it[1].toUInt() and 0xffu) shl 8) or
            ((it[2].toUInt() and 0xffu) shl 16) or ((it[3].toUInt() and 0xffu) shl 24)
    }
    private var peerKey: ByteArray? = null
    private var peerChallenge: ByteArray? = null
    private var peerSeed: ByteArray? = null
    private var pending = ByteArray(0)
    private var transmitter: AirShieldCipher? = null
    private var receiver: AirShieldReceiver? = null
    private val datax = DataXReceiver()
    private val channelTypes = HashMap<Int, UInt>()
    private var dial = PinchDial()
    private var emittedEngagement = false
    private var dialPending = 0.0
    private var lastDial = Double.NEGATIVE_INFINITY
    private var lastHeartbeat = Double.NEGATIVE_INFINITY
    private var streaming = false
    private var stopping = false
    var stopAcknowledged = false
        private set
    var authenticatedPackets = 0
        private set
    var motionMessages = 0
        private set
    var streamsEnabled = false
        private set
    private val streamFields: List<Int>
        get() = listOf(3) + (if (motion.gyro) listOf(6) else emptyList()) + (if (motion.orientation) listOf(8) else emptyList())
    private var wantedMotion: MotionStreams? = null
    private var motionRequest: MotionRequest? = null

    /** After a restart request: the streams to turn back on once "off" is confirmed. */
    private var motionAfterRestart: MotionStreams? = null
    val motionStreams: MotionStreams get() = motion
    private val streamChannel = 0x8005
    private val configurationChannel = 0x8006
    private val batteryChannel = 0x8008
    private var batteryChannelOpened = false
    private var batteryRequestID: ULong = 0uL
    private var batteryRequest: BatteryRequest? = null
    private var batteryUnavailable = false
    /** Stream-change request ids; 2-5 are the fixed subscription, stop and status requests. */
    private var streamRequestID: ULong = 6uL
    private var setupStage = SetupStage.LINK
    private var appTrusted = false
    private var bandTrusted = false

    /**
     * The stored identity's EnableTrust went out and the band has not accepted it. A reset band
     * may answer nothing at all, so a failure here counts as a rejection.
     */
    val storedIdentityPending: Boolean
        get() = ceremony == null && enrollment != null && setupStage == SetupStage.IDENTITY && !appTrusted
    private var endLinkSent = false
    private var configurationID: ULong = 0uL
    private var handRequest: HandRequest? = null
    var hand: BandHand? = null
        private set
    var deviceInfo: BandDeviceInfo? = null
        private set
    private var hapticsRequest: Pair<ULong, Double>? = null
    private var wantedGestureHaptics: Boolean? = null
    private var startupFrames = 0

    fun request(): ByteArray =
        BandWire.frame(
            0x8001,
            listOf(0x81000005u, 0x02000001u),
            BandWire.field(1, publicKey) + BandWire.field(2, challenge) + BandWire.field(3, 0uL) +
                BandWire.field(4, 31uL) + BandWire.field(7, 16uL),
        )

    fun feed(bytes: ByteArray, time: Double): FeedResult {
        pending += bytes
        val outgoing = ByteArrayOutputStream()
        val events = ArrayList<BandEvent>()
        while (receiver == null && pending.size >= 4) {
            if (pending[0].toInt() and 0x80 == 0) throw BandProtocolError("Unexpected bytes before band encryption")
            val size = (pending.be16(0) and 0x7fff) + 4
            if (size < 8) throw BandProtocolError("Invalid band setup length")
            if (pending.size < size) break
            val frame = pending.copyOfRange(0, size)
            pending = pending.dropFirst(size)
            val offset = if (frame[2].toInt() and 0x80 != 0) 8 else 4
            if (size < offset + 4) throw BandProtocolError("Truncated band setup header")
            val kind = frame.be32(offset)
            val fields = ProtoFields(frame.dropFirst(offset + 4))
            val point = fields.bytes(1, 64)
            val peer = P256.publicKey(point)
            when (kind) {
                0x02000001u -> {
                    val curve = fields.integer(3)
                    val parameters = fields.integer(4)
                    val newer = parameters and 24uL != 0uL
                    if (peerKey != null || curve != 0uL || !(newer || parameters and 3uL == 3uL)) {
                        throw BandProtocolError(
                            "Unsupported band encryption parameters (repeated request: ${peerKey != null}, curve $curve, parameters $parameters)",
                        )
                    }
                    peerKey = point
                    peerChallenge = fields.bytes(2, 16)
                    guessing = newer
                    variant = if (newer) {
                        AirShieldVariant.SCHEME_26_GUESSES[schemeGuess % AirShieldVariant.SCHEME_26_GUESSES.size]
                    } else {
                        AirShieldVariant.SCHEME_3
                    }
                    outgoing.write(
                        BandWire.frame(
                            1,
                            listOf(0x02000002u),
                            BandWire.field(1, publicKey) + BandWire.field(2, seed) + BandWire.field(3, iv) +
                                BandWire.field(4, base.toULong()) + BandWire.field(5, variant.announce),
                        ),
                    )
                }
                0x02000002u -> {
                    val peerChallenge = peerChallenge
                    if (!point.contentEquals(peerKey) || peerChallenge == null) {
                        throw BandProtocolError("Unexpected band encryption response")
                    }
                    peerParameters = fields.integer(5)
                    val secret = P256.sharedSecret(privateKey, peer)
                    val peerSeed = fields.bytes(2, 32)
                    this.peerSeed = peerSeed
                    val peerIV = fields.bytes(3, 16)
                    val peerBase = fields.integer(4)
                    if (peerBase > UInt.MAX_VALUE.toULong()) throw BandProtocolError("Invalid band packet counter")
                    transmitter = AirShieldCipher(AirShieldKeys(variant, secret, peerChallenge, seed), iv, base)
                    receiver = AirShieldReceiver(AirShieldCipher(AirShieldKeys(variant, secret, challenge, peerSeed), peerIV, peerBase.toUInt()))
                    if (variant.padsAligned) datax.setAlwaysPadded()
                    val enrollment = enrollment
                    if (ceremony != null) {
                        // Enrollment startup runs the ownership ceremony instead of
                        // the identity queries; it rejoins the enrolled flow at trust.
                        setupStage = SetupStage.CEREMONY
                        outgoing.write(encrypt(ceremony.start()))
                    } else if (enrollment != null) {
                        // Enrolled startup replaces the empty identity query with an
                        // EnableTrust proof. Link setup waits for mutual trust.
                        setupStage = SetupStage.IDENTITY
                        outgoing.write(encrypt(enableTrust(enrollment)))
                    } else {
                        // Complete link setup before opening the input service.
                        outgoing.write(encrypt(BandWire.frame(0x8002, listOf(0x81000024u, 0x02003000u))))
                        outgoing.write(
                            encrypt(
                                BandWire.frame(
                                    0x8001,
                                    listOf(0x02001000u),
                                    BandWire.field(1, 1uL) + BandWire.field(2, random(16)),
                                ),
                            ),
                        )
                    }
                }
                else -> throw BandProtocolError("Unrecognized band setup message")
            }
        }
        val receiver = receiver
        if (receiver != null) {
            val records = try {
                receiver.feed(pending)
            } catch (e: BandProtocolError) {
                if (authenticatedPackets == 0 && guessing) {
                    throw BandProtocolError("${e.message} (the band chose encryption scheme $peerParameters; key guess $schemeGuess was wrong)")
                }
                throw e
            }
            pending = ByteArray(0)
            for (plaintext in records) {
                authenticatedPackets += 1
                for (frame in datax.feed(plaintext)) {
                    try {
                        events += input(frame, time, outgoing)
                    } catch (e: BandProtocolError) {
                        if (setupStage != SetupStage.INPUT || !e.message.contains("protobuf")) throw e
                        log.error("Skipped a band frame on channel ${frame.channel}: ${e.message}")
                    }
                }
                if (streaming && !stopping && time - lastHeartbeat >= 0.2) {
                    lastHeartbeat = time
                    events.add(BandEvent(BandEvent.Payload.Heartbeat, time))
                }
            }
        }
        return FeedResult(outgoing.toByteArray(), events)
    }

    fun tick(time: Double): List<BandEvent> {
        dial.tick(time)
        val events = ArrayList(engagementEvents(time))
        // An unanswered stream change is given up after 8 s, so a later one can go out.
        val pendingMotion = motionRequest
        if (pendingMotion != null && time - pendingMotion.sentAt >= 8 && !stopping) {
            motionRequest = null
            // A restart gives up only when its own off request fails. An earlier change
            // failing leaves the restart waiting to go out.
            if (motionAfterRestart != null && pendingMotion.wanted == MotionStreams.NONE) {
                motionAfterRestart = null
                wantedMotion = null
            }
            events.add(
                BandEvent(BandEvent.Payload.MotionStreamsChanged(motion, time - pendingMotion.sentAt, false), time),
            )
        }
        val pendingHand = handRequest
        if (pendingHand != null && time >= pendingHand.deadline && !stopping) {
            handRequest = null
            hand = null
            events.add(BandEvent(BandEvent.Payload.HandednessFailure("Couldn't confirm the band hand. Reconnect and try again."), time))
        }
        val pendingBattery = batteryRequest
        if (pendingBattery != null && time >= pendingBattery.deadline && !stopping) {
            batteryRequest = null
            events.add(BandEvent(BandEvent.Payload.BatteryStatus(null), time))
        }
        val pendingHaptics = hapticsRequest
        if (pendingHaptics != null && time >= pendingHaptics.second && !stopping) hapticsRequest = null
        return events
    }

    /** Every stream field, on or off explicitly, so no field is left to the band's default. */
    private fun streamControl(motion: MotionStreams): ByteArray =
        BandWire.field(3, 1uL) + BandWire.field(6, if (motion.gyro) 1uL else 0uL) +
            BandWire.field(8, if (motion.orientation) 1uL else 0uL)

    /**
     * Asks for these motion streams. Before the subscription it only changes what
     * the subscription asks for. While another stream change is in flight it waits;
     * [flushMotion] sends it when the way is clear.
     */
    fun setMotionStreams(wanted: MotionStreams, time: Double): ByteArray {
        if (stopping) return ByteArray(0)
        motionAfterRestart = null
        wantedMotion = wanted
        return flushMotion(time)
    }

    /** Turns the motion streams off and, once the band confirms, on again. */
    fun restartMotionStreams(time: Double): ByteArray {
        if (stopping || !streamsEnabled || motionAfterRestart != null || motion == MotionStreams.NONE) return ByteArray(0)
        val restore = wantedMotion ?: motion
        wantedMotion = MotionStreams.NONE
        motionAfterRestart = restore
        return flushMotion(time)
    }

    /** Sends a waiting motion change if nothing else is in flight. Safe to call often. */
    fun flushMotion(time: Double): ByteArray {
        // While a change is in flight, compare against nothing yet: it may still move `motion`.
        val wanted = wantedMotion
        if (stopping || wanted == null || motionRequest != null) return ByteArray(0)
        if (wanted == motion) {
            wantedMotion = null
            return ByteArray(0)
        }
        // The subscription has not gone out yet: it will simply ask for these.
        if (setupStage != SetupStage.INPUT) {
            motion = wanted
            wantedMotion = null
            return ByteArray(0)
        }
        if (!streamsEnabled) return ByteArray(0)
        streamRequestID += 1uL
        motionRequest = MotionRequest(streamRequestID, wanted, time)
        return encrypt(
            BandWire.frame(
                streamChannel,
                emptyList(),
                BandWire.field(1, streamRequestID) + BandWire.field(4, streamControl(wanted)),
            ),
        )
    }

    fun setHandedness(hand: BandHand, time: Double): ByteArray {
        if (!streamsEnabled || stopping || this.hand == null || handRequest != null) {
            throw BandProtocolError("Wait for the band to report its hand before changing it.")
        }
        dial = PinchDial()
        return requestHand(hand, reading = false, time = time)
    }

    private fun requestHand(hand: BandHand?, reading: Boolean, time: Double): ByteArray {
        val id = configurationID + 1uL
        // ConfigReq.is_left_handed is field 10. An empty ConfigReq reads current settings.
        val config = if (reading) ByteArray(0) else BandWire.field(10, if (hand == BandHand.LEFT) 1uL else 0uL)
        val bytes = encrypt(
            BandWire.frame(
                configurationChannel,
                if (configurationID == 0uL) listOf(0x8100ce56u, 0x02000314u) else emptyList(),
                BandWire.field(1, id) + BandWire.field(5, config),
            ),
        )
        configurationID = id
        handRequest = HandRequest(id, hand, reading, time + 5)
        return bytes
    }

    private fun requestActive(): ByteArray = encrypt(
        BandWire.frame(
            configurationChannel,
            emptyList(),
            BandWire.field(1, ACTIVE_REQUEST) + BandWire.field(5, BandWire.field(6, 2uL)),
        ),
    )

    private fun receiveHand(fields: ProtoFields, time: Double, outgoing: ByteArrayOutputStream): List<BandEvent> {
        val request = handRequest ?: return emptyList()
        if (fields.integer(1) != request.id) return emptyList()
        handRequest = null
        if (!(time < request.deadline)) {
            hand = null
            return listOf(BandEvent(BandEvent.Payload.HandednessFailure("Couldn't confirm the band hand. Reconnect and try again."), time))
        }
        if (fields.integer(2) != 1uL) {
            hand = null
            return listOf(
                BandEvent(
                    BandEvent.Payload.HandednessFailure("The band couldn't apply its hand setting. Reconnect and try again."),
                    time,
                ),
            )
        }
        if (!request.reading) {
            // Read it again independently; a successful write status alone isn't confirmation.
            outgoing.write(requestHand(request.hand, reading = true, time = time))
            return emptyList()
        }
        if (!fields.contains(6)) {
            hand = null
            return listOf(BandEvent(BandEvent.Payload.HandednessFailure("This band didn't report its hand setting."), time))
        }
        val config = ProtoFields(fields.bytes(6))
        if (!config.contains(10) || config.integer(10) > 1uL) {
            hand = null
            return listOf(BandEvent(BandEvent.Payload.HandednessFailure("This band didn't report its hand setting."), time))
        }
        val reported = if (config.integer(10) == 1uL) BandHand.LEFT else BandHand.RIGHT
        hand = reported
        val events = arrayListOf(BandEvent(BandEvent.Payload.Handedness(reported), time))
        val expected = request.hand
        if (expected != null && reported != expected) {
            events.add(
                BandEvent(
                    BandEvent.Payload.HandednessFailure("The band didn't keep the selected hand. Reconnect and try again."),
                    time,
                ),
            )
        }
        return events
    }

    /** BatteryInfoReq is an empty read request, separate from sensor subscriptions. */
    fun queryBatteryStatus(time: Double): ByteArray {
        if (!streamsEnabled || stopping || batteryUnavailable || batteryRequest != null) return ByteArray(0)
        batteryRequestID += 1uL
        batteryRequest = BatteryRequest(batteryRequestID, time + 3)
        val words = if (batteryChannelOpened) emptyList() else listOf(0x8100ce56u, 0x02000314u)
        batteryChannelOpened = true
        return encrypt(
            BandWire.frame(batteryChannel, words, BandWire.field(1, batteryRequestID) + BandWire.field(2, ByteArray(0))),
        )
    }

    fun setGestureHaptics(enabled: Boolean) {
        wantedGestureHaptics = enabled
    }

    fun flushGestureHaptics(time: Double): ByteArray {
        val enabled = wantedGestureHaptics ?: return ByteArray(0)
        if (!streamsEnabled || stopping || handRequest != null || hapticsRequest != null || hand == null) {
            return ByteArray(0)
        }
        wantedGestureHaptics = null
        val id = configurationID + 1uL
        val bytes = encrypt(
            BandWire.frame(
                configurationChannel,
                if (configurationID == 0uL) listOf(0x8100ce56u, 0x02000314u) else emptyList(),
                BandWire.field(1, id) + BandWire.field(17, BandWire.field(2, BandWire.field(1, if (enabled) 1uL else 2uL))),
            ),
        )
        configurationID = id
        hapticsRequest = id to time + 5
        return bytes
    }

    /** Read the existing subscription's status when sensor traffic goes quiet. */
    fun queryStreamState(): ByteArray {
        if (!streamsEnabled || stopping) return ByteArray(0)
        return streamRequest(5uL, null)
    }

    fun stop(): ByteArray {
        if (stopping) return ByteArray(0)
        stopping = true
        handRequest = null
        batteryRequest = null
        motionRequest = null
        wantedMotion = null
        motionAfterRestart = null
        hapticsRequest = null
        wantedGestureHaptics = null
        if (transmitter == null || setupStage != SetupStage.INPUT) return ByteArray(0)
        return streamRequest(4uL, false)
    }

    private fun encrypt(data: ByteArray): ByteArray {
        val transmitter = transmitter ?: throw BandProtocolError("Band encryption is not ready")
        return transmitter.encrypt(data)
    }

    /**
     * Host EnableTrust on the identity service channel, replacing the empty
     * identity query for enrolled bands. The service-open word is only needed
     * before the first identity exchange on the channel.
     */
    private fun enableTrust(identity: BandEnrollmentIdentity, serviceOpen: Boolean = false): ByteArray {
        val peerKey = peerKey
        val peerChallenge = peerChallenge
        if (peerKey == null || peerChallenge == null) throw BandProtocolError("Band encryption is not ready")
        val signature = identity.privateKey.signature(trustMessage(peerChallenge, peerKey, seed, publicKey))
        val identityPoint = identity.privateKey.publicKey.rawRepresentation
        return BandWire.frame(
            0x8002,
            if (serviceOpen) listOf(0x02001000u) else listOf(0x81000024u, 0x02001000u),
            BandWire.field(1, sha256(identityPoint)) + BandWire.field(2, signature),
        )
    }

    /**
     * Drive one ownership ceremony response. HTTP steps pause the wire flow
     * and surface a ceremony event; the app resumes the session with the
     * server's reply.
     */
    private fun receiveCeremony(frame: DataXFrame, time: Double, outgoing: ByteArrayOutputStream): List<BandEvent> {
        val ceremony = ceremony ?: return emptyList()
        val kind = frame.words.lastOrNull() ?: return emptyList()
        if (kind and 0xff000000u == 0x03000000u) {
            throw BandProtocolError(OwnershipCeremony.failureMessage(kind and 0xffffffu))
        }
        return when (kind) {
            0x02003001u -> {
                outgoing.write(encrypt(ceremony.identityRead(frame.payload)))
                listOf(BandEvent(BandEvent.Payload.CeremonyStage("reading the band identity"), time))
            }
            0x02002001u -> {
                val request = ceremony.skipChallenge(frame.payload)
                listOf(
                    BandEvent(BandEvent.Payload.CeremonyStage("claiming the band"), time),
                    BandEvent(BandEvent.Payload.CeremonyHTTP(CeremonyHTTPRequest.PairRequest(request)), time),
                )
            }
            0x02002003u -> {
                val pair = ceremony.startChangeOwner(frame.payload)
                listOf(
                    BandEvent(BandEvent.Payload.CeremonyStage("confirming ownership"), time),
                    BandEvent(BandEvent.Payload.CeremonyHTTP(CeremonyHTTPRequest.Pair(pair)), time),
                )
            }
            0x02002005u -> listOf(adoptEnrolledIdentity(ceremony.complete(frame.words, frame.payload), outgoing, time))
            else -> emptyList()
        }
    }

    /**
     * Swap the just-enrolled identity in and open the enrolled trust flow on
     * the same channel; the identity service is already open there.
     */
    private fun adoptEnrolledIdentity(
        identity: BandEnrollmentIdentity,
        outgoing: ByteArrayOutputStream,
        time: Double,
    ): BandEvent {
        if (ceremony == null) throw BandProtocolError("No enrollment is running")
        enrollment = identity
        appTrusted = false
        bandTrusted = false
        endLinkSent = false
        setupStage = SetupStage.IDENTITY
        outgoing.write(encrypt(enableTrust(identity, serviceOpen = true)))
        return BandEvent(BandEvent.Payload.CeremonyStage("establishing trust"), time)
    }

    /** Resume the ceremony after the `pair_request` HTTP exchange. */
    fun ceremonyPairRequestCompleted(signature: ByteArray, receipt: String): ByteArray {
        val ceremony = ceremony ?: throw BandProtocolError("No enrollment is running")
        return encrypt(ceremony.pairRequestCompleted(signature, receipt))
    }

    /** Resume the ceremony after the `pair` HTTP exchange. */
    fun ceremonyPairCompleted(signature: ByteArray, receipt: String, devicePublicKey: ByteArray?): ByteArray {
        val ceremony = ceremony ?: throw BandProtocolError("No enrollment is running")
        return encrypt(ceremony.pairCompleted(signature, receipt, devicePublicKey))
    }

    /**
     * Handle the enrolled identity exchange until both directions trust each
     * other, then rejoin the shared EndLinkSetup flow.
     */
    private fun receiveIdentity(frame: DataXFrame, outgoing: ByteArrayOutputStream): List<BandEvent> {
        val kind = frame.words.lastOrNull() ?: return emptyList()
        val route = route(frame.channel)
        if (kind and 0xff000000u == 0x03000000u && route == 2) {
            if (kind != 0x03001000u) {
                if (kind == 0x03001043u) {
                    throw BandIdentityMismatchError(
                        "band enrolled to a different key. forget the stored band identity to reconnect without it.",
                    )
                }
                throw BandIdentityMismatchError("the band rejected the stored identity (${kind.toString(16)}). try reconnecting.")
            }
            appTrusted = true
        } else if (kind == 0x02001001u && route and 0x8000 != 0) {
            if (bandTrusted) throw BandProtocolError("The band sent a duplicate identity proof")
            val fields = ProtoFields(frame.payload)
            val peerKey = peerKey
            val peerSeed = peerSeed
            if (peerKey == null || peerSeed == null) throw BandProtocolError("Band encryption is not ready")
            val signature = fields.bytes(2, 64)
            val bandKey = enrollment?.bandPublicKey
            if (bandKey != null &&
                !bandKey.isValidSignature(signature, trustMessage(challenge, publicKey, peerSeed, peerKey))
            ) {
                throw BandProtocolError("The band's identity proof didn't verify. Try reconnecting.")
            }
            bandTrusted = true
            outgoing.write(encrypt(BandWire.frame(frame.channel and 0x7fff, listOf(0x03001000u))))
        } else if (kind == 0x02001000u && route == 0x8001 && endLinkSent) {
            val fields = ProtoFields(frame.payload)
            if (fields.requiredInteger(1) != 1uL || fields.bytes(2).size != 16) {
                throw BandProtocolError("Unexpected band link setup response")
            }
            setupStage = SetupStage.DEVICE_INFO
            outgoing.write(
                encrypt(
                    BandWire.frame(
                        0x8003,
                        listOf(0x8100ce56u, 0x02000314u),
                        BandWire.field(1, 1uL) + BandWire.field(3, ByteArray(0)),
                    ),
                ),
            )
            return emptyList()
        } else {
            return emptyList()
        }
        if (appTrusted && bandTrusted && !endLinkSent) {
            endLinkSent = true
            outgoing.write(
                encrypt(BandWire.frame(0x8001, listOf(0x02001000u), BandWire.field(1, 1uL) + BandWire.field(2, random(16)))),
            )
        }
        return emptyList()
    }

    private fun streamRequest(id: ULong, enabled: Boolean?): ByteArray {
        val control = when (enabled) {
            true -> streamControl(motion)
            // Stopping turns every stream off, whichever were on.
            false -> ALL_STREAM_FIELDS.fold(ByteArray(0)) { off, field -> off + BandWire.field(field, 0uL) }
            null -> ByteArray(0)
        }
        return encrypt(
            BandWire.frame(
                streamChannel,
                if (id == 2uL) listOf(0x8100ce56u, 0x02000314u) else emptyList(),
                BandWire.field(1, id) + BandWire.field(4, control),
            ),
        )
    }

    private fun engagementEvents(time: Double): List<BandEvent> {
        if (dial.engaged == emittedEngagement) return emptyList()
        emittedEngagement = dial.engaged
        dialPending = 0.0
        lastDial = Double.NEGATIVE_INFINITY
        return listOf(BandEvent(BandEvent.Payload.DialState(dial.engaged), time))
    }

    private fun input(frame: DataXFrame, time: Double, outgoing: ByteArrayOutputStream): List<BandEvent> {
        frame.words.lastOrNull()?.let { latest ->
            if (channelTypes.size >= 1024 && !channelTypes.containsKey(frame.channel)) {
                throw BandProtocolError("Too many band input channels")
            }
            channelTypes[frame.channel] = latest
        }
        val kind = channelTypes[frame.channel] ?: return emptyList()
        if (!streaming && startupFrames < 16) {
            startupFrames += 1
            log.info(
                "Band startup response: channel ${frame.channel}, type ${kind.toString(16)}, payload bytes ${frame.payload.size}",
            )
        }
        if (ceremony != null && setupStage == SetupStage.CEREMONY && !stopping) {
            return receiveCeremony(frame, time, outgoing)
        }
        if (enrollment != null && setupStage == SetupStage.IDENTITY && !stopping) {
            return receiveIdentity(frame, outgoing)
        }
        if (kind == 0x02001000u && route(frame.channel) == 0x8001 && setupStage == SetupStage.LINK && !stopping) {
            val fields = ProtoFields(frame.payload)
            if (!fields.contains(1) || fields.integer(1) == 0uL) throw BandProtocolError(BAND_BUSY)
            if (fields.integer(1) != 1uL) {
                throw BandProtocolError("The band couldn't finish setting up the connection. Try reconnecting.")
            }
            setupStage = SetupStage.DEVICE_INFO
            outgoing.write(
                encrypt(
                    BandWire.frame(
                        0x8003,
                        listOf(0x8100ce56u, 0x02000314u),
                        BandWire.field(1, 1uL) + BandWire.field(3, ByteArray(0)),
                    ),
                ),
            )
            return emptyList()
        }
        val route = route(frame.channel)
        if (route and 0x7fff == batteryChannel and 0x7fff && !stopping) {
            if (kind == 0x0300c001u) {
                batteryRequest = null
                batteryUnavailable = true
                return listOf(BandEvent(BandEvent.Payload.BatteryStatus(null), time))
            }
            val request = batteryRequest
            if (kind == 0x02000315u && request != null) {
                // Optional status errors must not interrupt gestures.
                val requestID = try {
                    ProtoFields(frame.payload).requiredInteger(1)
                } catch (e: Exception) {
                    null
                }
                if (requestID != request.id) return emptyList()
                batteryRequest = null
                val status = try {
                    BandBatteryStatus(response = frame.payload)
                } catch (e: Exception) {
                    null
                }
                return listOf(BandEvent(BandEvent.Payload.BatteryStatus(status), time))
            }
            return emptyList()
        }
        if (kind == 0x0300c001u && !stopping) {
            if (route == 3 && setupStage == SetupStage.DEVICE_INFO) {
                throw BandProtocolError("The band rejected gesture setup. Try reconnecting.")
            }
            if (route == 5 && setupStage == SetupStage.INPUT) {
                throw BandProtocolError("The band rejected the input subscription. Try reconnecting.")
            }
            if (route == 6 && hapticsRequest != null) {
                hapticsRequest = null
                return emptyList()
            }
            if (route == 6 && handRequest != null) {
                handRequest = null
                hand = null
                return listOf(
                    BandEvent(
                        BandEvent.Payload.HandednessFailure("The band couldn't report its hand setting. Reconnect and try again."),
                        time,
                    ),
                )
            }
            return emptyList()
        }
        // Ignore unrelated services without trying to interpret their protobuf schema.
        if (kind !in INPUT_KINDS) return emptyList()
        if (kind == 0x02000315u && route == 3 && setupStage == SetupStage.DEVICE_INFO && !stopping) {
            val fields = ProtoFields(frame.payload)
            val infoEvents = ArrayList<BandEvent>()
            BandDeviceInfo.find(fields)?.let {
                deviceInfo = it
                infoEvents.add(BandEvent(BandEvent.Payload.DeviceInfo(it), time))
            }
            if (fields.requiredInteger(1) != 1uL) return infoEvents
            if (fields.requiredInteger(2) != 1uL) {
                throw BandProtocolError("The band rejected gesture setup. Try reconnecting.")
            }
            setupStage = SetupStage.INPUT
            outgoing.write(streamRequest(2uL, null))
            outgoing.write(streamRequest(3uL, true))
            outgoing.write(requestHand(null, reading = true, time = time))
            outgoing.write(requestActive())
            return infoEvents
        }
        if (setupStage != SetupStage.INPUT) return emptyList()
        if (kind == 0x02000315u && route and 0x7fff == configurationChannel and 0x7fff) {
            if (stopping) return emptyList()
            val fields = ProtoFields(frame.payload)
            val pendingHaptics = hapticsRequest
            if (pendingHaptics != null && fields.contains(1) && runCatching { fields.integer(1) }.getOrNull() == pendingHaptics.first) {
                hapticsRequest = null
                return emptyList()
            }
            return receiveHand(fields, time, outgoing)
        }
        if (kind == 0x02000315u && route != (streamChannel and 0x7fff)) return emptyList()
        if (kind == 0x02000315u) {
            val fields = ProtoFields(frame.payload)
            val request = fields.integer(1)
            val pendingMotion = motionRequest
            if (pendingMotion != null && request == pendingMotion.id) {
                motionRequest = null
                if (stopping) return emptyList()
                if (fields.integer(2) != 1uL || !fields.contains(5)) {
                    if (motionAfterRestart != null && pendingMotion.wanted != MotionStreams.NONE) {
                        // An earlier change was refused. The restart still goes out, then restores what is on now.
                        motionAfterRestart = motion
                    } else {
                        wantedMotion = null
                        motionAfterRestart = null
                    }
                    return listOf(
                        BandEvent(BandEvent.Payload.MotionStreamsChanged(motion, time - pendingMotion.sentAt, false), time),
                    )
                }
                val flags = ProtoFields(fields.bytes(5))
                if (flags.integer(3) != 1uL) throw BandProtocolError("The band input subscription stopped")
                motion = MotionStreams(gyro = flags.integer(6) == 1uL, orientation = flags.integer(8) == 1uL)
                val restore = motionAfterRestart
                if (motion == MotionStreams.NONE && restore != null) {
                    motionAfterRestart = null
                    wantedMotion = restore
                    outgoing.write(flushMotion(time))
                }
                return listOf(
                    BandEvent(
                        BandEvent.Payload.MotionStreamsChanged(motion, time - pendingMotion.sentAt, motion == pendingMotion.wanted),
                        time,
                    ),
                )
            }
            if (request == 3uL || request == 5uL) {
                if (stopping) return emptyList()
                if (fields.integer(2) != 1uL) throw BandProtocolError("The band rejected the input subscription")
                val flags = ProtoFields(fields.bytes(5))
                streamsEnabled = streamFields.all { flags.contains(it) && flags.integer(it) == 1uL }
                if (!streamsEnabled) throw BandProtocolError("The band input subscription stopped")
                if (!streaming) {
                    streaming = true
                    return listOf(BandEvent(BandEvent.Payload.Connected, time))
                }
            } else if (request == 4uL && fields.integer(2) == 1uL && fields.contains(5)) {
                val flags = ProtoFields(fields.bytes(5))
                stopAcknowledged = ALL_STREAM_FIELDS.all { flags.contains(it) && flags.integer(it) == 0uL }
            }
            return emptyList()
        }
        if (stopping) return emptyList()
        val fields = ProtoFields(frame.payload)
        val sequence = fields.requiredInteger(1)
        val timestamp = fields.requiredInteger(2)
        val events = ArrayList<BandEvent>()
        if (kind == 0x0200020du) {
            fun name(field: Int, names: List<String>): String {
                val value = fields.integer(field)
                return if (value < names.size.toULong()) names[value.toInt()] else "unrecognized:$value"
            }
            val gesture = BandGesture(
                sequence = sequence,
                timestampUs = timestamp,
                finger = name(3, FINGERS),
                action = name(4, ACTIONS),
                derivedAction = name(5, DERIVED_ACTIONS),
                synthetic = fields.integer(12) != 0uL,
                receivedAt = time,
            )
            events.add(BandEvent(BandEvent.Payload.Gesture(gesture), time))
            dial.gesture(gesture, time)
            events += engagementEvents(time)
        } else {
            val bytes = fields.bytes(3, if (kind == 0x0200020fu) 6 else 16)
            motionMessages += 1
            if (!streaming) {
                streaming = true
                events.add(BandEvent(BandEvent.Payload.Connected, time))
                events.add(BandEvent(BandEvent.Payload.Heartbeat, time))
                lastHeartbeat = time
            }
            if (kind == 0x0200020fu) {
                fun axis(index: Int): Double =
                    ((bytes[index * 2].toInt() and 0xff) or (bytes[index * 2 + 1].toInt() shl 8)).toShort().toDouble()
                val values = Vector3(axis(0), axis(1), axis(2))
                val delta = dial.gyro(timestamp, values, time)
                events += engagementEvents(time)
                events.add(BandEvent(BandEvent.Payload.Gyro(timestamp, values), time))
                if (delta != null) {
                    dialPending += delta
                    if (time - lastDial >= 0.02) {
                        events.add(BandEvent(BandEvent.Payload.DialTurn(dialPending), time))
                        lastDial = time
                        dialPending = 0.0
                    }
                }
            } else {
                val values = FloatArray(4) {
                    Float.fromBits(
                        (bytes[it * 4].toInt() and 0xff) or ((bytes[it * 4 + 1].toInt() and 0xff) shl 8) or
                            ((bytes[it * 4 + 2].toInt() and 0xff) shl 16) or ((bytes[it * 4 + 3].toInt() and 0xff) shl 24),
                    )
                }
                var norm = 0f
                for (value in values) norm += value * value
                if (!values.all { it.isFinite() } || norm !in 0.9f..1.1f) {
                    throw BandProtocolError("Invalid band orientation sample")
                }
                val quaternion = Quaternion(values[0].toDouble(), values[1].toDouble(), values[2].toDouble(), values[3].toDouble())
                events.add(BandEvent(BandEvent.Payload.Orientation(timestamp, quaternion), time))
            }
        }
        events.add(BandEvent(BandEvent.Payload.DataSeen, time))
        return events
    }

    private companion object {
        val ACTIVE_REQUEST: ULong = 1uL shl 20
        const val BAND_BUSY = "The band refused the connection: it is probably connected to another device (your phone or the Meta AI app). Disconnect it there and it reconnects here."

        fun route(channel: Int): Int = channel and 0x80ff

        val ALL_STREAM_FIELDS = listOf(3, 6, 8)
        /** RPC replies, gestures, gyro and orientation. Raw EMG (0x0200020a) is never requested. */
        val INPUT_KINDS = setOf(0x02000315u, 0x0200020du, 0x0200020fu, 0x02000212u)
        val FINGERS = listOf("unknown", "thumb", "index", "middle", "notApplicable")
        val ACTIONS = listOf(
            "unknown", "press", "release", "tap", "doubletap", "click", "up", "down", "left", "right", "wake",
            "swipeIn", "swipeOut", "ia", "partialPress", "partialRelease", "partialClick", "partialUp",
            "partialDown", "partialLeft", "partialRight",
        )
        val DERIVED_ACTIONS = listOf(
            "unknown", "singleTap", "doubleTap", "buttonHold", "buttonRelease", "buttonUp", "buttonDown",
            "buttonLeft", "buttonRight", "buttonPress", "buttonHoldRelease",
        )
        private val secureRandom = SecureRandom()

        fun random(count: Int): ByteArray = ByteArray(count).also { secureRandom.nextBytes(it) }

        /**
         * The confirmed transcript digest is
         * SHA256(SHA256(receiver challenge || receiver key) || SHA256(sender seed || sender key)).
         * This returns the outer hash's input: SHA256withECDSA over it signs that digest.
         */
        fun trustMessage(challenge: ByteArray, receiver: ByteArray, seed: ByteArray, sender: ByteArray): ByteArray =
            sha256(challenge + receiver) + sha256(seed + sender)
    }
}
