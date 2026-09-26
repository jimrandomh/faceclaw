package com.faceclaw.app

/**
 * Callbacks from a hosted EvenHub app's WebView to the TypeScript host. All methods are delivered
 * on the Android main thread (NativeScript's JS thread), regardless of which WebView-internal
 * thread produced them.
 */
interface FaceclawEvenHubListener {
    /**
     * The app invoked window.flutter_inappwebview.callHandler(handlerName, ...args). argsJson is
     * the JSON-encoded argument array; callId identifies the promise to resolve via
     * window.__fcResolve(callId, ok, value).
     */
    fun onEvenAppMessage(handlerName: String?, argsJson: String?, callId: Int): Unit

    /** The WebView finished loading the app's page. */
    fun onPageFinished(url: String?): Unit
}
