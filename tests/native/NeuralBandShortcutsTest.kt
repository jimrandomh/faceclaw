package com.faceclaw.app

fun main() {
    val defaults = NeuralBandShortcuts.read { null }
    check(NeuralBandShortcuts.nativeMapping(defaults) ==
        "index_tap=select;middle_tap=back;index_double=double-click;middle_double=middle-double;" +
        "index_triple=pc.pointer;middle_triple=middle-triple;" +
        "index_hold_start=index-hold-start;index_hold_release=index-hold-end;index_hold_cancel=index-hold-cancel;" +
        "middle_hold_start=middle-hold-start;middle_hold_release=;middle_hold_cancel=;" +
        "swipe_up=scroll-up;swipe_down=scroll-down;swipe_left=scroll-up;swipe_right=scroll-down;" +
        "dial_up=scroll-up;dial_down=scroll-down")
    check(NeuralBandShortcuts.assign(defaults, GestureShortcut.INDEX_SINGLE, ShortcutAction.POINTER) == null)
    check(NeuralBandShortcuts.assign(defaults, GestureShortcut.INDEX_DOUBLE, ShortcutAction.DICTATION) == null)
    check(NeuralBandShortcuts.assign(defaults, GestureShortcut.DIAL_UP, ShortcutAction.SCREEN_TOGGLE) == null)
    val pointerMoved = checkNotNull(NeuralBandShortcuts.assign(defaults, GestureShortcut.MIDDLE_DOUBLE, ShortcutAction.POINTER))
    check(pointerMoved[GestureShortcut.INDEX_TRIPLE] == ShortcutAction.SWITCHER)
    check(NeuralBandShortcuts.pointerShortcut(pointerMoved) == GestureShortcut.MIDDLE_DOUBLE)

    val dictationMoved = checkNotNull(NeuralBandShortcuts.assign(defaults, GestureShortcut.MIDDLE_HOLD, ShortcutAction.DICTATION))
    val mapping = NeuralBandShortcuts.nativeMapping(dictationMoved)
    check("index_hold_start=middle-hold-start;index_hold_release=;index_hold_cancel=" in mapping)
    check("middle_hold_start=index-hold-start;middle_hold_release=index-hold-end;middle_hold_cancel=index-hold-cancel" in mapping)
    check(NeuralBandShortcuts.assign(dictationMoved, GestureShortcut.MIDDLE_HOLD, ShortcutAction.SCREEN_TOGGLE)?.let {
        "middle_hold_start=screen-toggle;middle_hold_release=;middle_hold_cancel=" in NeuralBandShortcuts.nativeMapping(it)
    } == true)
    check(NeuralBandShortcuts.assign(defaults, GestureShortcut.MIDDLE_SINGLE, ShortcutAction.LAUNCHER)?.let {
        "middle_tap=middle-triple" in NeuralBandShortcuts.nativeMapping(it)
    } == true)

    val restored = NeuralBandShortcuts.read { slot ->
        when (slot) {
            GestureShortcut.INDEX_DOUBLE -> "corrupt"
            GestureShortcut.MIDDLE_DOUBLE -> "DICTATION"
            GestureShortcut.MIDDLE_TRIPLE -> "NONE"
            else -> null
        }
    }
    check(restored[GestureShortcut.INDEX_DOUBLE] == ShortcutAction.DOUBLE_TAP)
    check(restored[GestureShortcut.MIDDLE_DOUBLE] == ShortcutAction.SWITCHER)
    check(restored[GestureShortcut.MIDDLE_TRIPLE] == ShortcutAction.NONE)
}
