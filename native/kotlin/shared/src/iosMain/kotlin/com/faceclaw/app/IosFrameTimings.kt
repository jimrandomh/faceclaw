package com.faceclaw.app

import platform.Foundation.NSDocumentDirectory
import platform.Foundation.NSSearchPathForDirectoriesInDomains
import platform.Foundation.NSUserDomainMask

/**
 * iOS facade over the shared [FrameTimingsCore] with the Android FrameTimings method set.
 * [startExport] enables the export thread that sweeps timed-out frames every 5 s and writes
 * <Documents>/frame-timings.txt every 15 s while dirty (the app's Documents folder is
 * visible in Finder/Files when UIFileSharingEnabled is on).
 */
class IosFrameTimings internal constructor(platform: ProtocolPlatform) {
    constructor() : this(IosProtocolPlatform)

    val core = FrameTimingsCore(platform)
    private val lock = platform.createLock()
    private var exportDir: String? = null
    private var exporting = false

    /** Idempotent; enables filesystem export into [directory] (default: Documents). */
    fun startExport(directory: String?) {
        lock.withLock {
            exportDir = directory ?: documentsDirectory()
            if (exporting) return
            exporting = true
        }
        startThread("FrameTimingsExport", true) { exportLoop() }
    }

    fun startFrame(reason: String?): Int = core.startFrame(reason)

    fun startFrame(reason: String?, parentFrameId: Int): Int = core.startFrame(reason, parentFrameId)

    fun annotate(frameId: Int, text: String?) = core.annotate(frameId, text)

    fun log(frameId: Int, message: String?) = core.log(frameId, message)

    fun spanStart(frameId: Int, name: String) = core.spanStart(frameId, name)

    fun spanEnd(frameId: Int, name: String) = core.spanEnd(frameId, name)

    fun finishFrame(frameId: Int, outcome: String?) = core.finishFrame(frameId, outcome)

    fun statsSummary(): String = core.statsSummary()

    /** Writes the export now (if anything changed); returns the file path or null. */
    fun exportNow(): String? {
        val dir = lock.withLock { exportDir } ?: return null
        val content = core.takeExport() ?: return null
        val target = "$dir/$EXPORT_FILE_NAME"
        val temp = "$target.tmp"
        return try {
            writeFileData(temp, content.encodeToByteArray())
            if (renameFile(temp, target)) target else {
                PlatformLog.w(TAG, "failed to rename $temp to $target")
                null
            }
        } catch (t: Throwable) {
            PlatformLog.w(TAG, "failed to export frame timings: ${t.message}")
            null
        }
    }

    private fun exportLoop() {
        var lastExportAtMs = 0L
        while (true) {
            sleepMs(FrameTimingsCore.SWEEP_INTERVAL_MS)
            try {
                core.sweepTimedOut()
                val now = IosProtocolPlatform.elapsedRealtimeMs()
                if (core.isExportDirty && now - lastExportAtMs >= FrameTimingsCore.EXPORT_INTERVAL_MS) {
                    lastExportAtMs = now
                    exportNow()
                }
            } catch (t: Throwable) {
                PlatformLog.w(TAG, "export loop error: ${t.message}")
            }
        }
    }

    companion object {
        private const val TAG = FrameTimingsCore.TAG
        const val EXPORT_FILE_NAME = "frame-timings.txt"
        val shared: IosFrameTimings by lazy { IosFrameTimings() }

        fun documentsDirectory(): String =
            NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, true).firstOrNull() as? String ?: "."
    }
}
