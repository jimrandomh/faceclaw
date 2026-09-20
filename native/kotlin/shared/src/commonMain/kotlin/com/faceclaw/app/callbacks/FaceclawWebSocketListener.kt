package com.faceclaw.app

/** Callbacks for FaceclawWebSocket, delivered on the Android main thread. */
interface FaceclawWebSocketListener {
    fun onOpen(): Unit

    fun onTextMessage(message: String?): Unit

    fun onClosed(code: Int, reason: String?): Unit

    fun onFailure(message: String?): Unit
}
