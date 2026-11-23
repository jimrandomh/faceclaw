package com.faceclaw.app

/** These functions run under the session monitor. Config survives reconnection;
 * queued state and sensor freshness do not. Private commands are ordered with
 * frames, so wake starts on the intended PRESENT, never on an older black frame. */
internal fun GlassesSessionCore.enqueueBrightnessLocked(frameVisible: Boolean? = null) {
    if (isIo) {
        ioNoteFrameVisibleLocked(frameVisible)
        // Older iO firmware has no message 30; ioMaintain drives the launcher's (and the screen) instead.
        if (!ioFirmwareOwnsBrightness) return
    }
    if (!customFirmwareDetected || !sessionReady || !fixedLayoutCreated || shutdownRequested) return
    val visible = frameVisible ?: brightnessSentVisible ?: return
    val target = brightnessPolicy.target
    if (brightnessSentLevel == target && brightnessSentVisible == visible) return
    if (frameVisible == null && hasPendingImageLocked()) return
    if (frameVisible == null && hasPendingOrInflightKindLocked("brightness-output")) return
    val duration = if (brightnessSentVisible != visible) brightnessPolicy.fadeMs
        else if (brightnessPolicy.automatic) 1200 else 120
    val payload = brightnessPayload(target, visible, duration)
    val label = "brightness target=$target visible=$visible fade=$duration"
    val retry = MessageCallback {
        brightnessSentLevel = -1
        brightnessSentVisible = null
        // Retry with a PRESENT even if the scene did not change during recovery.
        lastEnqueuedFingerprint = ""
    }
    if (isG1) {
        g1EnqueueBrightnessLocked(payload, label, brightnessSentVisible != visible, retry)
    } else {
        val message = messageBuilder.customMessage("brightness-output", payload, label, -1, connectionOptions.sendImagesToLeft)
        message.onTimeout = retry
        pendingMessages.addLast(message)
    }
    brightnessSentLevel = target
    brightnessSentVisible = visible
    if (isIo) io.lastBrightnessAtMs = now()
}

internal fun GlassesSessionCore.maintainBrightnessLocked(now: Long) {
    if (!customFirmwareDetected || !sessionReady || !fixedLayoutCreated || shutdownRequested) return
    val interval = alsPassiveIntervalLocked()
    // The G2's stock can close the sensor, so it hears this again; the iO's polling lasts as long as the page.
    val alsDue = if (isIo) interval != io.alsIntervalSent else now - brightnessAlsStartedAt >= 2000
    if (alsDue && !hasPendingOrInflightKindLocked("als-control")) {
        enqueueAmbientLightControlLocked(alsPassivePayload(interval), "brightness passive ALS", false)
        brightnessAlsStartedAt = now
        if (isIo) io.alsIntervalSent = interval
    }
    enqueueBrightnessLocked()
}

/**
 * Passive polling owns stock ALS even in manual mode. Slower manual polling
 * keeps stock from writing the panel without needlessly streaming samples.
 */
internal fun GlassesSessionCore.alsPassiveIntervalLocked(): Int =
    if (brightnessDemoPolling) 250 else if (brightnessPolicy.automatic) 500 else 5000

/** `[16][1 passive][flags 1][interval u16][min-delta u16][heartbeat u16 = 1000]`. */
internal fun alsPassivePayload(interval: Int): ByteArray = byteArrayOf(CFW_MSG_AMBIENT_LIGHT.toByte(), 1, 1,
    interval.toByte(), (interval shr 8).toByte(), 0, 0, 0xe8.toByte(), 3)

/** `[30][version 1][level][visible][fade u16]`. */
internal fun brightnessPayload(target: Int, visible: Boolean, durationMs: Int): ByteArray =
    byteArrayOf(CFW_MSG_BRIGHTNESS.toByte(), 1, target.toByte(), (if (visible) 1 else 0).toByte(),
        durationMs.toByte(), (durationMs shr 8).toByte())

/**
 * The glasses act on a brightness command at their next brightness tick, so a fade starts up to
 * this long after its command arrives. Keep in sync with BRIGHTNESS_TICK_MS in g2flash
 * patches/brightness.h.
 */
internal const val BRIGHTNESS_TICK_MS = 40

/**
 * How long the blank frame of a screen-off still has to wait, 0 when nothing is held.
 *
 * A G2 keeps replaying the frame on screen while it fades out, so whatever that frame
 * animates, and whatever it draws from the fade itself, keeps moving until the screen is dark.
 * Staging the blank frame's draws would stop that at once. So on a G2 a screen-off
 * starts the fade here, ahead of its frame, and the frame waits the fade out: the fade's own
 * length, whatever the Screen fade speed makes it, and the tick it can take to start. A wake
 * that comes first never sends the frame at all.
 */
internal fun GlassesSessionCore.blankFrameHoldMsLocked(now: Long): Long {
    val desired = desiredFingerprintSnapshot()
    if (!isBlankedFingerprint(desired)) {
        if (blankFrameHeldUntilMs != 0L) {
            // Told to fade out, the glasses now need a PRESENT to fade back in on, even though
            // the frame they hold may be the very one wanted.
            blankFrameHeldUntilMs = 0L
            lastEnqueuedFingerprint = ""
            logLine("screen back on before its blank frame was sent")
        }
        return 0L
    }
    if (blankFrameHeldUntilMs == 0L) {
        if (!isG2 || brightnessSentVisible != true || brightnessPolicy.fadeMs <= 0
                || desired == lastEnqueuedFingerprint) return 0L
        enqueueBrightnessLocked(false)
        // Not queued (the display path is not ready): the frame goes out as usual.
        if (brightnessSentVisible != false) return 0L
        val holdMs = brightnessPolicy.fadeMs + BRIGHTNESS_TICK_MS
        blankFrameHeldUntilMs = now + holdMs
        logLine("holding the blank frame " + holdMs + "ms for the fade-out")
    }
    return maxOf(0L, blankFrameHeldUntilMs - now)
}

/** SurfaceCompositor's fingerprint for a frame with the display blanked, which the brightness follows. */
internal fun isBlankedFingerprint(fingerprint: String): Boolean = fingerprint.startsWith("blanked:")
