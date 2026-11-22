package com.faceclaw.app

/** TS/native bridge tags, not firmware draw opcodes. Keep in sync with presentation-wire.ts. */
object DrawRecordKind {
    const val GLYPH = 0
    const val TEXTURE_IMAGE = 1
    const val FIRMWARE_TEXT = 2
    // 3 was a selected menu row (rounded box + row image), retired for drawn-in-place rows.
    const val TRANSPARENT_IMAGE = 4
    const val MASKED_IMAGE = 5
    const val DISPLAY_LIST = 7

    fun isPresentation(kind: Int): Boolean = when (kind) {
        TRANSPARENT_IMAGE, MASKED_IMAGE, DISPLAY_LIST -> true
        else -> false
    }
}
