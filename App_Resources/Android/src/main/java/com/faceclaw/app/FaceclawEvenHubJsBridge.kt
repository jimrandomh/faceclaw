package com.faceclaw.app

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface

/**
 * The object injected into a hosted EvenHub app's WebView as
 * window.__faceclawEvenHub. The document-start shim (served inline by
 * FaceclawEvenHubWebViewClient) wraps it in a promise-returning
 * window.flutter_inappwebview.callHandler, which is what the EvenHub SDK
 * actually talks to.
 *
 * JavascriptInterface methods run on a WebView-internal thread; everything
 * is bounced to the main thread before touching the NativeScript listener.
 */
class FaceclawEvenHubJsBridge(private val listener: FaceclawEvenHubListener) {
    private val mainHandler = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun postMessage(handlerName: String?, argsJson: String?, callId: Int) {
        mainHandler.post {
            listener.onEvenAppMessage(handlerName, argsJson, callId)
        }
    }
}
