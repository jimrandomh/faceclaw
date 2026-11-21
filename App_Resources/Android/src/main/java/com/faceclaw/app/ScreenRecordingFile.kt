package com.faceclaw.app

import android.content.Context
import android.util.Log
import java.io.BufferedWriter
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets

/**
 * Android storage for a finished [ScreenRecorder]: a JSON Lines file beside the
 * screenshots. Retrieve with scripts/pull-screen-recording.sh and open it in
 * tools/screen-recording-visualizer.
 */
object ScreenRecordingFile {
    private const val TAG = "FaceclawRecording"

    /** Returns the absolute path of the written file. */
    @JvmStatic
    @Throws(IOException::class)
    fun save(context: Context, recorder: ScreenRecorder): String {
        if (recorder.isTruncated) {
            Log.i(TAG, "screen recording hit its size limit; the tail was dropped")
        }
        val file = File(ScreenshotUtil.ensureScreenshotsDir(context),
                "recording-" + ScreenshotUtil.timestamp() + ScreenRecorder.FILE_SUFFIX)
        BufferedWriter(OutputStreamWriter(FileOutputStream(file), StandardCharsets.UTF_8), 1 shl 16).use { out ->
            recorder.writeLines { line ->
                out.write(line)
                out.write('\n'.code)
            }
        }
        return file.absolutePath
    }
}
