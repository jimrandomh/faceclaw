package com.faceclaw.app

import android.content.Context
import android.os.SystemClock
import android.util.Log

import java.io.File
import java.io.FileOutputStream
import java.io.OutputStreamWriter
import java.io.Writer
import java.nio.charset.StandardCharsets
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.ArrayList
import java.util.Collections
import java.util.Date
import java.util.LinkedHashMap
import java.util.Locale

/**
 * Per-frame timing instrumentation, shared between the Java BLE layer and the
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
 * worker thread, the Android main thread, the JS thread, and app worker
 * threads. Frame IDs are positive ints; 0 means "no frame" and is silently
 * ignored everywhere, so callers do not need to null-check.
 *
 * Statistics and full log lines for recent and slowest frames are periodically
 * exported to getExternalFilesDir()/frame-timings.txt, retrievable via
 *   adb pull /sdcard/Android/data/<pkg>/files/frame-timings.txt
 */
class FrameTimings private constructor() {
    companion object {
        private const val TAG = "FrameTimings"
        private val INSTANCE = FrameTimings()

        /** Frames still open after this long are finished as "timeout". */
        private const val FRAME_TIMEOUT_MS = 30_000L
        private const val EXPORT_INTERVAL_MS = 15_000L
        private const val SWEEP_INTERVAL_MS = 5_000L
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
        private const val EXPORT_FILE_NAME = "frame-timings.txt"

        @JvmStatic
        fun getInstance(): FrameTimings {
            return INSTANCE
        }

        @JvmStatic
        private fun percentileOfSorted(sorted: List<Long>, percentile: Int): Long {
            val index = Math.ceil(percentile / 100.0 * sorted.size).toInt() - 1
            return sorted[Math.max(0, Math.min(sorted.size - 1, index))]
        }

        @JvmStatic
        private fun repeat(unit: String, times: Int): String {
            val out = StringBuilder(unit.length * times)
            for (i in 0 until times) {
                out.append(unit)
            }
            return out.toString()
        }
    }

    private class Line(
        val atMs: Long,          // SystemClock.elapsedRealtime()
        val thread: String,
        val message: String?
    )

    private class Frame(
        val id: Int,
        var reason: String,
        val startedAtMs: Long,       // SystemClock.elapsedRealtime()
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

        fun isOpen(): Boolean {
            return outcome == null
        }

        fun durationMs(): Long {
            return finishedAtMs - startedAtMs
        }

        fun wasSent(): Boolean {
            val outcome = this.outcome
            return outcome != null && outcome.startsWith("sent")
        }

        /** Last moment anything in this subtree happened, for whole-tree duration. */
        fun subtreeEndAtMs(nowMs: Long): Long {
            var end = if (isOpen()) nowMs else finishedAtMs
            for (child in children) {
                end = Math.max(end, child.subtreeEndAtMs(nowMs))
            }
            return end
        }

        fun subtreeHasOpenFrame(): Boolean {
            if (isOpen()) {
                return true
            }
            for (child in children) {
                if (child.subtreeHasOpenFrame()) {
                    return true
                }
            }
            return false
        }
    }

