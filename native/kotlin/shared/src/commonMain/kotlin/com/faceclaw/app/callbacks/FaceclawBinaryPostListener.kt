package com.faceclaw.app

/** Callbacks for FaceclawBinaryPost, delivered on the constructing thread's Looper. */
interface FaceclawBinaryPostListener {
    /** The server answered, with any status; body is the response text. */
    fun onResponse(status: Int, body: String?): Unit

    /** Network-level failure (connect, TLS, timeout, mid-body drop); no response arrived. */
    fun onFailure(message: String?): Unit
}
