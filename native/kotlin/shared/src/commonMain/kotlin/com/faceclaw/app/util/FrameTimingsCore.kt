package com.faceclaw.app

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/**
 * Per-frame timing instrumentation, shared between the native BLE layer and the
 * Typescript UI layer. A "frame" starts when we receive an input event (or a
 * timer fires and we decide to redraw), and finishes when the resulting screen
 * update has been fully transmitted to the glasses, is discarded unsent, or
 * times out because nobody reported finishing it.
 *
 * Frames form a tree. One input event can fan out into several renders (the
 * focused app's window plus the shell chrome, say), and each of those is its
 * own frame linked back to the input frame that caused it via
 * [startFrame]. The export nests descendants under their
 * root and renders every line against the root's clock, so a single block
 * shows the whole input-to-pixels story. Latency percentiles are measured over
 * roots: root start to the first descendant that actually reached the glasses.
 *
 * All public methods are thread-safe and cheap enough to call from the BLE
 * worker thread, the platform main thread, the JS thread, and app worker
 * threads. Frame IDs are positive ints; 0 means "no frame" and is silently
 * ignored everywhere, so callers do not need to null-check.
 *
 * This core owns the bookkeeping and the export text; the platform facade owns
 * the export thread and file write (see the Android `FrameTimings`). The clock
 * is [ProtocolPlatform.elapsedRealtimeMs] (monotonic, includes sleep); wall-clock,
 * thread names and logging are injectable for tests.
 */
