// Ported from callbacked/kinesis (MIT, Copyright (c) 2026 callbacked): Tests/KinesisCoreTests/ExperimentalHandwritingDecoderTests.swift.
package com.faceclaw.app.neuralband

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val BACKSPACE = "⌫"
private const val RETURN = "⏎"
private const val SHIFT = "⇧"
private const val PINCH = "🤏"

private fun handwritingSample(label: Int, sequence: ULong, timestamp: ULong? = null, pipeline: ULong = 3uL): BandInferenceSample {
    var bytes = EMPTY
    for (index in 0 until 100) bytes += (if (index == label) 0f else -100f).le()
    return BandInferenceSample(
        BandWire.field(1, sequence) + BandWire.field(2, timestamp ?: (sequence * 156_250uL + 1uL)) +
            BandWire.field(3, bytes) + BandWire.field(10, pipeline),
    )
}

class ExperimentalHandwritingDecoderTest {
    @Test
    fun candidateHandwritingAlphabetHasExpectedClassBoundaries() {
        val chars = ExperimentalHandwritingDecoder.CHARACTERS
        assertEquals(ExperimentalHandwritingDecoder.BLANK, chars.size)
        assertEquals(
            listOf("a", "z", "A", "Z", "0", "9", "!", "~", BACKSPACE, RETURN, " ", SHIFT, PINCH),
            listOf(0, 25, 26, 51, 52, 61, 62, 93, 94, 95, 96, 97, 98).map { chars[it] },
        )
    }

    @Test
    fun candidateCTCCollapsesRunsButKeepsBlankSeparatedRepeats() {
        val decoder = ExperimentalHandwritingDecoder()
        for ((sequence, label) in listOf(99, 7, 7, 4, 11, 11, 99, 11, 14, 99).withIndex()) {
            decoder.consume(handwritingSample(label, sequence.toULong()))
        }
        assertTrue(decoder.text == "hello" && decoder.rawText == "hello")
        assertEquals(0, decoder.discontinuities)
    }

    @Test
    fun handwritingClearAndDuplicateFramesDoNotEmitHeldCharacters() {
        val decoder = ExperimentalHandwritingDecoder()
        val first = handwritingSample(0, 1uL)
        assertEquals(0, decoder.consume(first))
        decoder.clearText()
        assertNull(decoder.consume(first))
        assertNull(decoder.consume(handwritingSample(0, 2uL)))
        assertTrue(decoder.text == "" && decoder.rawText == "")
        decoder.consume(handwritingSample(99, 3uL))
        assertEquals(0, decoder.consume(handwritingSample(0, 4uL)))
        assertEquals("a", decoder.text)
    }

    @Test
    fun handwritingDiscontinuitiesBreakCollapseAndSequenceWrapIsContinuous() {
        val decoder = ExperimentalHandwritingDecoder()
        decoder.consume(handwritingSample(0, UInt.MAX_VALUE.toULong(), timestamp = 100uL))
        decoder.consume(handwritingSample(0, 0uL, timestamp = 200uL))
        assertTrue(decoder.text == "a" && decoder.discontinuities == 0)
        decoder.consume(handwritingSample(0, 2uL, timestamp = 400uL))
        assertTrue(decoder.text == "aa" && decoder.discontinuities == 1)
        decoder.consume(handwritingSample(1, 0uL, timestamp = 1uL))
        assertTrue(decoder.text == "aab" && decoder.discontinuities == 2)
        assertNull(decoder.consume(handwritingSample(2, 1uL, pipeline = 2uL)))
        assertEquals("aab", decoder.text)
    }

    @Test
    fun handwritingEditingGesturesChangePreviewAndPreserveRawTokens() {
        val decoder = ExperimentalHandwritingDecoder()
        val labels = listOf(94, 94, 99, 7, 8, 87, 88, 88, 87, 19, 87, 94, 94, 87, 94, 87, 88, 87, 95, 97, 98)
        for ((sequence, label) in labels.withIndex()) {
            decoder.consume(handwritingSample(label, sequence.toULong()))
            if (sequence == 7) assertEquals("hi ", decoder.text)
            if (sequence == 12) assertEquals("hi ", decoder.text)
            if (sequence == 14) assertEquals("hi", decoder.text)
        }
        // Shift waits for the next letter, and pinch adds nothing.
        assertEquals("hi \n", decoder.text)
        assertEquals("${BACKSPACE}hi^_^t^$BACKSPACE^$BACKSPACE^_^$RETURN$SHIFT$PINCH", decoder.rawText)
        assertEquals(0, decoder.discontinuities)
    }

    @Test
    fun anUpArrowCapitalizesTheNextLetterOnly() {
        val decoder = ExperimentalHandwritingDecoder()
        // Shift h i, space, shift a: "Hi A". A blank between repeats, as the model emits them.
        for ((sequence, label) in listOf(97, 7, 8, 88, 97, 99, 0).withIndex()) {
            decoder.consume(handwritingSample(label, sequence.toULong()))
        }
        assertEquals("Hi A", decoder.text)
    }

    @Test
    fun tentativeHandwritingBoundarySeparatesRepeatedLettersWithoutPrintingCarets() {
        val decoder = ExperimentalHandwritingDecoder()
        for ((sequence, label) in listOf(11, 87, 87, 11, 96, 14).withIndex()) {
            decoder.consume(handwritingSample(label, sequence.toULong()))
        }
        assertEquals("ll o", decoder.text)
        assertEquals("l^l o", decoder.rawText)
    }
}
