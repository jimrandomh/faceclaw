package com.faceclaw.app

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/** Android storage adapter for the shared GIF recorder. */
class GifScreenRecorder {
    private val recorder = SharedGifScreenRecorder()

    fun addFrame(gray: ByteArray?, width: Int, height: Int, timestampMs: Long) {
        recorder.addFrame(gray, width, height, timestampMs)
    }

    fun isOverflowed(): Boolean = recorder.isOverflowed()

    @Throws(IOException::class)
    fun save(context: Context): String {
        val gif = recorder.encode()
        if (gif.isEmpty()) return ""
        val file = File(ScreenshotUtil.ensureScreenshotsDir(context),
                "recording-" + ScreenshotUtil.timestamp() + ".gif")
        FileOutputStream(file).use { out -> out.write(gif) }
        return file.absolutePath
    }
}
