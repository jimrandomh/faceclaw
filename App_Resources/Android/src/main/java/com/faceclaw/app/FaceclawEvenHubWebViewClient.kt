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
        val path = url.path
        try {
            // Path rules, MIME table and shim injection are shared (EvenHubAssetServer);
            // the canonical-file check below additionally defeats symlinks.
            val asset = EvenHubAssetServer.resolve(path)
            val root = File(rootDir).canonicalFile
            val target = asset?.let { File(root, it.relativePath).canonicalFile }
            if (asset == null || target == null || !EvenHubAssetServer.isInsideRoot(root.path, target.path) || !target.isFile) {
                Log.w(TAG, "404 $path")
                return WebResourceResponse(
                    "text/plain", "utf-8",
                    ByteArrayInputStream("not found".toByteArray(StandardCharsets.UTF_8)))
            }
            if (asset.isHtml) {
                val html = EvenHubAssetServer.injectIntoHtml(String(readAll(target), StandardCharsets.UTF_8), injectScript)
                return WebResourceResponse(asset.mime, "utf-8", ByteArrayInputStream(html.toByteArray(StandardCharsets.UTF_8)))
            }
            val stream: InputStream = FileInputStream(target)
            return WebResourceResponse(asset.mime, null, stream)
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

    companion object {
        private const val TAG = "FaceclawEvenHub"

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
    }
}
