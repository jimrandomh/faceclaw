package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class FrameTimingsCoreTest {
    private class FakeClock : ProtocolPlatform by testPlatform() {
        var nowMs = 1_000L
        override fun elapsedRealtimeMs(): Long = nowMs
    }

    private fun core(clock: FakeClock, logs: MutableList<String> = ArrayList()) = FrameTimingsCore(
        platform = clock,
        wallClockMs = { 1_700_000_000_000L + clock.nowMs },
        threadName = { "t" },
        formatWallClock = { "wall@$it" },
        logInfo = { logs.add("I $it") },
        logWarn = { logs.add("W $it") },
    )

    @Test
    fun exportRendersTreeAgainstRootClockByteForByte() {
        val clock = FakeClock()
        val logs = ArrayList<String>()
        val core = core(clock, logs)
        val root = core.startFrame("input:sys-event type=0")
        clock.nowMs += 5
        core.annotate(root, "fg=terminal")
        core.log(root, "input event received on JS side")
        clock.nowMs += 1
        core.spanStart(root, "handle-input")
        clock.nowMs += 10
        val child = core.startFrame("render:shell", root)
        clock.nowMs += 4
        core.spanEnd(root, "handle-input")
        core.spanEnd(root, "missing")
        core.spanStart(child, "paint")
        clock.nowMs += 30
        core.finishFrame(child, "discarded: superseded")
        clock.nowMs += 50
        core.finishFrame(root, "sent")
        core.finishFrame(root, "sent") // ignored: first finish wins
        core.log(root, "late line is dropped")
        clock.nowMs += 100

        assertEquals(listOf(
            "I frame#2 [render:shell] -> discarded: superseded in 34ms",
            "I frame#1 [input:sys-event type=0 fg=terminal] -> sent in 100ms",
        ), logs)
        assertEquals("frames started=2 sent=1 discarded=1 timeout=0 | input-to-display p50=100ms p90=100ms p99=100ms max=100ms", core.statsSummary())

        val expected = """
            |FrameTimings export at wall@1700000001200
            |frames started=2 sent=1 discarded=1 timeout=0 open=0
            |input-to-display latency (last 1): p50=100ms p90=100ms p99=100ms max=100ms
            |
            |Frames are trees: an input event's own frame is the root, and the renders it
            |caused are indented under it with offsets measured from the root's start.
            |
            |=== slowest frames that reached the glasses ===
            |frame#1 [input:sys-event type=0 fg=terminal] started wall@1700000001000 duration 100ms (tree 100ms) outcome sent
            |       +5ms [t] input event received on JS side
            |       +6ms [t] span handle-input start
            |      +16ms [t] spawned frame#2 (render:shell)
            |      +20ms [t] span handle-input end (14ms)
            |      +20ms [t] span missing end (start not recorded)
            |     +100ms [t] finished: sent
            |  frame#2 [render:shell] started +16ms duration 34ms outcome discarded: superseded
            |        +20ms [t] span paint start
            |        +50ms [t] span paint never ended (started at +4ms)
            |        +50ms [t] finished: discarded: superseded
            |=== recent frames (oldest first) ===
            |frame#1 [input:sys-event type=0 fg=terminal] started wall@1700000001000 duration 100ms (tree 100ms) outcome sent
            |       +5ms [t] input event received on JS side
            |       +6ms [t] span handle-input start
            |      +16ms [t] spawned frame#2 (render:shell)
            |      +20ms [t] span handle-input end (14ms)
            |      +20ms [t] span missing end (start not recorded)
            |     +100ms [t] finished: sent
            |  frame#2 [render:shell] started +16ms duration 34ms outcome discarded: superseded
            |        +20ms [t] span paint start
            |        +50ms [t] span paint never ended (started at +4ms)
            |        +50ms [t] finished: discarded: superseded
            |""".trimMargin()
        assertTrue(core.isExportDirty)
        assertEquals(expected, core.takeExport())
        assertFalse(core.isExportDirty)
        assertEquals(null, core.takeExport())
        assertEquals(expected, core.buildExport())
    }

    @Test
    fun sweepFinishesStaleFramesAsTimeoutsAndIgnoresZeroAndUnknownIds() {
        val clock = FakeClock()
        val logs = ArrayList<String>()
        val core = core(clock, logs)
        val stale = core.startFrame("render:app")
        clock.nowMs += FrameTimingsCore.FRAME_TIMEOUT_MS - 1
        val fresh = core.startFrame("render:late")
        assertEquals(0, core.sweepTimedOut())
        clock.nowMs += 1
        assertEquals(1, core.sweepTimedOut())
        assertEquals(listOf("W frame#$stale [render:app] timed out after 30000ms without being finished"), logs)
        core.log(0, "ignored")
        core.log(999, "ignored")
        core.spanStart(0, "x")
        core.finishFrame(0, "sent")
        core.finishFrame(fresh, "sent")
        assertEquals("frames started=2 sent=1 discarded=0 timeout=1", core.statsSummary())
        val export = core.buildExport()
        assertTrue(export.contains("frame#$stale [render:app] started wall@"))
        assertTrue(export.contains("outcome timeout: never reported finished\n"))
        assertTrue(export.contains("render-to-display latency (last 1): p50=1ms p90=1ms p99=1ms max=1ms"))
        assertTrue(export.contains("open=0"))
    }

    @Test
    fun lineCapAndNegativeOffsetsFormatLikeJava() {
        val clock = FakeClock()
        val core = core(clock)
        val root = core.startFrame("input:x")
        clock.nowMs -= 12 // a line stamped before the root's start still formats with a sign
        core.log(root, "early")
        clock.nowMs += 12
        repeat(250) { core.log(root, "line $it") }
        core.finishFrame(root, "sent")
        val export = core.buildExport()
        assertTrue(export.contains("\n      -12ms [t] early\n"), export)
        // Printed once under "slowest" and once under "recent".
        assertEquals(2, Regex("\\.\\.\\. line cap reached").findAll(export).count())
        assertTrue(export.contains("line 198"))
        assertFalse(export.contains("line 199"))
        // Like the Java original, lines past the cap (including the finish line) are dropped.
        assertFalse(export.contains("finished: sent"))
        assertTrue(export.contains("outcome sent\n"))
    }
}
