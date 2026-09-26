package com.faceclaw.app

/** These functions run under the session monitor. Config survives reconnection;
 * queued state and sensor freshness do not. Private commands are ordered with
 * frames, so wake starts on the intended PRESENT, never on an older black frame. */
internal fun GlassesSessionCore.enqueueBrightnessLocked(frameVisible: Boolean? = null) {
    if (!customFirmwareDetected || !sessionReady || !fixedLayoutCreated || shutdownRequested) return
    val visible = frameVisible ?: brightnessSentVisible ?: return
    val target = brightnessPolicy.target
    if (brightnessSentLevel == target && brightnessSentVisible == visible) return
    if (frameVisible == null && hasPendingImageLocked()) return
    if (frameVisible == null && hasPendingOrInflightKindLocked("brightness-output")) return
    val duration = if (brightnessSentVisible != visible) brightnessPolicy.fadeMs
        else if (brightnessPolicy.automatic) 1200 else 120
    val payload = byteArrayOf(CFW_MSG_BRIGHTNESS.toByte(), 1, target.toByte(),
        (if (visible) 1 else 0).toByte(), duration.toByte(), (duration shr 8).toByte())
    val message = messageBuilder.customMessage("brightness-output", payload,
        "brightness target=$target visible=$visible fade=$duration", -1, connectionOptions.sendImagesToLeft)
    message.onTimeout = MessageCallback {
        brightnessSentLevel = -1
        brightnessSentVisible = null
        // Retry with a PRESENT even if the scene did not change during recovery.
        lastEnqueuedFingerprint = ""
    }
    pendingMessages.addLast(message)
    brightnessSentLevel = target
    brightnessSentVisible = visible
}

internal fun GlassesSessionCore.maintainBrightnessLocked(now: Long) {
    if (!customFirmwareDetected || !sessionReady || !fixedLayoutCreated || shutdownRequested) return
    // Passive polling owns stock ALS even in manual mode. Slower manual polling
    // keeps stock from writing the panel without needlessly streaming samples.
    if (now - brightnessAlsStartedAt >= 2000 && !hasPendingOrInflightKindLocked("als-control")) {
        val interval = if (brightnessDemoPolling) 250 else if (brightnessPolicy.automatic) 500 else 5000
        val payload = byteArrayOf(CFW_MSG_AMBIENT_LIGHT.toByte(), 1, 1,
            interval.toByte(), (interval shr 8).toByte(), 0, 0, 0xe8.toByte(), 3)
        enqueueAmbientLightControlLocked(payload, "brightness passive ALS", false)
        brightnessAlsStartedAt = now
    }
    enqueueBrightnessLocked()
}
