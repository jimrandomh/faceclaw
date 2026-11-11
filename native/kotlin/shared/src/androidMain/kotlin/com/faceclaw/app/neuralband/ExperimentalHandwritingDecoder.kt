// Ported from callbacked/kinesis (MIT, Copyright (c) 2026 callbacked): Sources/KinesisCore/ExperimentalHandwritingDecoder.swift,
// by way of tetramo-labs/glassly (MIT).
package com.faceclaw.app.neuralband

import java.text.BreakIterator

/**
 * Candidate interpretation of pipeline 3, pending validation on the consumer band.
 * The class order and CTC blank follow Meta's public research character set:
 * https://github.com/facebookresearch/generic-neuromotor-interface/blob/6d1de94afdfe0c921d08dd24933a5c8d11e8307a/generic_neuromotor_interface/handwriting_utils.py
 * Matching dimensions alone do not establish firmware compatibility.
 */
class ExperimentalHandwritingDecoder {
    enum class PreviewAction { TENTATIVE_BOUNDARY, SPACE, BACKSPACE, NEWLINE, SHIFT }

    var text = ""
        private set
    var rawText = ""
        private set
    var discontinuities = 0
        private set
    private var previousLabel: Int? = null
    private var previousSequence: ULong? = null
    private var previousTimestamp: ULong? = null
    private var shifted = false

    /**
     * Returns a newly emitted class, preserving its original glyph for inspection.
     * Editing affects only the preview, never another app's keyboard input.
     */
    fun consume(sample: BandInferenceSample): Int? {
        if (!sample.isTextDistribution) return null
        if (sample.sequence == previousSequence && sample.timestampUs == previousTimestamp) return null
        val sequence = previousSequence
        val timestamp = previousTimestamp
        if (sequence != null && timestamp != null &&
            (sample.sequence != ((sequence + 1uL) and 0xFFFFFFFFuL) || sample.timestampUs <= timestamp)
        ) {
            previousLabel = null
            discontinuities += 1
        }
        previousSequence = sample.sequence
        previousTimestamp = sample.timestampUs
        var label = 0
        for (index in sample.values.indices) {
            if (sample.values[label] < sample.values[index]) label = index
        }
        val oldLabel = previousLabel
        previousLabel = label
        if (label == BLANK || label == oldLabel) return null
        rawText += CHARACTERS[label]
        when (PREVIEW_ACTIONS[label]) {
            PreviewAction.TENTATIVE_BOUNDARY -> {}
            PreviewAction.SHIFT -> shifted = true
            PreviewAction.SPACE -> {
                text += " "
                shifted = false
            }
            PreviewAction.BACKSPACE -> if (text.isNotEmpty()) text = text.dropLastCharacter()
            PreviewAction.NEWLINE -> {
                text += "\n"
                shifted = false
            }
            null -> {
                text += if (shifted) CHARACTERS[label].uppercase() else CHARACTERS[label]
                shifted = false
            }
        }
        return label
    }

    /** Keep collapse state so clearing during a held output cannot duplicate it. */
    fun clearText() = resetText("")

    /** A trial can seed editing context without inventing a new CTC boundary. */
    fun resetText(initialText: String) {
        text = initialText
        rawText = ""
        shifted = false
    }

    companion object {
        val CHARACTERS: List<String> =
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!\"#\$%&'()*+,-./:;<=>?@[\\]^_`{|}~"
                .map { it.toString() } +
                // backspace, return, space, shift, pinch
                listOf("⌫", "⏎", " ", "⇧", "🤏")
        const val BLANK = 99

        // Class 87 follows letters and editing gestures in desk recordings. Its
        // precise firmware meaning is unknown; the preview treats it as a boundary.
        // The wearer identified class 88's forward gesture as space and 94 as delete.
        // An up arrow gives 97 (shift): it capitalizes the next letter. 98 (pinch) has no known
        // meaning yet, so it adds nothing to the text.
        val PREVIEW_ACTIONS: Map<Int, PreviewAction> = mapOf(
            87 to PreviewAction.TENTATIVE_BOUNDARY, 88 to PreviewAction.SPACE, 94 to PreviewAction.BACKSPACE,
            95 to PreviewAction.NEWLINE, 96 to PreviewAction.SPACE, 97 to PreviewAction.SHIFT,
            98 to PreviewAction.TENTATIVE_BOUNDARY,
        )
    }
}

/** Swift's `removeLast()` on a String drops one grapheme cluster. */
private fun String.dropLastCharacter(): String {
    val iterator = BreakIterator.getCharacterInstance()
    iterator.setText(this)
    val start = iterator.preceding(length)
    return if (start == BreakIterator.DONE) "" else substring(0, start)
}
