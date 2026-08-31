package com.faceclaw.wear

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class CrownSensitivity(val label: String, val pixelsPerStep: Float) {
    LOW("Low", 110f),
    NORMAL("Normal", 60f),
    HIGH("High", 30f);

    fun next(): CrownSensitivity = entries[(ordinal + 1) % entries.size]
}

/** What a horizontal swipe on the pad does. */
enum class SwipeAction(val label: String) {
    /** Sent as directional input; the glasses UI decides (see Gesture.SWIPE_LEFT). */
    NAVIGATE("Navigate"),
    SIDEBAR("Sidebar"),
    DOUBLE_CLICK("Double-click"),
    CLICK("Click"),
    LONG_PRESS("Long press"),
    WAKEWORD("“Hey Even”"),
    NONE("Nothing");

    fun next(): SwipeAction = entries[(ordinal + 1) % entries.size]
}

/** Watch-local preferences (nothing here is synced to the phone). */
data class Prefs(
    /** Buzz on every gesture sent. */
    val haptics: Boolean = true,
    /**
     * Keep the display awake while the pad is showing. Wear otherwise dozes
     * within seconds of the wrist dropping and freezes the app, which is
     * exactly when a remote wants to stay ready.
     */
    val keepScreenOn: Boolean = true,
    /** Swipe direction follows the content (touch-scroll style) instead of the ring. */
    val naturalScroll: Boolean = false,
    /** Tap the top/bottom of the pad to scroll instead of swiping. */
    val tapZones: Boolean = false,
    val crownSensitivity: CrownSensitivity = CrownSensitivity.NORMAL,
    val swipeLeft: SwipeAction = SwipeAction.NAVIGATE,
    val swipeRight: SwipeAction = SwipeAction.NAVIGATE,
    /**
     * Fingertip (pinch) taps from the motion sensors; see FingerTapDetector.
     * Off by default: on a wrist, ordinary hand movement produced phantom
     * clicks in testing, and a phantom click opens things.
     */
    val fingerTaps: Boolean = false,
    val tapSensitivity: TapSensitivity = TapSensitivity.NORMAL,
    /** Two quick wrist twists = back (double-click); see WristTwistDetector. */
    val wristTwist: Boolean = true,
    val twistSensitivity: TwistSensitivity = TwistSensitivity.NORMAL,
)

class WatchPrefs(context: Context) {
    private val store = context.applicationContext.getSharedPreferences("faceclaw_wear", Context.MODE_PRIVATE)
    private val _prefs = MutableStateFlow(load())
    val prefs: StateFlow<Prefs> = _prefs.asStateFlow()

    private fun load(): Prefs = Prefs(
        haptics = store.getBoolean(KEY_HAPTICS, true),
        keepScreenOn = store.getBoolean(KEY_KEEP_SCREEN_ON, true),
        naturalScroll = store.getBoolean(KEY_NATURAL_SCROLL, false),
        tapZones = store.getBoolean(KEY_TAP_ZONES, false),
        crownSensitivity = store.getString(KEY_CROWN, null)
            ?.let { stored -> CrownSensitivity.entries.firstOrNull { it.name == stored } }
            ?: CrownSensitivity.NORMAL,
        swipeLeft = store.getString(KEY_SWIPE_LEFT, null)
            ?.let { stored -> SwipeAction.entries.firstOrNull { it.name == stored } }
            ?: SwipeAction.NAVIGATE,
        swipeRight = store.getString(KEY_SWIPE_RIGHT, null)
            ?.let { stored -> SwipeAction.entries.firstOrNull { it.name == stored } }
            ?: SwipeAction.NAVIGATE,
        fingerTaps = store.getBoolean(KEY_FINGER_TAPS, false),
        tapSensitivity = store.getString(KEY_TAP_SENSITIVITY, null)
            ?.let { stored -> TapSensitivity.entries.firstOrNull { it.name == stored } }
            ?: TapSensitivity.NORMAL,
        wristTwist = store.getBoolean(KEY_WRIST_TWIST, true),
        twistSensitivity = store.getString(KEY_TWIST_SENSITIVITY, null)
            ?.let { stored -> TwistSensitivity.entries.firstOrNull { it.name == stored } }
            ?: TwistSensitivity.NORMAL,
    )

    fun update(transform: (Prefs) -> Prefs) {
        val next = transform(_prefs.value)
        _prefs.value = next
        store.edit()
            .putBoolean(KEY_HAPTICS, next.haptics)
            .putBoolean(KEY_KEEP_SCREEN_ON, next.keepScreenOn)
            .putBoolean(KEY_NATURAL_SCROLL, next.naturalScroll)
            .putBoolean(KEY_TAP_ZONES, next.tapZones)
            .putString(KEY_CROWN, next.crownSensitivity.name)
            .putString(KEY_SWIPE_LEFT, next.swipeLeft.name)
            .putString(KEY_SWIPE_RIGHT, next.swipeRight.name)
            .putBoolean(KEY_FINGER_TAPS, next.fingerTaps)
            .putString(KEY_TAP_SENSITIVITY, next.tapSensitivity.name)
            .putBoolean(KEY_WRIST_TWIST, next.wristTwist)
            .putString(KEY_TWIST_SENSITIVITY, next.twistSensitivity.name)
            .apply()
    }

    private companion object {
        const val KEY_HAPTICS = "haptics"
        const val KEY_KEEP_SCREEN_ON = "keepScreenOn"
        const val KEY_NATURAL_SCROLL = "naturalScroll"
        const val KEY_TAP_ZONES = "tapZones"
        const val KEY_CROWN = "crownSensitivity"
        const val KEY_SWIPE_LEFT = "swipeLeft"
        const val KEY_SWIPE_RIGHT = "swipeRight"
        const val KEY_FINGER_TAPS = "fingerTaps"
        const val KEY_TAP_SENSITIVITY = "tapSensitivity"
        const val KEY_WRIST_TWIST = "wristTwist"
        const val KEY_TWIST_SENSITIVITY = "twistSensitivity"
    }
}
