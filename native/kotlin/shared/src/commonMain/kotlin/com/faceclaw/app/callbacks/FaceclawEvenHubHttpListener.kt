package com.faceclaw.app

/** Callbacks for one hosted EvenHub app's native HTTP session. */
interface FaceclawEvenHubHttpListener {
    /** The response body is fully downloaded and ready for offset reads. Any HTTP status is a response. */
    fun onResponse(requestId: String, status: Int, url: String, headersJson: String): Unit

    /** Transport, timeout, size-limit, or storage failure; no response remains readable. */
    fun onFailure(requestId: String, message: String?): Unit
}
