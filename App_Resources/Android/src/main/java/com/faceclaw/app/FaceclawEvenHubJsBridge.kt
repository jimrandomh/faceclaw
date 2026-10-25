package com.faceclaw.app

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

import org.json.JSONArray
import org.json.JSONException

/**
 * The host end of a hosted EvenHub app's bridge: window.__faceclawEvenHubPort,
 * a WebMessageListener object that WebView injects only into frames from the
 * app's own origin. Sites the app navigates to, and other-origin iframes it
 * embeds, never see it, and messages from the app's own subframes are dropped,
 * so only the app's main document reaches the host (its SDK storage, sensors,
 * glasses display and the Faceclaw extensions, API keys included). This
 * replaced an addJavascriptInterface object, which WebView exposes to every
 * frame of every page.
 *
 * The transport script (webview.ts) wraps the port as window.__faceclawEvenHub,
 * whose postMessage(name, argsJson, id) and wakeTimers() the stock bridge shim
 * and the extensions call. Messages are JSON arrays: ["call", name, argsJson,
 * id] or ["wake"].
 */
class FaceclawEvenHubJsBridge private constructor(
    private val listener: FaceclawEvenHubListener
) : WebViewCompat.WebMessageListener {
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onPostMessage(
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy
    ) {
        if (!isMainFrame) return
        val parts = try {
            JSONArray(message.data ?: return)
        } catch (e: JSONException) {
            return
        }
        when (parts.optString(0)) {
            "call" -> {
                val name = parts.optString(1)
                val argsJson = parts.optString(2)
                val callId = parts.optInt(3)
                mainHandler.post { listener.onEvenAppMessage(name, argsJson, callId) }
            }
            // The page's timer shim has work due before the host's next tick.
            "wake" -> FaceclawEvenHubWebViewHost.getInstance().wakeTimers()
        }
    }

    companion object {
        private const val TAG = "FaceclawEvenHub"
        private const val OBJECT_NAME = "__faceclawEvenHubPort"

        /**
         * The origin rule matching exactly [url]'s origin (default port elided),
         * or null when it isn't an http(s) URL with a host.
         */
        @JvmStatic
        fun originRule(url: String): String? {
            val uri = Uri.parse(url)
            val scheme = uri.scheme?.lowercase()
            val host = uri.host?.lowercase()
            if ((scheme != "http" && scheme != "https") || host.isNullOrEmpty()) return null
            val defaultPort = if (scheme == "https") 443 else 80
            return if (uri.port == -1 || uri.port == defaultPort) "$scheme://$host" else "$scheme://$host:${uri.port}"
        }

        /**
         * Expose the bridge to [webView]'s frames from [originRule]. Must run
         * before the WebView loads anything.
         *
         * @return null on success, else why the bridge could not be installed.
         */
        @JvmStatic
        fun install(webView: WebView, originRule: String, listener: FaceclawEvenHubListener): String? {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                Log.w(TAG, "WebMessageListener unsupported; not exposing the EvenHub bridge")
                return "This Android System WebView is too old to run EvenHub apps safely. Update it, then reopen the app."
            }
            return try {
                WebViewCompat.addWebMessageListener(webView, OBJECT_NAME, setOf(originRule), FaceclawEvenHubJsBridge(listener))
                null
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "bridge origin rule rejected: $originRule", e)
                "The app's address ($originRule) can't be used as a web origin."
            }
        }
    }
}
