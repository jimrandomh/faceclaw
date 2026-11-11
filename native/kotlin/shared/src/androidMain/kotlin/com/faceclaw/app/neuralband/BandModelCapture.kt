// Ported from callbacked/kinesis (MIT, Copyright (c) 2026 callbacked): Sources/KinesisCore/BandModelCapture.swift,
// by way of tetramo-labs/glassly (MIT).
package com.faceclaw.app.neuralband

import kotlin.math.abs
import kotlin.math.exp

/**
 * The capture's problem when the band's model-control service has fewer than the 28 settings it
 * uses (27 and 28 among them): the firmware has no handwriting controls. Faceclaw: a named
 * constant so the controller can tell this apart from a transient failure.
 */
const val BAND_NO_MODEL_CONTROLS = "model controls are unavailable on this band"

/** Original inference payload plus its schema fields. Output indices are not character labels. */
class BandInferenceSample(val payload: ByteArray) {
    val sequence: ULong
    val timestampUs: ULong
    val pipeline: ULong
    val latencyUs: ULong?
    val values: FloatArray

    init {
        val fields = ProtoFields(payload)
        sequence = fields.requiredInteger(1)
        timestampUs = fields.requiredInteger(2)
        pipeline = fields.requiredInteger(10)
        if (sequence > UInt.MAX_VALUE.toULong() || pipeline > UInt.MAX_VALUE.toULong()) {
            throw BandProtocolError("Invalid inference sample identifier")
        }
        latencyUs = if (fields.contains(7)) fields.integer(7) else null
        val bytes = fields.bytes(3)
        if (bytes.isEmpty() || bytes.size % 4 != 0 || bytes.size > 4096) {
            throw BandProtocolError("Invalid inference sample dimensions")
        }
        values = FloatArray(bytes.size / 4) {
            val offset = it * 4
            Float.fromBits(
                (bytes[offset].toInt() and 0xff) or
                    ((bytes[offset + 1].toInt() and 0xff) shl 8) or
                    ((bytes[offset + 2].toInt() and 0xff) shl 16) or
                    ((bytes[offset + 3].toInt() and 0xff) shl 24),
            )
        }
        if (!values.all { it.isFinite() }) throw BandProtocolError("Nonfinite inference sample")
    }

    val isTextDistribution: Boolean
        get() = pipeline == 3uL && values.size == 100 && values.all { it <= 0.000001f } &&
            abs(values.fold(0.0) { sum, value -> sum + exp(value.toDouble()) } - 1) < 0.0001
}

data class BandModelCaptureStatus(
    val phase: Phase,
    val message: String,
    val problem: String? = null,
    val restorationVerified: Boolean = false,
) {
    enum class Phase { IDLE, PREPARING, READY, RESTORING, FINISHED }

    val active: Boolean get() = phase == Phase.PREPARING || phase == Phase.READY || phase == Phase.RESTORING

    companion object {
        val IDLE = BandModelCaptureStatus(Phase.IDLE, "", null, false)
    }
}

/**
 * Matched RPCs and independent readbacks for one temporary built-in-model recording.
 * It owns no transport: BandSession sends these requests on its existing connection.
 */
internal class BandModelCapture {
    sealed class Operation {
        data class Streams(val enabled: Boolean) : Operation()
        object Claim : Operation()
        data class Info(val id: Int) : Operation()

        /** Reads a setting's value before the recording changes it. */
        data class Snapshot(val id: Int) : Operation()
        data class Write(val id: Int, val value: ULong) : Operation()
        data class Read(val id: Int, val expected: ULong) : Operation()
        object Config : Operation()
    }

    class Request(val id: ULong, val operation: Operation, val deadline: Double) {
        val channel: Int
            get() = when (operation) {
                is Operation.Streams -> 0x8005
                Operation.Config -> 0x8007
                else -> 0x8001
            }

        fun payload(streams: ByteArray): ByteArray {
            val arm: Int
            val body: ByteArray
            when (operation) {
                is Operation.Streams -> {
                    arm = 4
                    body = streams
                }
                Operation.Config -> {
                    arm = 5
                    body = ByteArray(0)
                }
                Operation.Claim -> {
                    arm = 14
                    body = BandWire.field(1, BandWire.field(1, 2uL))
                }
                is Operation.Info -> {
                    arm = 14
                    body = BandWire.field(2, BandWire.field(1, 2uL) + BandWire.field(2, operation.id.toULong()))
                }
                is Operation.Write -> {
                    arm = 14
                    body = BandWire.field(
                        3,
                        BandWire.field(1, operation.id.toULong()) + BandWire.field(2, 1uL) +
                            BandWire.field(if (operation.id == 27) 7 else 10, BandWire.field(1, operation.value)),
                    )
                }
                is Operation.Read -> {
                    arm = 14
                    body = BandWire.field(3, BandWire.field(1, operation.id.toULong()) + BandWire.field(2, 0uL))
                }
                is Operation.Snapshot -> {
                    arm = 14
                    body = BandWire.field(3, BandWire.field(1, operation.id.toULong()) + BandWire.field(2, 0uL))
                }
            }
            return BandWire.field(1, id) + BandWire.field(arm, body)
        }
    }

