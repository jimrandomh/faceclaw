package com.faceclaw.app

import android.app.Activity
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout

import java.util.ArrayList

/**
 * Keeps EvenHub app WebViews alive and rendering while the phone shows the
 * Faceclaw dashboard instead of the app.
 *
 * The problem: an EvenHub app only paints (canvas / requestAnimationFrame) and
 * runs un-throttled timers while its WebView is attached to the window and
 * VISIBLE. Faceclaw is glasses-first — the phone normally shows its own UI, not
 * the app — so the app's WebView must render off-screen.
 *
 * The trick: a single full-screen overlay FrameLayout is inserted as the FIRST
 * child of the activity's content view, i.e. BEHIND the NativeScript UI. Every
 * app WebView lives in it, full-size and VISIBLE, but occluded by the opaque
 * dashboard on top. Chromium doesn't stop rendering a view merely because a
 * sibling covers it (only VISIBILITY flags / detachment / zero-size do that),
 * so the apps keep driving their glasses windows while unseen. Touches go to
 * the NativeScript UI on top.
 *
 * To show one app's UI on the phone, the overlay is raised to the front (and
 * the chosen WebView to the top of the overlay); hiding sends it back behind.
 * All view work happens on the main thread (callers are on the NS/JS thread).
 *
 * Timer keep-alive: when the phone screen turns off, Chromium heavily throttles
 * the page's own setTimeout/setInterval (intensive background throttling clamps
 * them to ~1/sec), so timer-driven apps (e.g. snake's game loop) slow to a
 * crawl even though the renderer is still alive. Host-initiated
 * evaluateJavascript is NOT subject to that throttle, so we drive the app's
 * timers ourselves: a document-start shim replaces setTimeout/setInterval (and
 * requestAnimationFrame) with JS queues fired by window.__fcTimerTick() /
 * __fcRafTick(), and this host ticks those on the main thread at a fixed rate
 * regardless of screen state. The main Looper keeps running under the
 * foreground service, so the tick survives the screen turning off. (Matches the
 * official Even app's approach.)
 *
 * Background keep-alive: the occluded-overlay trick only works while the
 * activity is foreground. When Faceclaw itself is backgrounded, the window goes
 * invisible and Chromium freezes the renderer — the timer/rAF ticks and pushed
 * input events then queue up and only run once foregrounded again. Two things
 * prevent that: the WebViews are [FaceclawEvenHubWebView], which lies to
 * Chromium about window visibility so the page never goes hidden; and each is
 * pinned to IMPORTANT renderer priority (not waived when not visible) with
 * timers/onResume asserted on attach. The main Looper keeps ticking under the
 * foreground service, so apps keep driving their glasses windows in the
 * background.
 */
class FaceclawEvenHubWebViewHost {
    private var overlay: FrameLayout? = null
    private var shown = false

    private val mainHandler = Handler(Looper.getMainLooper())
    private val webViews: MutableList<WebView> = ArrayList()
    private var ticking = false
    private val ticker: Runnable = object : Runnable {
        override fun run() {
            for (i in 0 until webViews.size) {
                webViews[i].evaluateJavascript(
                    "window.__fcTimerTick&&__fcTimerTick();window.__fcRafTick&&__fcRafTick()", null)
            }
            if (ticking) mainHandler.postDelayed(this, TICK_MS)
        }
    }

    companion object {
        private var instance: FaceclawEvenHubWebViewHost? = null

        /** How often the host fires the JS timer queue. 60Hz keeps games smooth. */
        private const val TICK_MS = 16L

        @JvmStatic
        @Synchronized
        fun getInstance(): FaceclawEvenHubWebViewHost {
            if (instance == null) instance = FaceclawEvenHubWebViewHost()
            return instance!!
        }
    }

    private fun ensureOverlay(activity: Activity): FrameLayout {
        overlay?.let { return it }
        val content = activity.findViewById<ViewGroup>(android.R.id.content)
        val created = FrameLayout(activity)
        overlay = created
        // index 0 = behind the NativeScript content view.
        content.addView(created, 0, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        return created
    }

    /** Add a WebView to the host, full-size and rendering, hidden behind the UI. */
    fun attach(activity: Activity, web: WebView) {
        val o = ensureOverlay(activity)
        web.visibility = View.VISIBLE
        if (web.parent == null) {
            o.addView(web, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        // resumeTimers() is process-global; make sure nothing left timers paused.
        // onResume() undoes any per-WebView pause. Together with
        // FaceclawEvenHubWebView faking window visibility, this keeps the page
        // running JS while Faceclaw is backgrounded.
        web.resumeTimers()
        web.onResume()
        // Keep the renderer process at IMPORTANT priority even when the WebView
        // isn't visible (waivedWhenNotVisible=false), so Android doesn't
        // deprioritize/kill it in the background.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        }
        if (!webViews.contains(web)) webViews.add(web)
        if (!ticking) {
            ticking = true
            mainHandler.postDelayed(ticker, TICK_MS)
        }
    }

    /** Bring an app's WebView to the front so it is visible on the phone. */
    fun showOnPhone(web: WebView) {
        val o = overlay ?: return
        web.bringToFront()
        o.bringToFront()
        shown = true
    }

    /** Send the overlay back behind the NativeScript UI. */
    fun hideOnPhone() {
        shown = false
        val o = overlay ?: return
        val content = o.parent as ViewGroup?
        if (content != null) {
            content.removeView(o)
            content.addView(o, 0)
        }
    }

    fun isShown(): Boolean {
        return shown
    }

    /** Remove and destroy a WebView (its app is closing). */
    fun detach(web: WebView) {
        webViews.remove(web)
        if (webViews.isEmpty() && ticking) {
            ticking = false
            mainHandler.removeCallbacks(ticker)
        }
        overlay?.removeView(web)
        web.destroy()
    }
}
