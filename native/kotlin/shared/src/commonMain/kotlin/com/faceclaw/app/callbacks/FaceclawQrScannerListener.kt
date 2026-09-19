package com.faceclaw.app

/** Callbacks for one FaceclawQrScanner.scan; exactly one method fires. */
interface FaceclawQrScannerListener {
    fun onResult(text: String?): Unit

    fun onCancelled(): Unit

    fun onError(message: String?): Unit
}