    var status = BandModelCaptureStatus.IDLE
        private set
    var streamWanted = false
        private set
    var streamTouched = false
        private set
    var pending: Request? = null
        private set
    private val operations = ArrayDeque<Operation>()
    private var nextID: ULong = 0x10000000uL
    private var mutated = false
    private val restoreErrors = ArrayList<String>()
    private var problem: String? = null
    private var samples = 0
    private var lastSample = 0.0
    private var deadline = Double.POSITIVE_INFINITY
    private val events = ArrayList<BandEvent>()
    private var checkingRecoverySchema = false

    /** The band's own values before this recording: data collection (27) and its model (28). */
    private val original = HashMap<Int, ULong>()

    /** One retry for a restore step whose answer went missing. */
    private var retriedRestore = false

    /**
     * What a restore writes back: the band's own values, unless they look like an unfinished
     * recording (collection on, or the handwriting model), then the known normal ones.
     */
    private val normalCollection: ULong get() = original[27]?.takeIf { it == 0uL } ?: 0uL
    private val normalModel: ULong get() = original[28]?.takeIf { it != 5uL } ?: 2uL

    fun start(time: Double) {
        if (status.active) throw BandProtocolError("A band model recording is already running")
        problem = null
        restoreErrors.clear()
        mutated = false
        samples = 0
        lastSample = time
        pending = null
        original.clear()
        retriedRestore = false
        operations.clear()
        operations.addAll(
            listOf(
                Operation.Streams(true), Operation.Claim, Operation.Info(27), Operation.Info(28),
                Operation.Snapshot(27), Operation.Snapshot(28), Operation.Write(27, 1uL), Operation.Write(28, 5uL),
                Operation.Read(27, 1uL), Operation.Read(28, 5uL), Operation.Config,
            ),
        )
        deadline = time + 40
        publish(BandModelCaptureStatus.Phase.PREPARING, "checking the band model…", time = time)
    }

    fun recoverNormalMode(time: Double) {
        if (status.active) throw BandProtocolError("A band model operation is already running")
        problem = null
        restoreErrors.clear()
        pending = null
        original.clear()
        retriedRestore = false
        mutated = true
        checkingRecoverySchema = true
        operations.clear()
        operations.addAll(
            listOf(
                Operation.Claim, Operation.Info(27), Operation.Info(28), Operation.Write(28, 2uL), Operation.Write(27, 0uL),
                Operation.Read(28, 2uL), Operation.Read(27, 0uL), Operation.Config, Operation.Streams(false),
            ),
        )
        deadline = time + 50
        publish(BandModelCaptureStatus.Phase.RESTORING, "recovering the band’s normal mode…", time = time)
    }

    fun restore(time: Double) {
        if (!status.active || status.phase == BandModelCaptureStatus.Phase.RESTORING) return
        pending = null
        operations.clear()
        if (mutated) {
            operations.addAll(
                listOf(
                    Operation.Write(28, normalModel), Operation.Write(27, normalCollection),
                    Operation.Read(28, normalModel), Operation.Read(27, normalCollection), Operation.Config,
                ),
            )
        }
        operations.add(Operation.Streams(false))
        deadline = time + 35
        publish(BandModelCaptureStatus.Phase.RESTORING, "restoring the band’s normal mode…", time = time)
    }

    fun next(time: Double): Request? {
        if (!status.active) return null
        if (time >= deadline) {
            // The whole operation ran out of time: never a retry, and never verified.
            fail("the band model operation timed out", time, retry = false)
            if (status.phase == BandModelCaptureStatus.Phase.RESTORING && time >= deadline) {
                operations.clear()
                pending = null
                complete(time)
            }
        }
        val waiting = pending
        if (waiting != null && time >= waiting.deadline) fail("the band did not answer a model request", time)
        if (pending != null || !status.active) return null
        if (operations.isNotEmpty()) {
            val operation = operations.removeFirst()
            if (operation is Operation.Streams) {
                streamTouched = true
                streamWanted = operation.enabled
            }
            if (operation is Operation.Write) mutated = true
            nextID += 1uL
            val request = Request(nextID, operation, time + 5)
            pending = request
            return request
        }
        if (status.phase == BandModelCaptureStatus.Phase.RESTORING) {
            complete(time)
        } else if (status.phase == BandModelCaptureStatus.Phase.PREPARING && samples >= 5 && time - lastSample < 2) {
            deadline = time + 360
            publish(BandModelCaptureStatus.Phase.READY, "band model ready", time = time)
        } else if (status.phase == BandModelCaptureStatus.Phase.READY && time - lastSample > 3) {
            fail("the band model stopped sending samples", time)
        }
        return null
    }

