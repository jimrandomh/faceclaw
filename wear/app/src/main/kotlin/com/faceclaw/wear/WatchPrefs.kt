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
    val crownSensitivity: CrownSensitivity = CrownSensitivity.NORMAL,
    /**
     * Fingertip (pinch) taps from the motion sensors; see FingerTapDetector.
     * Off by default: on a wrist, ordinary hand movement produced phantom
     * clicks in testing, and a phantom click opens things.
     */
    val fingerTaps: Boolean = false,
    val tapSensitivity: TapSensitivity = TapSensitivity.NORMAL,
)

class WatchPrefs(context: Context) {
    private val store = context.applicationContext.getSharedPreferences("faceclaw_wear", Context.MODE_PRIVATE)
    private val _prefs = MutableStateFlow(load())
    val prefs: StateFlow<Prefs> = _prefs.asStateFlow()

    private fun load(): Prefs = Prefs(
        haptics = store.getBoolean(KEY_HAPTICS, true),
        keepScreenOn = store.getBoolean(KEY_KEEP_SCREEN_ON, true),
        crownSensitivity = store.getString(KEY_CROWN, null)
            ?.let { stored -> CrownSensitivity.entries.firstOrNull { it.name == stored } }
            ?: CrownSensitivity.NORMAL,
        fingerTaps = store.getBoolean(KEY_FINGER_TAPS, false),
        tapSensitivity = store.getString(KEY_TAP_SENSITIVITY, null)
            ?.let { stored -> TapSensitivity.entries.firstOrNull { it.name == stored } }
            ?: TapSensitivity.NORMAL,
    )

    fun update(transform: (Prefs) -> Prefs) {
        val next = transform(_prefs.value)
        _prefs.value = next
        store.edit()
            .putBoolean(KEY_HAPTICS, next.haptics)
            .putBoolean(KEY_KEEP_SCREEN_ON, next.keepScreenOn)
            .putString(KEY_CROWN, next.crownSensitivity.name)
            .putBoolean(KEY_FINGER_TAPS, next.fingerTaps)
            .putString(KEY_TAP_SENSITIVITY, next.tapSensitivity.name)
            .apply()
    }

    private companion object {
        const val KEY_HAPTICS = "haptics"
        const val KEY_KEEP_SCREEN_ON = "keepScreenOn"
        const val KEY_CROWN = "crownSensitivity"
        const val KEY_FINGER_TAPS = "fingerTaps"
        const val KEY_TAP_SENSITIVITY = "tapSensitivity"
    }
}
