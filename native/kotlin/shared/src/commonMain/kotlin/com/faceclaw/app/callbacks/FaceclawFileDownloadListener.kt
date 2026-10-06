package com.faceclaw.app

/** Callbacks for FaceclawFileDownload, delivered on the constructing thread's Looper. */
interface FaceclawFileDownloadListener {
    /** The response finished; for a 2xx status the body is at the destination path, otherwise nothing is written. */
    fun onDone(status: Int, contentLength: Long): Unit

    /** Network-level failure (connect, TLS, timeout, mid-body drop); the destination is removed. */
    fun onFailure(message: String?): Unit
}
