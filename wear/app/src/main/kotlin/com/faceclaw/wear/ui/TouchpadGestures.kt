package com.faceclaw.wear.ui

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.positionChanged
import kotlin.math.abs

/** What the remote's touch surface can report. */
class TouchpadCallbacks(
    val onTap: (position: Offset) -> Unit,
    val onDoubleTap: (position: Offset) -> Unit,
    val onTwoFingerTap: () -> Unit,
    /** Two fingers travelled past touch slop; dx/dy are the primary finger's displacement. */
    val onTwoFingerSwipe: (dx: Float, dy: Float) -> Unit,
    val onLongPressStart: () -> Unit,
    val onLongPressEnd: () -> Unit,
    /** Finger travelled past touch slop; dx/dy are the total displacement. */
    val onSwipe: (start: Offset, dx: Float, dy: Float, durationMs: Long) -> Unit,
)

/**
 * One detector for everything the pad does, so a gesture is reported exactly
 * once: tap, double-tap (a second tap inside the double-tap timeout), a hold
 * (reported at the long-press timeout and again on release), a swipe, and a
 * two-finger tap or swipe. Written as a single awaitEachGesture loop because the
 * stock detectors would each claim the same finger.
 */
suspend fun PointerInputScope.detectTouchpadGestures(callbacks: TouchpadCallbacks) {
    val longPressTimeout = viewConfiguration.longPressTimeoutMillis
    val doubleTapTimeout = viewConfiguration.doubleTapTimeoutMillis
    val slop = viewConfiguration.touchSlop

    awaitEachGesture {
        val down = awaitFirstDown()
        down.consume()
        val downTime = down.uptimeMillis
        var maxPointers = 1
        var moved = false
        var longPressed = false
        var longPressEnded = false
        var displacement = Offset.Zero
        var releaseTime = downTime

        // The finally clause pairs every onLongPressStart with an
        // onLongPressEnd, whatever ends the gesture: a parent consuming the
        // events (the break below) or the pointerInput coroutine being
        // cancelled mid-hold. The phone treats a start without a release as a
        // hold still in progress, so dropping the release leaves a stuck
        // long-press (and eventually the shell escape menu).
        try {
            while (true) {
                val remaining = if (longPressed || moved || maxPointers > 1) {
                    HOLD_POLL_MS
                } else {
                    longPressTimeout - (System.currentTimeMillis() - wallClockAt(downTime))
                }
                val event = withTimeoutOrNull(remaining.coerceAtLeast(1L)) { awaitPointerEvent() }
                if (event == null) {
                    if (!longPressed && !moved && maxPointers == 1) {
                        longPressed = true
                        callbacks.onLongPressStart()
                    }
                    continue
                }
                // Something above us (the system, a parent) took the gesture:
                // Compose reports that as already-consumed changes. Drop it rather
                // than mistaking the cancellation for a tap.
                if (event.changes.any { it.isConsumed }) break
                val pressedCount = event.changes.count { it.pressed }
                if (pressedCount > maxPointers) maxPointers = pressedCount
                val primary = event.changes.firstOrNull { it.id == down.id } ?: event.changes.first()
                if (primary.positionChanged()) {
                    displacement = primary.position - down.position
                    if (!moved && !longPressed && displacement.getDistance() > slop) moved = true
                }
                for (change in event.changes) change.consume()
                if (pressedCount > 0) continue

                releaseTime = event.changes.maxOf { it.uptimeMillis }
                val duration = releaseTime - downTime
                when {
                    longPressed -> {
                        longPressEnded = true
                        callbacks.onLongPressEnd()
                    }
                    maxPointers >= 2 -> if (moved) callbacks.onTwoFingerSwipe(displacement.x, displacement.y) else callbacks.onTwoFingerTap()
                    moved -> callbacks.onSwipe(down.position, displacement.x, displacement.y, duration)
                    else -> {
                        // A plain tap; give a second tap a chance to make it a double.
                        val second = withTimeoutOrNull(doubleTapTimeout) { awaitFirstDown() }
                        if (second == null) {
                            callbacks.onTap(down.position)
                        } else {
                            second.consume()
                            val up = waitForUpOrCancellation()
                            if (up != null) up.consume()
                            callbacks.onDoubleTap(down.position)
                        }
                    }
                }
                break
            }
        } finally {
            if (longPressed && !longPressEnded) callbacks.onLongPressEnd()
        }
    }
}

/**
 * Observe the button tray before its child buttons consume a pointer. A
 * downward drag claims the gesture and dismisses the tray; a tap remains
 * untouched so the button below receives its normal click.
 */
suspend fun PointerInputScope.detectTrayDismiss(onDismiss: () -> Unit) {
    val slop = viewConfiguration.touchSlop
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        var dismissed = false
        while (true) {
            val event = awaitPointerEvent(PointerEventPass.Initial)
            val primary = event.changes.firstOrNull { it.id == down.id } ?: event.changes.first()
            val displacement = primary.position - down.position
            if (!dismissed && displacement.y > slop && displacement.y >= abs(displacement.x)) {
                dismissed = true
                onDismiss()
            }
            if (dismissed) event.changes.forEach { it.consume() }
            if (event.changes.none { it.pressed }) break
        }
    }
}

/** Poll interval while a hold or drag is in progress (no timeout semantics needed). */
private const val HOLD_POLL_MS = 60_000L

/**
 * Pointer timestamps are SystemClock.uptimeMillis; map one to wall-clock so the
 * remaining long-press time can be computed without a second clock.
 */
private fun wallClockAt(uptimeMillis: Long): Long =
    System.currentTimeMillis() - (android.os.SystemClock.uptimeMillis() - uptimeMillis)
