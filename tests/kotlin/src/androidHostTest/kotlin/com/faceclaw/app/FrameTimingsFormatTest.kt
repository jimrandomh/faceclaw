package com.faceclaw.app

import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals

/** The shared export must match what the Java-era String.format("%+7d") produced. */
class FrameTimingsFormatTest {
    private class FakeClock : ProtocolPlatform by AndroidProtocolPlatform {
        var nowMs = 5_000L
        override fun elapsedRealtimeMs(): Long = nowMs
    }

    @Test
    fun lineOffsetsMatchJavaFormat() {
        val clock = FakeClock()
        val core = FrameTimingsCore(clock, wallClockMs = { 0L }, threadName = { "worker" }, formatWallClock = { "w" }, logInfo = {}, logWarn = {})
        val offsets = listOf(-1_234_567L, -12L, -1L, 0L, 1L, 42L, 999L, 1_000L, 12_345L, 1_234_567L, 12_345_678L)
        val root = core.startFrame("input:fmt")
        for (offset in offsets) {
            clock.nowMs = 5_000L + offset
            core.log(root, "o=$offset")
        }
        clock.nowMs = 5_000L
        core.finishFrame(root, "sent")
        val export = core.buildExport()
        for (offset in offsets) {
            val javaLine = String.format(Locale.US, "  %+7dms [%s] %s", offset, "worker", "o=$offset")
            assert(export.contains("\n$javaLine\n")) { "missing <$javaLine> in\n$export" }
        }
        assertEquals(2, export.split("\n").count { it.contains("finished: sent") })
    }
}