    private val lock = Any()
    /**
     * Every frame we still retain, keyed by ID: open frames plus enough
     * history that late calls and the export can still resolve one.
     */
    private val framesById: LinkedHashMap<Int, Frame> =
        object : LinkedHashMap<Int, Frame>(64, 0.75f, false) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Int, Frame>): Boolean {
                return size > FRAMES_RETAINED && !eldest.value.isOpen()
            }
        }
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
    private var exportDir: File? = null
    private var exportThread: Thread? = null

    /** Idempotent; enables filesystem export. Safe to call from any constructor path. */
    fun init(context: Context) {
        var dir = context.applicationContext.getExternalFilesDir(null)
        if (dir == null) {
            dir = context.applicationContext.filesDir
        }
        synchronized(lock) {
            exportDir = dir
            if (exportThread == null) {
                val thread = Thread(Runnable { exportLoop() }, "FrameTimingsExport")
                thread.isDaemon = true
                thread.start()
                exportThread = thread
            }
        }
    }

    /** Begin a root frame; reason is a short label like "input:sys-event type=0". */
    fun startFrame(reason: String?): Int {
        return startFrame(reason, 0)
    }

    /**
     * Begin a frame caused by an existing one (parentFrameId; 0 for a root).
     * The child is nested under its root in the export and its latency counts
     * against the root, so an input event that fans out into an app render and
     * a shell-chrome render reads as one timeline instead of three.
     */
    fun startFrame(reason: String?, parentFrameId: Int): Int {
        val now = SystemClock.elapsedRealtime()
        val frame: Frame
        synchronized(lock) {
            val parent = framesById[parentFrameId]
            frame = Frame(nextFrameId++, reason ?: "", now,
                    System.currentTimeMillis(), parent)
            framesById[frame.id] = frame
            framesStarted++
            if (parent != null) {
                parent.children.add(frame)
                addLineLocked(parent, now, "spawned frame#" + frame.id + " (" + frame.reason + ")")
            }
        }
        return frame.id
    }

    /**
     * Append to a frame's label, for facts only known after it started (which
     * app is in the foreground, which window a render is for). Shows up in the
     * frame's header line, so the export is scannable without reading bodies.
     */
    fun annotate(frameId: Int, text: String?) {
        if (text == null || text.isEmpty()) {
            return
        }
        synchronized(lock) {
            val frame = framesById[frameId]
            if (frame == null) {
                return
            }
            frame.reason = if (frame.reason.isEmpty()) text else frame.reason + " " + text
        }
    }

    fun log(frameId: Int, message: String?) {
        val now = SystemClock.elapsedRealtime()
        synchronized(lock) {
            val frame = openFrameLocked(frameId)
            if (frame == null) {
                return
            }
            addLineLocked(frame, now, message)
        }
    }

    fun spanStart(frameId: Int, name: String) {
        val now = SystemClock.elapsedRealtime()
        synchronized(lock) {
            val frame = openFrameLocked(frameId)
            if (frame == null) {
                return
            }
            frame.openSpans[name] = now
            addLineLocked(frame, now, "span $name start")
        }
    }

    fun spanEnd(frameId: Int, name: String) {
        val now = SystemClock.elapsedRealtime()
        synchronized(lock) {
            val frame = openFrameLocked(frameId)
            if (frame == null) {
                return
            }
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
        val now = SystemClock.elapsedRealtime()
        val finished: Frame
        synchronized(lock) {
            val frame = openFrameLocked(frameId)
            if (frame == null) {
                return
            }
            finishFrameLocked(frame, now, outcome ?: "discarded: no outcome given")
            finished = frame
        }
        Log.i(TAG, "frame#" + finished.id + " [" + finished.reason + "] -> " + finished.outcome
                + " in " + finished.durationMs() + "ms")
    }

    /** One-line stats summary, e.g. for showing in the phone UI. */
    fun statsSummary(): String {
        synchronized(lock) {
            val input = percentilesLocked(inputLatencies)
            return "frames started=" + framesStarted + " sent=" + framesSent +
                    " discarded=" + framesDiscarded + " timeout=" + framesTimedOut +
                    (if (input == null)
                        ""
                        else " | input-to-display p50=" + input[0] + "ms p90=" + input[1] +
                            "ms p99=" + input[2] + "ms max=" + input[3] + "ms")
        }
    }

    // ---------------------------------------------------------------------

    /** The frame with this ID if it exists and is still open, else null. */
    private fun openFrameLocked(frameId: Int): Frame? {
        if (frameId <= 0) {
            return null
        }
        val frame = framesById[frameId]
        return if (frame != null && frame.isOpen()) frame else null
    }

    private fun addLineLocked(frame: Frame, now: Long, message: String?) {
        if (frame.lines.size >= MAX_LINES_PER_FRAME) {
            if (frame.lines.size == MAX_LINES_PER_FRAME) {
                frame.lines.add(Line(now, Thread.currentThread().name, "... line cap reached"))
            }
            return
        }
        frame.lines.add(Line(now, Thread.currentThread().name, message))
    }

    private fun finishFrameLocked(frame: Frame, now: Long, outcome: String) {
        frame.finishedAtMs = now
        frame.outcome = outcome
        for (open in frame.openSpans.entries) {
            frame.lines.add(Line(now, Thread.currentThread().name,
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
        if (window.isEmpty()) {
            return null
        }
        val sorted: MutableList<Long> = ArrayList(window)
        Collections.sort(sorted)
        return longArrayOf(
            percentileOfSorted(sorted, 50),
            percentileOfSorted(sorted, 90),
            percentileOfSorted(sorted, 99),
            sorted[sorted.size - 1],
        )
    }

    private fun sweepTimedOutFrames() {
        val now = SystemClock.elapsedRealtime()
        val timedOut: MutableList<Frame> = ArrayList()
        synchronized(lock) {
            for (frame in ArrayList(framesById.values)) {
                if (frame.isOpen() && now - frame.startedAtMs >= FRAME_TIMEOUT_MS) {
                    finishFrameLocked(frame, now, "timeout: never reported finished")
                    timedOut.add(frame)
                }
            }
        }
        for (frame in timedOut) {
            Log.w(TAG, "frame#" + frame.id + " [" + frame.reason + "] timed out after " +
                    frame.durationMs() + "ms without being finished")
        }
    }

    private fun exportLoop() {
        var lastExportAtMs = 0L
        while (true) {
            try {
                Thread.sleep(SWEEP_INTERVAL_MS)
            } catch (e: InterruptedException) {
                return
            }
            try {
                sweepTimedOutFrames()
                val now = SystemClock.elapsedRealtime()
                val shouldExport: Boolean
                synchronized(lock) {
                    shouldExport = exportDirty && exportDir != null && now - lastExportAtMs >= EXPORT_INTERVAL_MS
                }
                if (shouldExport) {
                    lastExportAtMs = now
                    exportToFile()
                }
            } catch (t: Throwable) {
                Log.w(TAG, "export loop error", t)
            }
        }
    }

    private fun exportToFile() {
        val content: String
        val dir: File
        synchronized(lock) {
            dir = exportDir ?: return
            content = buildExportLocked()
            exportDirty = false
        }
        val target = File(dir, EXPORT_FILE_NAME)
        val temp = File(dir, "$EXPORT_FILE_NAME.tmp")
        try {
            (OutputStreamWriter(FileOutputStream(temp), StandardCharsets.UTF_8) as Writer).use { writer ->
                writer.write(content)
            }
            if (!temp.renameTo(target)) {
                Log.w(TAG, "failed to rename $temp to $target")
            }
        } catch (t: Throwable) {
            Log.w(TAG, "failed to export frame timings", t)
        }
    }

    private fun buildExportLocked(): String {
        val now = SystemClock.elapsedRealtime()
        val wallClockFormat = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US)
        val out = StringBuilder(64 * 1024)
        out.append("FrameTimings export at ").append(wallClockFormat.format(Date())).append('\n')
        out.append(statsSummaryLocked()).append('\n')
        out.append('\n')
        out.append("Frames are trees: an input event's own frame is the root, and the renders it\n")
        out.append("caused are indented under it with offsets measured from the root's start.\n")
        out.append('\n')

        Collections.sort(slowestRoots, Comparator { a, b ->
                java.lang.Long.compare(b.subtreeEndAtMs(now) - b.startedAtMs, a.subtreeEndAtMs(now) - a.startedAtMs) })
        while (slowestRoots.size > SLOWEST_ROOTS_KEPT) {
            slowestRoots.removeAt(slowestRoots.size - 1)
        }

        out.append("=== slowest frames that reached the glasses ===\n")
        for (frame in slowestRoots) {
            appendTreeLocked(out, frame, frame, wallClockFormat, now)
        }

        out.append("=== recent frames (oldest first) ===\n")
        for (frame in recentRoots) {
            appendTreeLocked(out, frame, frame, wallClockFormat, now)
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
        if (percentiles == null) {
            return
        }
        out.append('\n').append(label).append(" (last ").append(count).append("): p50=")
            .append(percentiles[0]).append("ms p90=").append(percentiles[1])
            .append("ms p99=").append(percentiles[2]).append("ms max=").append(percentiles[3]).append("ms")
    }

    private fun openFrameCountLocked(): Int {
        var open = 0
        for (frame in framesById.values) {
            if (frame.isOpen()) {
                open++
            }
        }
        return open
    }

    /** Print a frame and its descendants, all timed against root's start. */
    private fun appendTreeLocked(
            out: StringBuilder, frame: Frame, root: Frame, wallClockFormat: SimpleDateFormat, now: Long) {
        var depth = 0
        var walk: Frame? = frame
        while (walk !== root) {
            depth++
            walk = walk!!.parent
        }
        val indent = repeat("  ", depth)
        val startOffsetMs = frame.startedAtMs - root.startedAtMs
        out.append(indent).append("frame#").append(frame.id)
            .append(" [").append(frame.reason).append(']')
        if (frame === root) {
            out.append(" started ").append(wallClockFormat.format(Date(frame.startedWallClockMs)))
            val totalMs = frame.subtreeEndAtMs(now) - frame.startedAtMs
            out.append(" duration ").append(frame.durationMs()).append("ms")
            if (!frame.children.isEmpty()) {
                out.append(" (tree ").append(totalMs).append("ms")
                    .append(if (frame.subtreeHasOpenFrame()) ", still open" else "").append(')')
            }
        } else {
            out.append(" started +").append(startOffsetMs).append("ms")
                .append(" duration ").append(if (frame.isOpen()) "open" else (frame.durationMs().toString() + "ms"))
        }
        out.append(" outcome ").append(frame.outcome ?: "(open)").append('\n')
        for (line in frame.lines) {
            out.append(indent).append(String.format(Locale.US, "  %+7dms [%s] %s",
                    line.atMs - root.startedAtMs, line.thread, line.message)).append('\n')
        }
        for (child in frame.children) {
            appendTreeLocked(out, child, root, wallClockFormat, now)
        }
    }
}
