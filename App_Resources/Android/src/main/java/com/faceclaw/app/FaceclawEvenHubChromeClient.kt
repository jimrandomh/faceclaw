package com.faceclaw.app

import android.net.Uri
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView

/** Host-owned Android document picker; not exposed to hosted app JavaScript. */
interface FaceclawEvenHubFileChooserListener {
    fun onShowFileChooser(
        webView: WebView,
        callback: ValueCallback<Array<Uri>>,
        params: WebChromeClient.FileChooserParams,
    ): Boolean
}

/**
 * Surfaces a hosted EvenHub app's console in logcat (tag FaceclawEvenHubConsole).
 * Native rather than a NativeScript-extended WebChromeClient: chatty apps log
 * many lines a second, and each one used to cost a Java->JS callback plus three
 * JS->Java calls back to read the message, all on the main thread.
 *
 * Standard file inputs cross into the TypeScript host only to launch Android's
 * Storage Access Framework picker. This adds no page/iframe bridge or origin
 * capability beyond the WebView's existing behavior.
 */
class FaceclawEvenHubChromeClient(
    private val fileChooserListener: FaceclawEvenHubFileChooserListener,
) : WebChromeClient() {
    override fun onConsoleMessage(message: ConsoleMessage): Boolean {
        Log.i(TAG, "${message.message()} (${message.sourceId()}:${message.lineNumber()})")
        return true
    }

    override fun onShowFileChooser(
        webView: WebView,
        filePathCallback: ValueCallback<Array<Uri>>,
        fileChooserParams: WebChromeClient.FileChooserParams,
    ): Boolean {
        return fileChooserListener.onShowFileChooser(webView, filePathCallback, fileChooserParams)
    }

    private companion object {
        const val TAG = "FaceclawEvenHubConsole"
    }
}
