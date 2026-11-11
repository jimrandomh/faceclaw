// Ported from callbacked/kinesis (MIT, Copyright (c) 2026 callbacked): Tests/KinesisCoreTests/BandModelCaptureTests.swift.
package com.faceclaw.app.neuralband

import com.faceclaw.app.neuralband.BandModelCapture.Operation as Op
import kotlin.math.abs
import kotlin.math.ln
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

private fun field(number: Int, value: ULong) = BandWire.field(number, value)
private fun field(number: Int, bytes: ByteArray) = BandWire.field(number, bytes)

private fun sample(sequence: ULong = 0uL, count: Int = 100, value: Float = (-ln(100.0)).toFloat()): BandInferenceSample {
    var data = EMPTY
    repeat(count) { data += value.le() }
    return BandInferenceSample(
        field(1, sequence) + field(2, 1_000_000uL + sequence * 156_250uL) + field(3, data) +
            field(7, 84_000uL) + field(10, 3uL),
    )
}

/** Response layouts match the observed RPC/Uniband schema, including omitted zero defaults. */
private fun reply(request: BandModelCapture.Request, readback: ULong? = null, code: ULong = 0uL): ByteArray {
    val payload = when (val operation = request.operation) {
        is Op.Streams -> field(
            5,
            listOf(3, 4, 6, 22, 23).fold(EMPTY) { bytes, number ->
                bytes + field(number, if (number == 3 || number == 6 || operation.enabled) 1uL else 0uL)
            },
        )
        Op.Claim -> field(14, field(1, field(1, 38uL)))
        is Op.Info -> {
            val name = if (operation.id == 27) "data-collection" else "data-collection-model"
            field(14, field(2, field(4, operation.id.toULong()) + field(3, name.toByteArray())))
        }
        is Op.Write -> field(14, field(3, field(1, operation.id.toULong()) + field(2, 1uL) + field(3, code)))
        is Op.Snapshot -> {
            // A band in its normal mode, unless the test says otherwise.
            val value = readback ?: if (operation.id == 27) 0uL else 2uL
            val scalar = if (value == 0uL) EMPTY else field(1, value)
            field(
                14,
                field(3, field(1, operation.id.toULong()) + field(3, code) + field(if (operation.id == 27) 8 else 11, scalar)),
            )
        }
        is Op.Read -> {
            val value = readback ?: operation.expected
            val scalar = if (value == 0uL) EMPTY else field(1, value)
            field(
                14,
                field(3, field(1, operation.id.toULong()) + field(3, code) + field(if (operation.id == 27) 8 else 11, scalar)),
            )
        }
        Op.Config -> field(6, field(46, field(3, 2uL) + field(5, 9uL)))
    }
    return field(1, request.id) + field(2, 1uL) + payload
}

private fun prepare(capture: BandModelCapture, model: ULong? = null) {
    capture.start(0.0)
    var now = 0.0
    while (true) {
        val request = capture.next(now) ?: break
        val readback = if (request.operation == Op.Snapshot(28)) model else null
        assertTrue(capture.receive(request.channel and 0x7fff, reply(request, readback), now + 0.01))
        now += 0.02
    }
}

/** Runs a restore to its end and returns the operations it sent. */
private fun restored(capture: BandModelCapture, start: Double, dropping: Op? = null): List<Op> {
    capture.restore(start)
    val seen = ArrayList<Op>()
    var now = start
    var dropOnce = dropping
    while (true) {
        val request = capture.next(now) ?: break
        seen.add(request.operation)
        if (request.operation == dropOnce) {
            dropOnce = null
            now += 6 // no answer: the request times out
            continue
        }
        capture.receive(request.channel and 0x7fff, reply(request), now + 0.01)
        now += 0.02
    }
    return seen
}

class BandModelCaptureTest {
    @Test
    fun restorationWritesBackTheBandsOwnModel() {
        val capture = BandModelCapture()
        prepare(capture, model = 3uL)
        for (i in 0 until 5) capture.receive(sample(i.toULong()), 1.0)
        capture.next(1.0)
        assertEquals(
            listOf(Op.Write(28, 3uL), Op.Write(27, 0uL), Op.Read(28, 3uL), Op.Read(27, 0uL), Op.Config, Op.Streams(false)),
            restored(capture, 2.0),
        )
        assertTrue(capture.status.restorationVerified)
    }

    @Test
    fun aBandLeftInTheRecordingModelGoesBackToTheNormalOne() {
        val capture = BandModelCapture()
        prepare(capture, model = 5uL)
        assertEquals(listOf(Op.Write(28, 2uL), Op.Write(27, 0uL)), restored(capture, 2.0).take(2))
    }

    @Test
    fun oneLostRestoreAnswerIsTriedAgain() {
        val capture = BandModelCapture()
        prepare(capture)
        val seen = restored(capture, 2.0, dropping = Op.Write(28, 2uL))
        assertEquals(listOf(Op.Write(28, 2uL), Op.Write(28, 2uL)), seen.take(2))
        assertTrue(capture.status.phase == BandModelCaptureStatus.Phase.FINISHED && capture.status.restorationVerified)
    }

