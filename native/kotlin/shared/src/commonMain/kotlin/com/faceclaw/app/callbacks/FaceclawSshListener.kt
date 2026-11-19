package com.faceclaw.app

/**
 * Events from FaceclawSshChannel, delivered on the thread that opened the
 * channel. See native/ssh/faceclawssh.go (Listener) for the kinds and payloads.
 */
interface FaceclawSshListener {
    fun onEvent(kind: String?, payload: String?): Unit
}