    fun receive(channel: Int, payload: ByteArray, time: Double): Boolean {
        val request = pending ?: return false
        if ((channel and 0x7fff) != (request.channel and 0x7fff)) return false
        try {
            val fields = ProtoFields(payload)
            if (fields.integer(1) != request.id) return false
            if (!(time < request.deadline) || fields.integer(2) != 1uL) {
                throw BandProtocolError("the band rejected or timed out a model request")
            }
            when (val operation = request.operation) {
                is Operation.Streams -> {
                    val flags = ProtoFields(fields.bytes(5))
                    val expected = if (operation.enabled) 1uL else 0uL
                    if (!listOf(4, 22, 23).all { flags.integer(it) == expected }) {
                        throw BandProtocolError("the band did not confirm model streams")
                    }
                }
                Operation.Claim -> {
                    val count = ProtoFields(ProtoFields(fields.bytes(14)).bytes(1))
                    if (count.integer(1) < 28uL) throw BandProtocolError(BAND_NO_MODEL_CONTROLS)
                }
                is Operation.Info -> {
                    val info = ProtoFields(ProtoFields(fields.bytes(14)).bytes(2))
                    val name = if (operation.id == 27) "data-collection" else "data-collection-model"
                    if (info.integer(4) != operation.id.toULong() || !info.bytes(3).contentEquals(name.toByteArray())) {
                        throw BandProtocolError("the band’s model controls differ from the supported schema")
                    }
                    if (operation.id == 28) checkingRecoverySchema = false
                }
                is Operation.Write, is Operation.Read, is Operation.Snapshot -> {
                    val id = when (operation) {
                        is Operation.Write -> operation.id
                        is Operation.Read -> operation.id
                        is Operation.Snapshot -> operation.id
                    }
                    val response = ProtoFields(ProtoFields(fields.bytes(14)).bytes(3))
                    val writing = operation is Operation.Write
                    if (response.integer(1) != id.toULong() || response.integer(2) != (if (writing) 1uL else 0uL) ||
                        response.integer(3) != 0uL
                    ) {
                        throw BandProtocolError("the band refused a model setting")
                    }
                    if (operation is Operation.Read) {
                        val value = ProtoFields(response.bytes(if (id == 27) 8 else 11))
                        if (value.integer(1) != operation.expected) throw BandProtocolError("model setting readback did not match")
                    }
                    if (operation is Operation.Snapshot) {
                        original[id] = ProtoFields(response.bytes(if (id == 27) 8 else 11)).integer(1)
                    }
                }
                Operation.Config -> {
                    ProtoFields(fields.bytes(6))
                    events.add(BandEvent(BandEvent.Payload.InferenceConfiguration(payload), time))
                }
            }
            pending = null
        } catch (e: Exception) {
            fail(e.message ?: e.javaClass.simpleName, time)
        }
        return true
    }

    fun receive(sample: BandInferenceSample, time: Double) {
        if (!status.active || sample.pipeline != 3uL || status.phase == BandModelCaptureStatus.Phase.RESTORING) return
        if (!sample.isTextDistribution) {
            fail("the band model output has an unsupported shape", time)
            return
        }
        samples += 1
        lastSample = time
        // A session runs as long as samples keep coming. Silence ends it within seconds.
        if (status.phase == BandModelCaptureStatus.Phase.READY) deadline = time + 360
    }

    fun drainEvents(): List<BandEvent> {
        val drained = events.toList()
        events.clear()
        return drained
    }

    private fun fail(message: String, time: Double, retry: Boolean = true) {
        val failed = pending?.operation
        pending = null
        if (retry && status.phase == BandModelCaptureStatus.Phase.RESTORING && !checkingRecoverySchema &&
            !retriedRestore && failed != null && failed != Operation.Claim
        ) {
            // One dropped packet must not leave the band in the recording's mode.
            retriedRestore = true
            operations.addFirst(failed)
            return
        }
        if (status.phase == BandModelCaptureStatus.Phase.RESTORING) {
            restoreErrors.add(message)
            // A restarted app must validate the control schema again before
            // writing values remembered from an earlier connection.
            if (checkingRecoverySchema) {
                operations.clear()
                checkingRecoverySchema = false
            }
        } else {
            problem = message
            restore(time)
        }
    }

    private fun complete(time: Double) {
        val verified = restoreErrors.isEmpty()
        if (!verified) problem = (listOfNotNull(problem) + restoreErrors).joinToString("; ")
        val message = if (verified) {
            if (mutated) "normal band mode restored" else "model unchanged; recording stopped"
        } else {
            "restoration could not be verified"
        }
        publish(BandModelCaptureStatus.Phase.FINISHED, message, verified = verified, time = time)
    }

    private fun publish(phase: BandModelCaptureStatus.Phase, message: String, verified: Boolean = false, time: Double) {
        status = BandModelCaptureStatus(phase, message, problem, verified)
        events.add(BandEvent(BandEvent.Payload.ModelCaptureState(status), time))
    }

}
