package com.faceclaw.app

internal enum class ShortcutAction(val nativeAction: String) {
    NONE(""),
    SELECT("select"),
    BACK("back"),
    DOUBLE_TAP("double-click"),
    SCROLL_UP("scroll-up"),
    SCROLL_DOWN("scroll-down"),
    POINTER("pc.pointer"),
    WRITING("index-triple"),
    SWITCHER("middle-double"),
    LAUNCHER("middle-triple"),
    SYSTEM_MENU("middle-hold-start"),
    CONTEXT_MENU("short-then-long-press"),
    DICTATION("index-hold-start"),
    SCREEN_TOGGLE("screen-toggle"),
}

internal enum class GestureShortcut(val nativeSlot: String, val defaultAction: ShortcutAction) {
    INDEX_SINGLE("index_tap", ShortcutAction.SELECT),
    MIDDLE_SINGLE("middle_tap", ShortcutAction.BACK),
    INDEX_DOUBLE("index_double", ShortcutAction.DOUBLE_TAP),
    MIDDLE_DOUBLE("middle_double", ShortcutAction.SWITCHER),
    INDEX_TRIPLE("index_triple", ShortcutAction.POINTER),
    MIDDLE_TRIPLE("middle_triple", ShortcutAction.LAUNCHER),
    INDEX_HOLD("index_hold", ShortcutAction.DICTATION),
    MIDDLE_HOLD("middle_hold", ShortcutAction.SYSTEM_MENU),
    SWIPE_UP("swipe_up", ShortcutAction.SCROLL_UP),
    SWIPE_DOWN("swipe_down", ShortcutAction.SCROLL_DOWN),
    SWIPE_LEFT("swipe_left", ShortcutAction.SCROLL_UP),
    SWIPE_RIGHT("swipe_right", ShortcutAction.SCROLL_DOWN),
    DIAL_UP("dial_up", ShortcutAction.SCROLL_UP),
    DIAL_DOWN("dial_down", ShortcutAction.SCROLL_DOWN);

    val isHold get() = this == INDEX_HOLD || this == MIDDLE_HOLD

    val choices get() = ShortcutAction.entries.filter { action ->
        when {
            // Wrist turns can emit several detents. Keep them repeatable.
            this == DIAL_UP || this == DIAL_DOWN -> action == ShortcutAction.NONE ||
                action == ShortcutAction.SCROLL_UP || action == ShortcutAction.SCROLL_DOWN
            // Keep the pointer's click and back pins intact, and only offer
            // gestures that can also turn the pointer off while it is active.
            action == ShortcutAction.POINTER -> nativeSlot.startsWith("swipe_") ||
                nativeSlot.endsWith("_double") || nativeSlot.endsWith("_triple")
            action == ShortcutAction.DICTATION -> isHold
            else -> true
        }
    }
}

internal object NeuralBandShortcuts {
    private val uniqueActions = setOf(ShortcutAction.POINTER, ShortcutAction.DICTATION)
    val nativeActions = ShortcutAction.entries.map { it.nativeAction }.filter { it.isNotEmpty() }.toSet() +
        setOf("index-hold-end", "index-hold-cancel")
    val defaults = GestureShortcut.entries.associateWith { it.defaultAction }

    fun read(saved: (GestureShortcut) -> String?): Map<GestureShortcut, ShortcutAction> {
        val used = mutableSetOf<ShortcutAction>()
        return GestureShortcut.entries.associateWith { slot ->
            val name = saved(slot)
            val action = slot.choices.firstOrNull { it.name == name } ?: slot.defaultAction
            if (action in uniqueActions && !used.add(action)) ShortcutAction.NONE else action
        }
    }

    fun assign(
        current: Map<GestureShortcut, ShortcutAction>,
        slot: GestureShortcut,
        action: ShortcutAction,
    ): Map<GestureShortcut, ShortcutAction>? {
        if (action !in slot.choices) return null
        val updated = current.toMutableMap()
        if (action in uniqueActions) {
            current.entries.firstOrNull { (other, value) -> other != slot && value == action }?.let { (other, _) ->
                val previous = current.getValue(slot)
                updated[other] = previous.takeIf { it in other.choices } ?: ShortcutAction.NONE
            }
        }
        updated[slot] = action
        return updated
    }

    fun pointerShortcut(assignments: Map<GestureShortcut, ShortcutAction>): GestureShortcut? =
        assignments.entries.firstOrNull { it.value == ShortcutAction.POINTER }?.key

    fun nativeMapping(assignments: Map<GestureShortcut, ShortcutAction>): String =
        GestureShortcut.entries.joinToString(";") { slot ->
            val action = assignments.getValue(slot)
            val key = slot.nativeSlot
            if (slot.isHold) {
                val dictation = action == ShortcutAction.DICTATION
                val end = if (dictation) "index-hold-end" else ""
                val cancel = if (dictation) "index-hold-cancel" else ""
                "${key}_start=${action.nativeAction};${key}_release=$end;${key}_cancel=$cancel"
            } else {
                "$key=${action.nativeAction}"
            }
        }
}
