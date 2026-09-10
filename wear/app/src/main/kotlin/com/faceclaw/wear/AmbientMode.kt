package com.faceclaw.wear

/**
 * The watch's ambient (always-on, low-power) display state, as reported by
 * the system through [androidx.wear.ambient.AmbientLifecycleObserver].
 */
data class AmbientMode(
    /** The display is in ambient: draw black, still, and as few pixels as possible. */
    val active: Boolean = false,
    /** The panel burns in: nudge the content between redraws. */
    val burnInProtectionRequired: Boolean = false,
    /** The panel is 1-bit in ambient: no greys, no anti-aliasing worth relying on. */
    val lowBit: Boolean = false,
    /**
     * Bumped on entering ambient and on every ambient update (about once a
     * minute), so the clock redraws: the CPU may be suspended in between, so
     * no timer can be relied on for that.
     */
    val tick: Long = 0,
)
