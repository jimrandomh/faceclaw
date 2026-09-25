package com.faceclaw.app

import android.content.Context
import android.os.SystemClock
import android.util.Log

import java.io.File
import java.io.FileOutputStream
import java.io.OutputStreamWriter
import java.io.Writer
import java.nio.charset.StandardCharsets

/**
 * Android facade over the shared [FrameTimingsCore] (per-frame latency
 * instrumentation; see that class for the frame-tree model). This class keeps
 * the process-wide singleton the BLE layer and TypeScript call by name, and owns
 * the Android-only parts: the export directory derived from the Context and the
 * daemon thread that sweeps timed-out frames and writes the export file.
 *
 * Statistics and full log lines for recent and slowest frames are periodically
 * exported to getExternalFilesDir()/frame-timings.txt, retrievable via
 *   adb pull /sdcard/Android/data/<pkg>/files/frame-timings.txt
 */
class FrameTimings private constructor() {
    companion object {
        private const val TAG = FrameTimingsCore.TAG
        private val INSTANCE = FrameTimings()
        private const val EXPORT_FILE_NAME = "frame-timings.txt"

        @JvmStatic
        fun getInstance(): FrameTimings {
            return INSTANCE
        }
    }

    /** The shared core; the glasses session core records frames into it directly. */
    val core = FrameTimingsCore(AndroidProtocolPlatform)
    private val lock = Any()
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
    fun startFrame(reason: String?): Int = core.startFrame(reason)

    /** Begin a frame caused by an existing one (parentFrameId; 0 for a root). */
    fun startFrame(reason: String?, parentFrameId: Int): Int = core.startFrame(reason, parentFrameId)

    /** Append to a frame's label, for facts only known after it started. */
    fun annotate(frameId: Int, text: String?) = core.annotate(frameId, text)

    fun log(frameId: Int, message: String?) = core.log(frameId, message)

    fun spanStart(frameId: Int, name: String) = core.spanStart(frameId, name)

    fun spanEnd(frameId: Int, name: String) = core.spanEnd(frameId, name)

    /**
     * Finish a frame. Outcomes: "sent" (counted in latency percentiles), anything
     * starting with "discarded", or "timeout". First finish wins.
     */
    fun finishFrame(frameId: Int, outcome: String?) = core.finishFrame(frameId, outcome)

    /** One-line stats summary, e.g. for showing in the phone UI. */
    fun statsSummary(): String = core.statsSummary()

    // ---------------------------------------------------------------------

    private fun exportLoop() {
        var lastExportAtMs = 0L
        while (true) {
            try {
                Thread.sleep(FrameTimingsCore.SWEEP_INTERVAL_MS)
            } catch (e: InterruptedException) {
                return
            }
            try {
                core.sweepTimedOut()
                val now = SystemClock.elapsedRealtime()
                val dir: File?
                synchronized(lock) { dir = exportDir }
                if (dir != null && core.isExportDirty && now - lastExportAtMs >= FrameTimingsCore.EXPORT_INTERVAL_MS) {
                    lastExportAtMs = now
                    exportToFile(dir)
                }
            } catch (t: Throwable) {
                Log.w(TAG, "export loop error", t)
            }
        }
    }

    private fun exportToFile(dir: File) {
        val content = core.takeExport() ?: return
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
}
