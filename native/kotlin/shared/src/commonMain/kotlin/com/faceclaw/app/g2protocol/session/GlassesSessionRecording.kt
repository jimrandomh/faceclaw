package com.faceclaw.app

/*
 * GlassesSessionCore, screen recording: starting and ending a ScreenRecorder over this
 * session. The hooks that feed it are where the events happen: writeMessage and the ACK
 * paths for messages, logLine for the session log, FrameTimingsCore for frame timings.
 */

/**
 * Begin a screen recording. Its starting state is what the glasses will hold once every
 * message planned so far has run, so those messages are marked as already counted when
 * they are written or acknowledged later; everything planned from here on is logged in
 * full. Does nothing if a recording is already running.
 */
internal fun GlassesSessionCore.beginScreenRecording() {
    if (screenRecorder != null) return
    val recorder = ScreenRecorder(platform)
    // What the phone means the screen to show, to check the replayed starting state against.
    val composite = compositor.previewComposite()
    monitor.withLock {
        if (screenRecorder != null) return
        recorder.begin(
            when (glassesType) {
                GlassesType.G2 -> "g2"
                GlassesType.RAYNEO_IO -> "rayneo-io"
                GlassesType.G1 -> "g1"
            },
            composite?.width ?: 0,
            composite?.height ?: 0,
            OutboundMessage.lastTraceId(),
            screenRecordingStatesLocked(),
        )
        screenRecorder = recorder
    }
    frameTimings.attachSink(recorder)
    recorder.addComposite("phone", composite)
}

/** The glasses' display state as the planners model it; empty when no planner tracks one. */
private fun GlassesSessionCore.screenRecordingStatesLocked(): List<ScreenRecorder.DeviceState> {
    if (!customFirmwareDetected) return emptyList()
    if (!isG1) return listOf(scenePlanner.deviceState())
    // A G1 has no resource cache or display lists: each arm holds just its own frame.
    val width: Int
    val height: Int
    desiredTilesLock.locked {
        width = desiredWidth
        height = desiredHeight
    }
    if (width <= 0 || height <= 0) return emptyList()
    return List(2) { arm ->
        val frame = g1.arms[arm].frame
        ScreenRecorder.DeviceState(
            if (arm == 0) ScreenRecorder.LENS_LEFT else ScreenRecorder.LENS_RIGHT, width, height,
            if (frame != null && frame.size == ((width + 1) / 2) * height) frame.copyOf() else null,
            DrawProtocol.SCREEN, emptyList(),
        )
    }
}

/**
 * The periodic capture point (each phone-preview flush). A session on the draw protocol
 * records nothing here: its messages already say what is on the screen, and compositing a
 * preview for every flush would disturb the timings being recorded.
 */
internal fun GlassesSessionCore.captureScreenRecordingFrame() {
    val recorder = screenRecorder ?: return
    if (monitor.withLock { customFirmwareDetected }) return
    recorder.addComposite("phone", compositor.previewComposite())
}

/** End the recording and hand it back for saving, or null if none was running. */
internal fun GlassesSessionCore.endScreenRecording(): ScreenRecorder? {
    val recorder = monitor.withLock {
        val current = screenRecorder
        screenRecorder = null
        current
    } ?: return null
    frameTimings.detachSink(recorder)
    recorder.addComposite("phone", compositor.previewComposite())
    recorder.end()
    return recorder
}
