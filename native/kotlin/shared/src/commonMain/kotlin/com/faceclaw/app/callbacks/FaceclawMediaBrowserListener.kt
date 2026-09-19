package com.faceclaw.app

interface FaceclawMediaBrowserListener {
    fun onConnectResult(requestId: Int, connected: Boolean, rootId: String?, error: String?): Unit

    fun onBrowseResult(requestId: Int, childrenJson: String?, error: String?): Unit

    /** The service connection dropped after connecting (player crashed or was killed). */
    fun onDisconnected(): Unit
}
