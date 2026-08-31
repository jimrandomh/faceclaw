package com.faceclaw.wear

import android.content.Context
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator

/** Short confirmations for sent gestures; each call is a no-op without a vibrator. */
class Haptics(context: Context, private val enabled: () -> Boolean) {
    private val vibrator: Vibrator? = context.getSystemService(Vibrator::class.java)
    @Volatile private var lastVibrationAt = 0L

    /**
     * elapsedRealtime until which the motion sensors will still be feeling
     * our own buzz. The tip-tap detector ignores that window, or a click's
     * confirmation would read as another fingertip tap.
     */
    fun quietUntil(): Long = lastVibrationAt + VIBRATION_SETTLE_MS

    /** A sent scroll step. */
    fun tick() = play(VibrationEffect.EFFECT_TICK)

    /** A sent click / command. */
    fun click() = play(VibrationEffect.EFFECT_CLICK)

    /** A sent double-click. */
    fun doubleClick() = play(VibrationEffect.EFFECT_DOUBLE_CLICK)

    /** The start of a hold. */
    fun heavy() = play(VibrationEffect.EFFECT_HEAVY_CLICK)

    /** The phone refused or did not answer; always plays. */
    fun error() {
        val v = vibrator ?: return
        if (!v.hasVibrator()) return
        lastVibrationAt = SystemClock.elapsedRealtime()
        v.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 40, 60, 40), -1))
    }

    private fun play(effect: Int) {
        if (!enabled()) return
        val v = vibrator ?: return
        if (!v.hasVibrator()) return
        lastVibrationAt = SystemClock.elapsedRealtime()
        v.vibrate(VibrationEffect.createPredefined(effect))
    }

    private companion object {
        const val VIBRATION_SETTLE_MS = 400L
    }
}
