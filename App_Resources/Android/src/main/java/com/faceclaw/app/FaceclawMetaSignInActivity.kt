package com.faceclaw.app

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlin.concurrent.thread

/**
 * The one-time Meta account sign-in a Neural Band claim needs (see MetaAuth). Nothing contacts
 * Meta until this opens. The person signs in on Meta's own page; this only catches the page's
 * final fb-viewapp:// redirect, finishes the token exchange natively and keeps the resulting
 * session sealed in the keystore (MetaSessionStore). No token reaches JavaScript or the log.
 *
 * The WebView runs in a throwaway profile, recreated on every sign-in, so Meta's cookies don't
 * persist or mix with any other WebView's. Where the WebView provider lacks profiles it falls
 * back to the shared default one.
 *
 * Finishes with RESULT_OK once a session is saved; FaceclawNeuralBand is told either way.
 */
class FaceclawMetaSignInActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private var webView: WebView? = null
    private lateinit var status: TextView
    private lateinit var hostLabel: TextView
    private var tokens: MetaSsoTokens? = null
    private var exchanging = false
    private var finished = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildLayout())
        begin()
    }

    override fun onDestroy() {
        finished = true
        main.removeCallbacksAndMessages(null)
        webView?.let {
            (it.parent as? ViewGroup)?.removeView(it)
            it.stopLoading()
            it.destroy()
        }
        webView = null
        FaceclawNeuralBand.metaSignInEnded()
        super.onDestroy()
    }

    @Deprecated("Activity.onBackPressed is deprecated on Android 13+, but still delivered without a callback registry")
    override fun onBackPressed() {
        val web = webView
        if (web != null && web.canGoBack() && !exchanging) {
            web.goBack()
            return
        }
        @Suppress("DEPRECATION")
        super.onBackPressed()
    }

    private fun dp(value: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

    private fun buildLayout(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(0x12, 0x12, 0x12))
        }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(8), dp(8), dp(8))
        }
        hostLabel = TextView(this).apply {
            text = "Sign in with Meta"
            setTextColor(Color.WHITE)
            setTypeface(typeface, Typeface.BOLD)
            textSize = 16f
            isSingleLine = true
        }
        bar.addView(hostLabel, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        bar.addView(Button(this).apply {
            text = "Cancel"
            setOnClickListener { finish() }
        })
        root.addView(bar)
        status = TextView(this).apply {
            setTextColor(Color.rgb(0xcc, 0xcc, 0xcc))
            textSize = 15f
            gravity = Gravity.CENTER
            setPadding(dp(24), dp(24), dp(24), dp(24))
        }
        root.addView(status, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        // Edge-to-edge (enforced from targetSdk 35): keep the bar below the status bar and the
        // page above the keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            insets
        }
        return root
    }

    private fun setStatus(text: String) {
        status.text = text
        status.visibility = if (text.isEmpty()) View.GONE else View.VISIBLE
    }

    /** Step 1, off the main thread; then the WebView. */
    private fun begin() {
        setStatus("Opening Meta's sign-in page…")
        thread(name = "meta-signin") {
            try {
                val next = MetaAuth.tokensQuery()
                main.post {
                    if (finished) return@post
                    tokens = next
                    showWebView(MetaAuth.authEntryUrl(next))
                }
            } catch (e: Exception) {
                Log.w(TAG, "tokens query failed: ${e.javaClass.simpleName}: ${e.message}")
                main.post { if (!finished) setStatus(e.message ?: "Couldn't reach Meta. Check the connection and try again.") }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showWebView(url: String) {
        val web = WebView(this)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            // A fresh profile per sign-in: drop the last one (no WebView uses it any more).
            val store = ProfileStore.getInstance()
            runCatching { store.deleteProfile(PROFILE) }
            store.getOrCreateProfile(PROFILE)
            WebViewCompat.setProfile(web, PROFILE)
        } else {
            Log.w(TAG, "multi-profile WebView unsupported; the Meta sign-in uses the default profile")
        }
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        // Meta's login hops between its own sites (auth.meta.com, meta.com, facebook.com), which
        // needs their cookies in each other's frames. React Native's WebView, which the reference
        // implementation signs in with, accepts third-party cookies by default; Android's doesn't.
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.isForMainFrame) Log.i(TAG, "navigate ${describe(request.url)}${if (request.isRedirect) " (redirect)" else ""}")
                return intercept(request.url)
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                val uri = url?.let { runCatching { Uri.parse(it) }.getOrNull() } ?: return
                Log.i(TAG, "page ${describe(uri)}")
                // A navigation that shouldOverrideUrlLoading never saw (a POST's redirect) still
                // has to end the sign-in here.
                if (MetaAuth.isLoginCallback(uri.toString())) {
                    view.stopLoading()
                    intercept(uri)
                    return
                }
                uri.host?.let { hostLabel.text = it }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                Log.w(TAG, "load failed (${error.errorCode}) at ${describe(request.url)}")
                // An unhandled fb-viewapp:// redirect fails as an unknown scheme: it's still the callback.
                if (MetaAuth.isLoginCallback(request.url.toString())) intercept(request.url)
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (!request.isForMainFrame) return
                val where = describe(request.url)
                Log.w(TAG, "HTTP ${response.statusCode} at $where")
                if (!exchanging) setStatus("Meta's page failed (HTTP ${response.statusCode} at $where). Go back or cancel and try again.")
            }
        }
        webView = web
        setStatus("")
        (status.parent as ViewGroup).addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        web.loadUrl(url)
    }

    /**
     * The login ends with a custom-scheme redirect carrying the validated token and the
     * encrypted blob. Only https pages load in between.
     */
    private fun intercept(uri: Uri): Boolean {
        val url = uri.toString()
        if (MetaAuth.isLoginCallback(url)) {
            val tokens = tokens
            if (tokens != null && !exchanging) {
                val (token, blob) = MetaAuth.callbackQuery(url)
                val matches = MetaAuth.callbackMatches(token, tokens.nativeSsoToken)
                Log.i(TAG, "login callback: blob ${if (blob == null) "missing" else "present"}, token ${if (matches) "matches" else "doesn't match"}")
                if (blob != null && matches) {
                    complete(blob, tokens.nativeSsoToken)
                } else {
                    setStatus("Meta didn't confirm this sign-in. Try again.")
                }
            }
            return true
        }
        return !(url.startsWith("https://") || url == "about:blank")
    }

    private fun complete(blob: String, requestToken: String) {
        exchanging = true
        webView?.visibility = View.GONE
        setStatus("Finishing the sign-in…")
        thread(name = "meta-signin") {
            try {
                val frl = MetaAuth.decryptBlob(blob, requestToken)
                val session = MetaAuth.login(frl)
                if (!MetaSessionStore(applicationContext).saveSession(session)) {
                    throw MetaAuthError("Couldn't store the Meta session on this phone.")
                }
                Log.i(TAG, "Meta sign-in complete")
                main.post {
                    if (finished) return@post
                    setResult(RESULT_OK)
                    finish()
                }
            } catch (e: Exception) {
                // The messages carry HTTP status and Meta's error codes, never tokens.
                Log.w(TAG, "Meta sign-in exchange failed: ${e.javaClass.simpleName}: ${e.message}")
                main.post {
                    if (finished) return@post
                    exchanging = false
                    webView?.visibility = View.VISIBLE
                    setStatus(e.message ?: "The Meta sign-in failed. Try again.")
                }
            }
        }
    }

    companion object {
        private const val TAG = "FaceclawMetaSignIn"
        private const val PROFILE = "meta-signin"

        /** Scheme, host and path only: queries and fragments can carry tokens, so they're never logged. */
        private fun describe(uri: Uri): String = "${uri.scheme}://${uri.host ?: ""}${uri.path ?: ""}"
    }
}
