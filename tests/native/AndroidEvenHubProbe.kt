package com.faceclaw.evenhubprobe

import android.app.Activity
import android.content.MutableContextWrapper
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebView
import com.faceclaw.app.FaceclawEvenHubChromeClient
import com.faceclaw.app.FaceclawEvenHubDocumentStart
import com.faceclaw.app.FaceclawEvenHubJsBridge
import com.faceclaw.app.FaceclawEvenHubListener
import com.faceclaw.app.FaceclawEvenHubProfile
import com.faceclaw.app.FaceclawEvenHubWebView
import com.faceclaw.app.FaceclawEvenHubWebViewClient
import com.faceclaw.app.FaceclawEvenHubWebViewHost
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Runs the production EvenHub WebView classes (tests/android-evenhub-native.cjs),
 * wired the way app/apps/evenhub/webview.ts wires them, and logs what the host saw.
 *
 * - A: a packaged app. It calls the bridge and gets a reply, embeds a same-origin
 *   and a cross-origin iframe, then navigates to a third-party page.
 * - B: another packaged app (its own profile), which then visits a cookie check.
 * - A2: a second WebView for A's package, which visits the same cookie check.
 * - R: a remote app, served by the test server, with the document-start shim.
 * - Then the shared renderer is crashed; the process must survive it.
 */
class ProbeActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private val seen = LinkedHashSet<String>()
    private val webViews = HashMap<String, WebView>()
    private val checks = HashMap<String, String>()
    private lateinit var config: JSONObject

    private fun asset(name: String) = assets.open(name).use { it.readBytes().decodeToString() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        config = JSONObject(asset("config.json"))
        val dist = File(filesDir, "dist").apply { mkdirs() }
        for (name in assets.list("dist")!!) File(dist, name).writeBytes(assets.open("dist/$name").use { it.readBytes() })
        val third = config.getString("third")
        handler.post { create("A", "probe.a", dist.path) }
        handler.postDelayed({ evaluate("A", "location.href = '$third/third'") }, 4000)
        handler.postDelayed({
            // A now shows the third-party page: host scripts must not run there.
            evaluate("A", "new Image().src = '$third/report?eval=leak'")
            create("B", "probe.b", dist.path)
        }, 6000)
        handler.postDelayed({ create("A2", "probe.a", dist.path); create("R", "probe.remote", null) }, 8000)
        handler.postDelayed({
            evaluate("B", "location.href = '$third/cookie?app=B'")
            evaluate("A2", "location.href = '$third/cookie?app=A2'")
        }, 10000)
        handler.postDelayed({ webViews["R"]?.loadUrl("chrome://crash") }, 13000)
        handler.postDelayed({
            Log.i(TAG, "RESULT " + JSONObject().put("seen", JSONArray(seen.toList())))
        }, 17000)
    }

    private fun create(tag: String, packageId: String, distDir: String?) {
        val startUrl = config.getJSONObject("start").getString(tag)
        checks[tag] = config.getJSONObject("checks").getString(tag)
        val web = FaceclawEvenHubWebView(MutableContextWrapper(this))
        seen.add("$tag:profile=${FaceclawEvenHubProfile.apply(web, packageId)}")
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = false
        val listener = object : FaceclawEvenHubListener {
            override fun onEvenAppMessage(handlerName: String?, argsJson: String?, callId: Int) {
                seen.add("$tag:" + JSONArray(argsJson ?: "[]").optString(0))
                evaluate(tag, "window.__fcResolve($callId, true, true)")
            }
            override fun onPageFinished(url: String?) {}
            override fun onRenderProcessGone(crashed: Boolean) {
                seen.add("$tag:gone")
                webViews.remove(tag)
            }
        }
        val rule = FaceclawEvenHubJsBridge.originRule(startUrl)!!
        FaceclawEvenHubJsBridge.install(web, rule, listener)?.let { seen.add("$tag:bridge-error") }
        val inject = asset("inject-$tag.js")
        val remote = distDir == null
        val documentStart = remote && FaceclawEvenHubDocumentStart.install(web, inject, rule)
        val host = if (remote) "" else android.net.Uri.parse(startUrl).host
        web.webViewClient = FaceclawEvenHubWebViewClient(distDir, host, inject, remote && !documentStart, listener)
        web.webChromeClient = FaceclawEvenHubChromeClient()
        FaceclawEvenHubWebViewHost.getInstance().attach(this, web, checks[tag]!!)
        webViews[tag] = web
        web.loadUrl(startUrl)
    }

    /** As webview.ts's evaluateJs: guarded to the app's origin. */
    private fun evaluate(tag: String, js: String) {
        webViews[tag]?.evaluateJavascript("if (${checks[tag]}) {\n$js\n}", null)
    }

    companion object {
        private const val TAG = "EHPROBE"
    }
}
