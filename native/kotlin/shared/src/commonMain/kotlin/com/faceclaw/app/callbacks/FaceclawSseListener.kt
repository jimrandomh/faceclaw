package com.faceclaw.app

/** Callbacks for FaceclawSseRequest, delivered on the constructing thread's Looper. */
interface FaceclawSseListener {
    /** One line of a successful (2xx) streaming response body, without the newline. */
    fun onLine(line: String?): Unit

    /** The server answered with a non-2xx status; body is the full error body. */
    fun onHttpError(code: Int, body: String?): Unit

    /** The 2xx response body ended normally. */
    fun onComplete(): Unit

    /** Network-level failure (connect, TLS, mid-stream drop). Not called after cancel(). */
    fun onFailure(message: String?): Unit
}
