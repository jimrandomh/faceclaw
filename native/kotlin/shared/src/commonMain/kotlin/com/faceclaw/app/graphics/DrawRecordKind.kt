package com.faceclaw.app

/** TS/native bridge tags, not firmware draw opcodes. Keep in sync with presentation-wire.ts. */
object DrawRecordKind {
    const val GLYPH = 0
    const val TEXTURE_IMAGE = 1
    const val FIRMWARE_TEXT = 2
    const val MENU_SELECTION = 3
    const val TRANSPARENT_IMAGE = 4
    const val MASKED_IMAGE = 5
    const val DISPLAY_LIST = 7
    /** [dim u16, 256 = none]: the presentations after it are the window's overlay (see ShellScene.overlay). */
    const val WINDOW_OVERLAY = 8

    fun isPresentation(kind: Int): Boolean = when (kind) {
        MENU_SELECTION, TRANSPARENT_IMAGE, MASKED_IMAGE, DISPLAY_LIST -> true
        else -> false
    }
}
