package com.faceclaw.app

interface FaceclawKeyboardEventListener {
    /**
     * One CFW keyboard-bridge record (settings field 131) from the glasses: the raw
     * ['K','B',ver,kind,...] bytes, possibly one fragment of a longer record. Decoded and
     * reassembled on the TS side (app/g2/keyboard/protocol.ts). Delivered in arrival order.
     */
    fun onKeyboardEvent(body: ByteArray?): Unit
}
