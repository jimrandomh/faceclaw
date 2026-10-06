package com.faceclaw.app

import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient

/**
 * Surfaces a hosted EvenHub app's console in logcat (tag FaceclawEvenHubConsole).
 * Native rather than a NativeScript-extended WebChromeClient: chatty apps log
 * many lines a second, and each one used to cost a Java->JS callback plus three
 * JS->Java calls back to read the message, all on the main thread.
 */
class FaceclawEvenHubChromeClient : WebChromeClient() {
    override fun onConsoleMessage(message: ConsoleMessage): Boolean {
        Log.i(TAG, "${message.message()} (${message.sourceId()}:${message.lineNumber()})")
        return true
    }

    private companion object {
        const val TAG = "FaceclawEvenHubConsole"
    }
}
