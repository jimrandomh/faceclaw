package com.faceclaw.app

import android.os.Handler
import android.os.Looper
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.net.Uri
import android.util.Log

import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.util.Locale

/**
 * Serves an unpacked EvenHub app's files to its WebView from a fake per-app
 * https origin, entirely offline. HTML responses get the host bridge shim
 * injected at the top of the document, guaranteeing
 * window.flutter_inappwebview exists before any app JS runs (apps race
 * waitForEvenAppBridge against 4-6s timeouts and silently fall back to demo
 * modes if the handler appears late).
 *
 * shouldInterceptRequest runs on a WebView-internal thread; it only touches
 * files, never the NativeScript runtime. Requests to other hosts fall
 * through to the network (the manifest whitelist is not yet enforced).
 *
 * A developer-loaded app ("Load app from URL") has no local root: host is
 * empty, nothing is intercepted, and the page loads normally from its server.
 * The shim is registered as a document-start script instead
 * (FaceclawEvenHubDocumentStart); injectOnPageStarted is the fallback for
 * WebView versions that lack that API.
 */
class FaceclawEvenHubWebViewClient(
    private val rootDir: String?,
    private val host: String?,
    private val injectScript: String,
    private val injectOnPageStarted: Boolean,
    private val listener: FaceclawEvenHubListener
) : WebViewClient() {
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        if (host == null || host.isEmpty()) {
            return null // Remote app: everything comes from the network.
        }
        val url: Uri? = request.url
        if (url == null || host != url.host) {
            return null // External hosts: normal network handling.
        }
        var path = url.path
        if (path == null || path.isEmpty() || path == "/") {
            path = "/index.html"
        }
        try {
            val root = File(rootDir).canonicalFile
            val target = File(root, path.substring(1)).canonicalFile
            if (!target.path.startsWith(root.path) || !target.isFile) {
                Log.w(TAG, "404 $path")
                return WebResourceResponse(
                    "text/plain", "utf-8",
                    ByteArrayInputStream("not found".toByteArray(StandardCharsets.UTF_8)))
            }
            val mime = mimeTypeFor(target.name)
            if (mime == "text/html") {
                return WebResourceResponse(mime, "utf-8", ByteArrayInputStream(injectIntoHtml(target)))
            }
            val stream: InputStream = FileInputStream(target)
            return WebResourceResponse(mime, null, stream)
        } catch (e: IOException) {
            Log.e(TAG, "serve failed for $path", e)
            return WebResourceResponse(
                "text/plain", "utf-8",
                ByteArrayInputStream("error".toByteArray(StandardCharsets.UTF_8)))
        }
    }

    override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
        super.onPageStarted(view, url, favicon)
        if (!injectOnPageStarted) return
        // Best-effort: the document has committed but the parser has not run
        // the page's own scripts yet, so this usually lands first. Only used
        // when document-start scripts are unavailable.
        view.evaluateJavascript(injectScript, null)
    }

    override fun onPageFinished(view: WebView, url: String?) {
        mainHandler.post {
            listener.onPageFinished(url)
        }
    }

    @Throws(IOException::class)
    private fun injectIntoHtml(file: File): ByteArray {
        val raw = readAll(file)
        val html = String(raw, StandardCharsets.UTF_8)
        val tag = "<script>$injectScript</script>"
        // After <head...> if present, else before everything.
        val headIndex = indexOfIgnoreCase(html, "<head")
        if (headIndex >= 0) {
            val close = html.indexOf('>', headIndex)
            if (close >= 0) {
                return (html.substring(0, close + 1) + tag + html.substring(close + 1))
                    .toByteArray(StandardCharsets.UTF_8)
            }
        }
        return (tag + html).toByteArray(StandardCharsets.UTF_8)
    }

    companion object {
        private const val TAG = "FaceclawEvenHub"

        private fun indexOfIgnoreCase(haystack: String, needle: String): Int {
            return haystack.lowercase(Locale.ROOT).indexOf(needle)
        }

        @Throws(IOException::class)
        private fun readAll(file: File): ByteArray {
            val input = FileInputStream(file)
            try {
                val data = ByteArray(file.length().toInt())
                var off = 0
                while (off < data.size) {
                    val n = input.read(data, off, data.size - off)
                    if (n < 0) throw IOException("short read: $file")
                    off += n
                }
                return data
            } finally {
                input.close()
            }
        }

        private fun mimeTypeFor(name: String): String {
            val lower = name.lowercase(Locale.ROOT)
            if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html"
            if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript"
            if (lower.endsWith(".css")) return "text/css"
            if (lower.endsWith(".json")) return "application/json"
            if (lower.endsWith(".png")) return "image/png"
            if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
            if (lower.endsWith(".gif")) return "image/gif"
            if (lower.endsWith(".svg")) return "image/svg+xml"
            if (lower.endsWith(".webp")) return "image/webp"
            if (lower.endsWith(".ico")) return "image/x-icon"
            if (lower.endsWith(".wasm")) return "application/wasm"
            if (lower.endsWith(".woff")) return "font/woff"
            if (lower.endsWith(".woff2")) return "font/woff2"
            if (lower.endsWith(".ttf")) return "font/ttf"
            if (lower.endsWith(".txt") || lower.endsWith(".map")) return "text/plain"
            return "application/octet-stream"
        }
    }
}
