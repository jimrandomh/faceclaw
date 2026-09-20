package com.faceclaw.app;

import android.content.Context;
import android.os.SystemClock;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

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
 * {@link #startFrame(String, int)}. The export nests descendants under their
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
public final class FrameTimings {
    private static final String TAG = "FrameTimings";
    private static final FrameTimings INSTANCE = new FrameTimings();

    /** Frames still open after this long are finished as "timeout". */
    private static final long FRAME_TIMEOUT_MS = 30_000;
    private static final long EXPORT_INTERVAL_MS = 15_000;
    private static final long SWEEP_INTERVAL_MS = 5_000;
    private static final int RECENT_ROOTS_KEPT = 40;
    private static final int SLOWEST_ROOTS_KEPT = 20;
    private static final int SENT_DURATIONS_WINDOW = 512;
    private static final int MAX_LINES_PER_FRAME = 200;
    /**
     * Frames retained for ID lookup. Well above the number any export can
     * reference, so a late log/span/finish call always finds its frame; frames
     * older than this are unreachable and get collected.
     */
    private static final int FRAMES_RETAINED = 1024;
    private static final String EXPORT_FILE_NAME = "frame-timings.txt";

    public static FrameTimings getInstance() {
        return INSTANCE;
    }

    private static final class Line {
        final long atMs;          // SystemClock.elapsedRealtime()
        final String thread;
        final String message;

        Line(long atMs, String thread, String message) {
            this.atMs = atMs;
            this.thread = thread;
            this.message = message;
        }
    }

    private static final class Frame {
        final int id;
        final long startedAtMs;       // SystemClock.elapsedRealtime()
        final long startedWallClockMs;
        final Frame parent;
        final List<Frame> children = new ArrayList<>(0);
        final List<Line> lines = new ArrayList<>();
        final Map<String, Long> openSpans = new LinkedHashMap<>();
        String reason;
        long finishedAtMs;
        String outcome; // null while open; "sent", "discarded: ...", "timeout: ..."
        /** Set on the root once some frame in its subtree reached the glasses. */
        boolean subtreeSentRecorded;

        Frame(int id, String reason, long startedAtMs, long startedWallClockMs, Frame parent) {
            this.id = id;
            this.reason = reason;
            this.startedAtMs = startedAtMs;
            this.startedWallClockMs = startedWallClockMs;
            this.parent = parent;
        }

        Frame root() {
            Frame frame = this;
            while (frame.parent != null) {
                frame = frame.parent;
            }
            return frame;
        }

        boolean isOpen() {
            return outcome == null;
        }

        long durationMs() {
            return finishedAtMs - startedAtMs;
        }

        boolean wasSent() {
            return outcome != null && outcome.startsWith("sent");
        }

        /** Last moment anything in this subtree happened, for whole-tree duration. */
        long subtreeEndAtMs(long nowMs) {
            long end = isOpen() ? nowMs : finishedAtMs;
            for (Frame child : children) {
                end = Math.max(end, child.subtreeEndAtMs(nowMs));
            }
            return end;
        }

        boolean subtreeHasOpenFrame() {
            if (isOpen()) {
                return true;
            }
            for (Frame child : children) {
                if (child.subtreeHasOpenFrame()) {
                    return true;
                }
            }
            return false;
        }
    }

    private final Object lock = new Object();
    /**
     * Every frame we still retain, keyed by ID: open frames plus enough
     * history that late calls and the export can still resolve one.
     */
    private final LinkedHashMap<Integer, Frame> framesById =
        new LinkedHashMap<Integer, Frame>(64, 0.75f, false) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<Integer, Frame> eldest) {
                return size() > FRAMES_RETAINED && !eldest.getValue().isOpen();
            }
        };
    private final ArrayDeque<Frame> recentRoots = new ArrayDeque<>();
    private final List<Frame> slowestRoots = new ArrayList<>();
    private final ArrayDeque<Long> inputLatencies = new ArrayDeque<>();
    private final ArrayDeque<Long> renderLatencies = new ArrayDeque<>();
    private int nextFrameId = 1;
    private long framesStarted;
    private long framesSent;
    private long framesDiscarded;
    private long framesTimedOut;
    private boolean exportDirty;
    private File exportDir;
    private Thread exportThread;

    private FrameTimings() {
    }

    /** Idempotent; enables filesystem export. Safe to call from any constructor path. */
    public void init(Context context) {
        File dir = context.getApplicationContext().getExternalFilesDir(null);
        if (dir == null) {
            dir = context.getApplicationContext().getFilesDir();
        }
        synchronized (lock) {
            exportDir = dir;
            if (exportThread == null) {
                exportThread = new Thread(this::exportLoop, "FrameTimingsExport");
                exportThread.setDaemon(true);
                exportThread.start();
            }
        }
    }

    /** Begin a root frame; reason is a short label like "input:sys-event type=0". */
    public int startFrame(String reason) {
        return startFrame(reason, 0);
    }

    /**
     * Begin a frame caused by an existing one (parentFrameId; 0 for a root).
     * The child is nested under its root in the export and its latency counts
     * against the root, so an input event that fans out into an app render and
     * a shell-chrome render reads as one timeline instead of three.
     */
    public int startFrame(String reason, int parentFrameId) {
        long now = SystemClock.elapsedRealtime();
        Frame frame;
        synchronized (lock) {
            Frame parent = framesById.get(parentFrameId);
            frame = new Frame(nextFrameId++, reason == null ? "" : reason, now,
                    System.currentTimeMillis(), parent);
            framesById.put(frame.id, frame);
            framesStarted++;
            if (parent != null) {
                parent.children.add(frame);
                addLineLocked(parent, now, "spawned frame#" + frame.id + " (" + frame.reason + ")");
            }
        }
        return frame.id;
    }

    /**
     * Append to a frame's label, for facts only known after it started (which
     * app is in the foreground, which window a render is for). Shows up in the
     * frame's header line, so the export is scannable without reading bodies.
     */
    public void annotate(int frameId, String text) {
        if (text == null || text.isEmpty()) {
            return;
        }
        synchronized (lock) {
            Frame frame = framesById.get(frameId);
            if (frame == null) {
                return;
            }
            frame.reason = frame.reason.isEmpty() ? text : frame.reason + " " + text;
        }
    }

    public void log(int frameId, String message) {
        long now = SystemClock.elapsedRealtime();
        synchronized (lock) {
            Frame frame = openFrameLocked(frameId);
            if (frame == null) {
                return;
            }
            addLineLocked(frame, now, message);
        }
    }

    public void spanStart(int frameId, String name) {
        long now = SystemClock.elapsedRealtime();
        synchronized (lock) {
            Frame frame = openFrameLocked(frameId);
            if (frame == null) {
                return;
            }
            frame.openSpans.put(name, now);
            addLineLocked(frame, now, "span " + name + " start");
        }
    }

    public void spanEnd(int frameId, String name) {
        long now = SystemClock.elapsedRealtime();
        synchronized (lock) {
            Frame frame = openFrameLocked(frameId);
            if (frame == null) {
                return;
            }
            Long startedAt = frame.openSpans.remove(name);
            if (startedAt == null) {
                addLineLocked(frame, now, "span " + name + " end (start not recorded)");
            } else {
                addLineLocked(frame, now, "span " + name + " end (" + (now - startedAt) + "ms)");
            }
        }
    }

    /**
     * Finish a frame. Outcomes: "sent" (counted in latency percentiles), anything
     * starting with "discarded", or "timeout". First finish wins; later calls for
     * the same frame are ignored, so racing completion paths are safe.
     */
    public void finishFrame(int frameId, String outcome) {
        long now = SystemClock.elapsedRealtime();
        Frame finished;
        synchronized (lock) {
            Frame frame = openFrameLocked(frameId);
            if (frame == null) {
                return;
            }
            finishFrameLocked(frame, now, outcome == null ? "discarded: no outcome given" : outcome);
            finished = frame;
        }
        Log.i(TAG, "frame#" + finished.id + " [" + finished.reason + "] -> " + finished.outcome
                + " in " + finished.durationMs() + "ms");
    }

    /** One-line stats summary, e.g. for showing in the phone UI. */
    public String statsSummary() {
        synchronized (lock) {
            long[] input = percentilesLocked(inputLatencies);
            return "frames started=" + framesStarted + " sent=" + framesSent
                    + " discarded=" + framesDiscarded + " timeout=" + framesTimedOut
                    + (input == null
                        ? ""
                        : " | input-to-display p50=" + input[0] + "ms p90=" + input[1]
                            + "ms p99=" + input[2] + "ms max=" + input[3] + "ms");
        }
    }

    // ---------------------------------------------------------------------

    /** The frame with this ID if it exists and is still open, else null. */
    private Frame openFrameLocked(int frameId) {
        if (frameId <= 0) {
            return null;
        }
        Frame frame = framesById.get(frameId);
        return frame != null && frame.isOpen() ? frame : null;
    }

    private void addLineLocked(Frame frame, long now, String message) {
        if (frame.lines.size() >= MAX_LINES_PER_FRAME) {
            if (frame.lines.size() == MAX_LINES_PER_FRAME) {
                frame.lines.add(new Line(now, Thread.currentThread().getName(), "... line cap reached"));
            }
            return;
        }
        frame.lines.add(new Line(now, Thread.currentThread().getName(), message));
    }

    private void finishFrameLocked(Frame frame, long now, String outcome) {
        frame.finishedAtMs = now;
        frame.outcome = outcome;
        for (Map.Entry<String, Long> open : frame.openSpans.entrySet()) {
            frame.lines.add(new Line(now, Thread.currentThread().getName(),
                    "span " + open.getKey() + " never ended (started at +"
                        + (open.getValue() - frame.startedAtMs) + "ms)"));
        }
        frame.openSpans.clear();
        addLineLocked(frame, now, "finished: " + outcome);

        Frame root = frame.root();
        if (frame.wasSent()) {
            framesSent++;
            // The user-visible latency is input (or timer) to the first pixels
            // that actually reached the glasses, wherever in the tree that was.
            if (!root.subtreeSentRecorded) {
                root.subtreeSentRecorded = true;
                recordLatencyLocked(root, now - root.startedAtMs);
                insertSlowestLocked(root);
            }
        } else if (outcome.startsWith("timeout")) {
            framesTimedOut++;
        } else {
            framesDiscarded++;
        }

        if (root == frame) {
            recentRoots.addLast(frame);
            while (recentRoots.size() > RECENT_ROOTS_KEPT) {
                recentRoots.removeFirst();
            }
        }
        exportDirty = true;
    }

    private void recordLatencyLocked(Frame root, long latencyMs) {
        ArrayDeque<Long> bucket = root.reason.startsWith("input:") ? inputLatencies : renderLatencies;
        bucket.addLast(latencyMs);
        while (bucket.size() > SENT_DURATIONS_WINDOW) {
            bucket.removeFirst();
        }
    }

    private void insertSlowestLocked(Frame root) {
        if (!slowestRoots.contains(root)) {
            slowestRoots.add(root);
        }
        // Sorted and trimmed at export time, when every subtree duration is final.
    }

    /** {p50, p90, p99, max} over a rolling latency window, or null if empty. */
    private long[] percentilesLocked(ArrayDeque<Long> window) {
        if (window.isEmpty()) {
            return null;
        }
        List<Long> sorted = new ArrayList<>(window);
        Collections.sort(sorted);
        return new long[] {
            percentileOfSorted(sorted, 50),
            percentileOfSorted(sorted, 90),
            percentileOfSorted(sorted, 99),
            sorted.get(sorted.size() - 1),
        };
    }

    private static long percentileOfSorted(List<Long> sorted, int percentile) {
        int index = (int) Math.ceil(percentile / 100.0 * sorted.size()) - 1;
        return sorted.get(Math.max(0, Math.min(sorted.size() - 1, index)));
    }

    private void sweepTimedOutFrames() {
        long now = SystemClock.elapsedRealtime();
        List<Frame> timedOut = new ArrayList<>();
        synchronized (lock) {
            for (Frame frame : new ArrayList<>(framesById.values())) {
                if (frame.isOpen() && now - frame.startedAtMs >= FRAME_TIMEOUT_MS) {
                    finishFrameLocked(frame, now, "timeout: never reported finished");
                    timedOut.add(frame);
                }
            }
        }
        for (Frame frame : timedOut) {
            Log.w(TAG, "frame#" + frame.id + " [" + frame.reason + "] timed out after "
                    + frame.durationMs() + "ms without being finished");
        }
    }

    private void exportLoop() {
        long lastExportAtMs = 0;
        while (true) {
            try {
                Thread.sleep(SWEEP_INTERVAL_MS);
            } catch (InterruptedException e) {
                return;
            }
            try {
                sweepTimedOutFrames();
                long now = SystemClock.elapsedRealtime();
                boolean shouldExport;
                synchronized (lock) {
                    shouldExport = exportDirty && exportDir != null && now - lastExportAtMs >= EXPORT_INTERVAL_MS;
                }
                if (shouldExport) {
                    lastExportAtMs = now;
                    exportToFile();
                }
            } catch (Throwable t) {
                Log.w(TAG, "export loop error", t);
            }
        }
    }

    private void exportToFile() {
        String content;
        File dir;
        synchronized (lock) {
            dir = exportDir;
            if (dir == null) {
                return;
            }
            content = buildExportLocked();
            exportDirty = false;
        }
        File target = new File(dir, EXPORT_FILE_NAME);
        File temp = new File(dir, EXPORT_FILE_NAME + ".tmp");
        try {
            try (Writer writer = new OutputStreamWriter(new FileOutputStream(temp), StandardCharsets.UTF_8)) {
                writer.write(content);
            }
            if (!temp.renameTo(target)) {
                Log.w(TAG, "failed to rename " + temp + " to " + target);
            }
        } catch (Throwable t) {
            Log.w(TAG, "failed to export frame timings", t);
        }
    }

    private String buildExportLocked() {
        long now = SystemClock.elapsedRealtime();
        SimpleDateFormat wallClockFormat = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US);
        StringBuilder out = new StringBuilder(64 * 1024);
        out.append("FrameTimings export at ").append(wallClockFormat.format(new Date())).append('\n');
        out.append(statsSummaryLocked()).append('\n');
        out.append('\n');
        out.append("Frames are trees: an input event's own frame is the root, and the renders it\n");
        out.append("caused are indented under it with offsets measured from the root's start.\n");
        out.append('\n');

        Collections.sort(slowestRoots, (a, b) ->
                Long.compare(b.subtreeEndAtMs(now) - b.startedAtMs, a.subtreeEndAtMs(now) - a.startedAtMs));
        while (slowestRoots.size() > SLOWEST_ROOTS_KEPT) {
            slowestRoots.remove(slowestRoots.size() - 1);
        }

        out.append("=== slowest frames that reached the glasses ===\n");
        for (Frame frame : slowestRoots) {
            appendTreeLocked(out, frame, frame, wallClockFormat, now);
        }

        out.append("=== recent frames (oldest first) ===\n");
        for (Frame frame : recentRoots) {
            appendTreeLocked(out, frame, frame, wallClockFormat, now);
        }
        return out.toString();
    }

    private String statsSummaryLocked() {
        long[] input = percentilesLocked(inputLatencies);
        long[] render = percentilesLocked(renderLatencies);
        StringBuilder out = new StringBuilder();
        out.append("frames started=").append(framesStarted).append(" sent=").append(framesSent)
            .append(" discarded=").append(framesDiscarded).append(" timeout=").append(framesTimedOut)
            .append(" open=").append(openFrameCountLocked());
        appendPercentilesLocked(out, "input-to-display latency", inputLatencies.size(), input);
        appendPercentilesLocked(out, "render-to-display latency", renderLatencies.size(), render);
        return out.toString();
    }

    private void appendPercentilesLocked(StringBuilder out, String label, int count, long[] percentiles) {
        if (percentiles == null) {
            return;
        }
        out.append('\n').append(label).append(" (last ").append(count).append("): p50=")
            .append(percentiles[0]).append("ms p90=").append(percentiles[1])
            .append("ms p99=").append(percentiles[2]).append("ms max=").append(percentiles[3]).append("ms");
    }

    private int openFrameCountLocked() {
        int open = 0;
        for (Frame frame : framesById.values()) {
            if (frame.isOpen()) {
                open++;
            }
        }
        return open;
    }

    /** Print a frame and its descendants, all timed against root's start. */
    private void appendTreeLocked(
            StringBuilder out, Frame frame, Frame root, SimpleDateFormat wallClockFormat, long now) {
        int depth = 0;
        for (Frame walk = frame; walk != root; walk = walk.parent) {
            depth++;
        }
        String indent = repeat("  ", depth);
        long startOffsetMs = frame.startedAtMs - root.startedAtMs;
        out.append(indent).append("frame#").append(frame.id)
            .append(" [").append(frame.reason).append(']');
        if (frame == root) {
            out.append(" started ").append(wallClockFormat.format(new Date(frame.startedWallClockMs)));
            long totalMs = frame.subtreeEndAtMs(now) - frame.startedAtMs;
            out.append(" duration ").append(frame.durationMs()).append("ms");
            if (!frame.children.isEmpty()) {
                out.append(" (tree ").append(totalMs).append("ms")
                    .append(frame.subtreeHasOpenFrame() ? ", still open" : "").append(')');
            }
        } else {
            out.append(" started +").append(startOffsetMs).append("ms")
                .append(" duration ").append(frame.isOpen() ? "open" : (frame.durationMs() + "ms"));
        }
        out.append(" outcome ").append(frame.outcome == null ? "(open)" : frame.outcome).append('\n');
        for (Line line : frame.lines) {
            out.append(indent).append(String.format(Locale.US, "  %+7dms [%s] %s",
                    line.atMs - root.startedAtMs, line.thread, line.message)).append('\n');
        }
        for (Frame child : frame.children) {
            appendTreeLocked(out, child, root, wallClockFormat, now);
        }
    }

    private static String repeat(String unit, int times) {
        StringBuilder out = new StringBuilder(unit.length() * times);
        for (int i = 0; i < times; i++) {
            out.append(unit);
        }
        return out.toString();
    }
}