    @Test
    fun inferenceDecodesItsOwnPipelineAndPreservesPayload() {
        val value = sample(12uL)
        assertTrue(value.pipeline == 3uL && value.sequence == 12uL && value.timestampUs == 2_875_000uL)
        assertEquals(84_000uL, value.latencyUs)
        assertTrue(value.values.size == 100 && abs(value.values[17] + ln(100.0)) < 0.00001)
        assertTrue(value.isTextDistribution)
        assertArrayEquals(value.values, BandInferenceSample(value.payload).values, 0f)
        assertFalse(sample(count = 9).isTextDistribution)
        assertThrows(BandProtocolError::class.java) { sample(value = Float.NaN) }
    }

    @Test
    fun modelReadinessRequiresConfirmedConfigurationAndActualSamples() {
        val capture = BandModelCapture()
        prepare(capture)
        assertEquals(BandModelCaptureStatus.Phase.PREPARING, capture.status.phase)
        for (i in 0 until 5) capture.receive(sample(i.toULong()), 1.0)
        assertNull(capture.next(1.0))
        assertEquals(BandModelCaptureStatus.Phase.READY, capture.status.phase)
        capture.restore(2.0)
        val seen = ArrayList<Op>()
        var now = 2.0
        while (true) {
            val request = capture.next(now) ?: break
            seen.add(request.operation)
            capture.receive(request.channel and 0x7fff, reply(request), now + 0.01)
            now += 0.02
        }
        assertEquals(
            listOf(Op.Write(28, 2uL), Op.Write(27, 0uL), Op.Read(28, 2uL), Op.Read(27, 0uL), Op.Config, Op.Streams(false)),
            seen,
        )
        assertTrue(capture.status.phase == BandModelCaptureStatus.Phase.FINISHED && capture.status.restorationVerified)
        assertTrue(!capture.streamWanted && !capture.status.active)
    }

    @Test
    fun restorationContinuesAfterBadReadbackButDoesNotClaimSuccess() {
        val capture = BandModelCapture()
        prepare(capture)
        capture.restore(1.0)
        var now = 1.0
        var off = false
        while (true) {
            val request = capture.next(now) ?: break
            val wrong = if (request.operation == Op.Read(28, 2uL)) 5uL else null
            capture.receive(request.channel and 0x7fff, reply(request, wrong), now + 0.01)
            if (request.operation == Op.Streams(false)) off = true
            now += 0.02
        }
        assertTrue(off && capture.status.phase == BandModelCaptureStatus.Phase.FINISHED)
        assertFalse(capture.status.restorationVerified)
        assertEquals(true, capture.status.problem?.contains("readback"))
    }

    @Test
    fun cancellationBeforeMutationStillStopsSubscriptionAndIgnoresStaleReplies() {
        val capture = BandModelCapture()
        capture.start(0.0)
        val old = capture.next(0.0)!!
        capture.restore(0.1)
        val stop = capture.next(0.1)!!
        assertEquals(Op.Streams(false), stop.operation)
        assertFalse(capture.receive(old.channel, reply(old), 0.11))
        assertEquals(stop.id, capture.pending?.id)
        capture.receive(stop.channel, reply(stop), 0.12)
        capture.next(0.13)
        assertTrue(capture.status.restorationVerified)
    }

    @Test
    fun timeoutAfterModelWriteAttemptsRestorationWithBoundedFailure() {
        val capture = BandModelCapture()
        capture.start(0.0)
        var time = 0.0
        while (true) {
            val request = capture.next(time) ?: break
            if (request.operation == Op.Write(28, 5uL)) break
            capture.receive(request.channel, reply(request), time + 0.01)
            time += 0.02
        }
        val restoring = capture.next(time + 6)!!
        assertEquals(Op.Write(28, 2uL), restoring.operation)
        assertEquals(BandModelCaptureStatus.Phase.RESTORING, capture.status.phase)
        capture.next(time + 50)
        assertTrue(capture.status.phase == BandModelCaptureStatus.Phase.FINISHED && !capture.status.restorationVerified)
    }

    @Test
    fun recoveryOnANewConnectionChecksSchemaThenWritesAndReadsNormalSettings() {
        val capture = BandModelCapture()
        capture.recoverNormalMode(0.0)
        val seen = ArrayList<Op>()
        var now = 0.0
        while (true) {
            val request = capture.next(now) ?: break
            seen.add(request.operation)
            capture.receive(request.channel, reply(request), now + 0.01)
            now += 0.02
        }
        assertEquals(
            listOf(
                Op.Claim, Op.Info(27), Op.Info(28), Op.Write(28, 2uL), Op.Write(27, 0uL),
                Op.Read(28, 2uL), Op.Read(27, 0uL), Op.Config, Op.Streams(false),
            ),
            seen,
        )
        assertTrue(capture.status.restorationVerified && !capture.status.active)
        assertFalse(capture.streamWanted)
    }

    @Test
    fun recoveryNeverWritesAfterRejectedOrTimedOutSchemaCheck() {
        for (rejected in listOf(true, false)) {
            val capture = BandModelCapture()
            capture.recoverNormalMode(0.0)
            val claim = capture.next(0.0)!!
            capture.receive(claim.channel, reply(claim), 0.01)
            val info = capture.next(0.02)!!
            if (rejected) capture.receive(info.channel, field(1, info.id) + field(2, 2uL), 0.03)
            assertNull(capture.next(6.0))
            assertTrue(capture.status.phase == BandModelCaptureStatus.Phase.FINISHED && !capture.status.restorationVerified)
        }
    }
}
