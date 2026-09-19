package com.faceclaw.app

/** Progress callbacks for FaceclawModelDownloader, posted to the creating thread's Looper. */
interface FaceclawModelDownloaderListener {
    fun onProgress(bytesDownloaded: Long, totalBytes: Long): Unit

    /** The file is fully downloaded, verified, and moved to its final path. */
    fun onDone(path: String?): Unit

    fun onError(message: String?): Unit
}