class FrameTimingsCore(
    private val platform: ProtocolPlatform = protocolPlatform(),
    private val wallClockMs: () -> Long = { currentTimeMillis() },
    private val threadName: () -> String = { currentThreadName() },
    private val formatWallClock: (Long) -> String = { formatLocalTime(it, "yyyy-MM-dd HH:mm:ss.SSS") },
    private val logInfo: (String) -> Unit = { PlatformLog.i(TAG, it) },
    private val logWarn: (String) -> Unit = { PlatformLog.w(TAG, it) },
) {
    companion object {
        const val TAG = "FrameTimings"

        /** Frames still open after this long are finished as "timeout". */
        const val FRAME_TIMEOUT_MS = 30_000L
        const val EXPORT_INTERVAL_MS = 15_000L
        const val SWEEP_INTERVAL_MS = 5_000L
        private const val RECENT_ROOTS_KEPT = 40
        private const val SLOWEST_ROOTS_KEPT = 20
        private const val SENT_DURATIONS_WINDOW = 512
        private const val MAX_LINES_PER_FRAME = 200
        /**
         * Frames retained for ID lookup. Well above the number any export can
         * reference, so a late log/span/finish call always finds its frame; frames
         * older than this are unreachable and get collected.
         */
        private const val FRAMES_RETAINED = 1024

        private fun percentileOfSorted(sorted: List<Long>, percentile: Int): Long {
            val index = ceil(percentile / 100.0 * sorted.size).toInt() - 1
            return sorted[max(0, min(sorted.size - 1, index))]
        }

        /** java.lang.String.format("%+7d"): explicit sign, right-aligned in 7 columns. */
        private fun signedWidth7(value: Long): String {
            val text = (if (value < 0) "-" else "+") + abs(value).toString()
            return text.padStart(7)
        }
    }

    private class Line(
        val atMs: Long,          // elapsedRealtimeMs
        val thread: String,
        val message: String?
    )

    private class Frame(
        val id: Int,
        var reason: String,
        val startedAtMs: Long,       // elapsedRealtimeMs
        val startedWallClockMs: Long,
        val parent: Frame?
    ) {
        val children: MutableList<Frame> = ArrayList(0)
        val lines: MutableList<Line> = ArrayList()
        val openSpans: MutableMap<String, Long> = LinkedHashMap()
        var finishedAtMs: Long = 0
        var outcome: String? = null // null while open; "sent", "discarded: ...", "timeout: ..."
        /** Set on the root once some frame in its subtree reached the glasses. */
        var subtreeSentRecorded = false

        fun root(): Frame {
            var frame: Frame = this
            while (frame.parent != null) {
                frame = frame.parent!!
            }
            return frame
        }

        fun isOpen(): Boolean = outcome == null

        fun durationMs(): Long = finishedAtMs - startedAtMs

        fun wasSent(): Boolean {
            val outcome = this.outcome
            return outcome != null && outcome.startsWith("sent")
        }

        /** Last moment anything in this subtree happened, for whole-tree duration. */
        fun subtreeEndAtMs(nowMs: Long): Long {
            var end = if (isOpen()) nowMs else finishedAtMs
            for (child in children) {
                end = max(end, child.subtreeEndAtMs(nowMs))
            }
            return end
        }

        fun subtreeHasOpenFrame(): Boolean {
            if (isOpen()) return true
            for (child in children) {
                if (child.subtreeHasOpenFrame()) return true
            }
            return false
        }
    }

    private val lock = platform.createLock()
    /**
     * Every frame we still retain, keyed by ID, in insertion order: open frames
     * plus enough history that late calls and the export can still resolve one.
     */
    private val framesById: LinkedHashMap<Int, Frame> = LinkedHashMap()
    private val recentRoots = ArrayDeque<Frame>()
    private val slowestRoots: MutableList<Frame> = ArrayList()
    private val inputLatencies = ArrayDeque<Long>()
    private val renderLatencies = ArrayDeque<Long>()
    private var nextFrameId = 1
    private var framesStarted: Long = 0
    private var framesSent: Long = 0
    private var framesDiscarded: Long = 0
    private var framesTimedOut: Long = 0
    private var exportDirty = false

    /** Begin a root frame; reason is a short label like "input:sys-event type=0". */
    fun startFrame(reason: String?): Int = startFrame(reason, 0)

    /**
     * Begin a frame caused by an existing one (parentFrameId; 0 for a root).
     * The child is nested under its root in the export and its latency counts
     * against the root, so an input event that fans out into an app render and
     * a shell-chrome render reads as one timeline instead of three.
     */
    fun startFrame(reason: String?, parentFrameId: Int): Int {
        val now = platform.elapsedRealtimeMs()
        val frame = lock.withLock {
            val parent = framesById[parentFrameId]
            val frame = Frame(nextFrameId++, reason ?: "", now, wallClockMs(), parent)
            framesById[frame.id] = frame
            // Like LinkedHashMap.removeEldestEntry: drop at most the single eldest
            // entry per insert, and only when it is already finished.
            if (framesById.size > FRAMES_RETAINED) {
                val eldest = framesById.entries.first()
                if (!eldest.value.isOpen()) framesById.remove(eldest.key)
            }
            framesStarted++
            if (parent != null) {
                parent.children.add(frame)
                addLineLocked(parent, now, "spawned frame#" + frame.id + " (" + frame.reason + ")")
            }
            frame
        }
        return frame.id
    }

    /**
     * Append to a frame's label, for facts only known after it started (which
     * app is in the foreground, which window a render is for). Shows up in the
     * frame's header line, so the export is scannable without reading bodies.
     */
    fun annotate(frameId: Int, text: String?) {
        if (text == null || text.isEmpty()) return
        lock.withLock {
            val frame = framesById[frameId] ?: return
            frame.reason = if (frame.reason.isEmpty()) text else frame.reason + " " + text
        }
    }

    fun log(frameId: Int, message: String?) {
        val now = platform.elapsedRealtimeMs()
        lock.withLock {
            val frame = openFrameLocked(frameId) ?: return
            addLineLocked(frame, now, message)
        }
    }

    fun spanStart(frameId: Int, name: String) {
        val now = platform.elapsedRealtimeMs()
        lock.withLock {
            val frame = openFrameLocked(frameId) ?: return
            frame.openSpans[name] = now
            addLineLocked(frame, now, "span $name start")
        }
    }

    fun spanEnd(frameId: Int, name: String) {
        val now = platform.elapsedRealtimeMs()
        lock.withLock {
            val frame = openFrameLocked(frameId) ?: return
            val startedAt = frame.openSpans.remove(name)
            if (startedAt == null) {
                addLineLocked(frame, now, "span $name end (start not recorded)")
            } else {
                addLineLocked(frame, now, "span " + name + " end (" + (now - startedAt) + "ms)")
            }
        }
    }

    /**
     * Finish a frame. Outcomes: "sent" (counted in latency percentiles), anything
     * starting with "discarded", or "timeout". First finish wins; later calls for
     * the same frame are ignored, so racing completion paths are safe.
     */
    fun finishFrame(frameId: Int, outcome: String?) {
        val now = platform.elapsedRealtimeMs()
        val finished = lock.withLock {
            val frame = openFrameLocked(frameId) ?: return
            finishFrameLocked(frame, now, outcome ?: "discarded: no outcome given")
            frame
        }
        logInfo("frame#" + finished.id + " [" + finished.reason + "] -> " + finished.outcome
                + " in " + finished.durationMs() + "ms")
    }

    /** One-line stats summary, e.g. for showing in the phone UI. */
    fun statsSummary(): String {
        lock.withLock {
            val input = percentilesLocked(inputLatencies)
            return "frames started=" + framesStarted + " sent=" + framesSent +
                    " discarded=" + framesDiscarded + " timeout=" + framesTimedOut +
                    (if (input == null)
                        ""
                        else " | input-to-display p50=" + input[0] + "ms p90=" + input[1] +
                            "ms p99=" + input[2] + "ms max=" + input[3] + "ms")
        }
    }

    /** Finish every frame open longer than [FRAME_TIMEOUT_MS] as a timeout; returns how many. */
    fun sweepTimedOut(): Int {
        val now = platform.elapsedRealtimeMs()
        val timedOut: MutableList<Frame> = ArrayList()
        lock.withLock {
            for (frame in ArrayList(framesById.values)) {
                if (frame.isOpen() && now - frame.startedAtMs >= FRAME_TIMEOUT_MS) {
                    finishFrameLocked(frame, now, "timeout: never reported finished")
                    timedOut.add(frame)
                }
            }
        }
        for (frame in timedOut) {
            logWarn("frame#" + frame.id + " [" + frame.reason + "] timed out after " +
                    frame.durationMs() + "ms without being finished")
        }
        return timedOut.size
    }

    /** True once a frame finished since the last [takeExport]/[buildExport] with clear. */
    val isExportDirty: Boolean
        get() = lock.withLock { exportDirty }

    /** The full export text (does not clear the dirty flag). */
    fun buildExport(): String = lock.withLock { buildExportLocked() }

    /** The export text if anything changed since the last take, else null; clears the dirty flag. */
    fun takeExport(): String? = lock.withLock {
        if (!exportDirty) return null
        exportDirty = false
        buildExportLocked()
    }

    // ---------------------------------------------------------------------

    /** The frame with this ID if it exists and is still open, else null. */
    private fun openFrameLocked(frameId: Int): Frame? {
        if (frameId <= 0) return null
        val frame = framesById[frameId]
        return if (frame != null && frame.isOpen()) frame else null
    }

    private fun addLineLocked(frame: Frame, now: Long, message: String?) {
        if (frame.lines.size >= MAX_LINES_PER_FRAME) {
            if (frame.lines.size == MAX_LINES_PER_FRAME) {
                frame.lines.add(Line(now, threadName(), "... line cap reached"))
            }
            return
        }
        frame.lines.add(Line(now, threadName(), message))
    }

    private fun finishFrameLocked(frame: Frame, now: Long, outcome: String) {
        frame.finishedAtMs = now
        frame.outcome = outcome
        for (open in frame.openSpans.entries) {
            frame.lines.add(Line(now, threadName(),
                    "span " + open.key + " never ended (started at +" +
                        (open.value - frame.startedAtMs) + "ms)"))
        }
        frame.openSpans.clear()
        addLineLocked(frame, now, "finished: $outcome")

        val root = frame.root()
        if (frame.wasSent()) {
            framesSent++
            // The user-visible latency is input (or timer) to the first pixels
            // that actually reached the glasses, wherever in the tree that was.
            if (!root.subtreeSentRecorded) {
                root.subtreeSentRecorded = true
                recordLatencyLocked(root, now - root.startedAtMs)
                insertSlowestLocked(root)
            }
        } else if (outcome.startsWith("timeout")) {
            framesTimedOut++
        } else {
            framesDiscarded++
        }

        if (root === frame) {
            recentRoots.addLast(frame)
            while (recentRoots.size > RECENT_ROOTS_KEPT) {
                recentRoots.removeFirst()
            }
        }
        exportDirty = true
    }

    private fun recordLatencyLocked(root: Frame, latencyMs: Long) {
        val bucket = if (root.reason.startsWith("input:")) inputLatencies else renderLatencies
        bucket.addLast(latencyMs)
        while (bucket.size > SENT_DURATIONS_WINDOW) {
            bucket.removeFirst()
        }
    }

    private fun insertSlowestLocked(root: Frame) {
        if (!slowestRoots.contains(root)) {
            slowestRoots.add(root)
        }
        // Sorted and trimmed at export time, when every subtree duration is final.
    }

    /** {p50, p90, p99, max} over a rolling latency window, or null if empty. */
    private fun percentilesLocked(window: ArrayDeque<Long>): LongArray? {
        if (window.isEmpty()) return null
        val sorted: MutableList<Long> = ArrayList(window)
        sorted.sort()
        return longArrayOf(
            percentileOfSorted(sorted, 50),
            percentileOfSorted(sorted, 90),
            percentileOfSorted(sorted, 99),
            sorted[sorted.size - 1],
        )
    }

    private fun buildExportLocked(): String {
        val now = platform.elapsedRealtimeMs()
        val out = StringBuilder(64 * 1024)
        out.append("FrameTimings export at ").append(formatWallClock(wallClockMs())).append('\n')
        out.append(statsSummaryLocked()).append('\n')
        out.append('\n')
        out.append("Frames are trees: an input event's own frame is the root, and the renders it\n")
        out.append("caused are indented under it with offsets measured from the root's start.\n")
        out.append('\n')

        // Stable sort, descending by whole-tree duration (matches Collections.sort).
        slowestRoots.sortWith(compareByDescending { it.subtreeEndAtMs(now) - it.startedAtMs })
        while (slowestRoots.size > SLOWEST_ROOTS_KEPT) {
            slowestRoots.removeAt(slowestRoots.size - 1)
        }

        out.append("=== slowest frames that reached the glasses ===\n")
        for (frame in slowestRoots) {
            appendTreeLocked(out, frame, frame, now)
        }

        out.append("=== recent frames (oldest first) ===\n")
        for (frame in recentRoots) {
            appendTreeLocked(out, frame, frame, now)
        }
        return out.toString()
    }

    private fun statsSummaryLocked(): String {
        val input = percentilesLocked(inputLatencies)
        val render = percentilesLocked(renderLatencies)
        val out = StringBuilder()
        out.append("frames started=").append(framesStarted).append(" sent=").append(framesSent)
            .append(" discarded=").append(framesDiscarded).append(" timeout=").append(framesTimedOut)
            .append(" open=").append(openFrameCountLocked())
        appendPercentilesLocked(out, "input-to-display latency", inputLatencies.size, input)
        appendPercentilesLocked(out, "render-to-display latency", renderLatencies.size, render)
        return out.toString()
    }

    private fun appendPercentilesLocked(out: StringBuilder, label: String, count: Int, percentiles: LongArray?) {
        if (percentiles == null) return
        out.append('\n').append(label).append(" (last ").append(count).append("): p50=")
            .append(percentiles[0]).append("ms p90=").append(percentiles[1])
            .append("ms p99=").append(percentiles[2]).append("ms max=").append(percentiles[3]).append("ms")
    }

    private fun openFrameCountLocked(): Int {
        var open = 0
        for (frame in framesById.values) {
            if (frame.isOpen()) open++
        }
        return open
    }

    /** Print a frame and its descendants, all timed against root's start. */
    private fun appendTreeLocked(out: StringBuilder, frame: Frame, root: Frame, now: Long) {
        var depth = 0
        var walk: Frame? = frame
        while (walk !== root) {
            depth++
            walk = walk!!.parent
        }
        val indent = "  ".repeat(depth)
        val startOffsetMs = frame.startedAtMs - root.startedAtMs
        out.append(indent).append("frame#").append(frame.id)
            .append(" [").append(frame.reason).append(']')
        if (frame === root) {
            out.append(" started ").append(formatWallClock(frame.startedWallClockMs))
            val totalMs = frame.subtreeEndAtMs(now) - frame.startedAtMs
            out.append(" duration ").append(frame.durationMs()).append("ms")
            if (frame.children.isNotEmpty()) {
                out.append(" (tree ").append(totalMs).append("ms")
                    .append(if (frame.subtreeHasOpenFrame()) ", still open" else "").append(')')
            }
        } else {
            out.append(" started +").append(startOffsetMs).append("ms")
                .append(" duration ").append(if (frame.isOpen()) "open" else (frame.durationMs().toString() + "ms"))
        }
        out.append(" outcome ").append(frame.outcome ?: "(open)").append('\n')
        for (line in frame.lines) {
            out.append(indent).append("  ").append(signedWidth7(line.atMs - root.startedAtMs))
                .append("ms [").append(line.thread).append("] ").append(line.message).append('\n')
        }
        for (child in frame.children) {
            appendTreeLocked(out, child, root, now)
        }
    }
}
