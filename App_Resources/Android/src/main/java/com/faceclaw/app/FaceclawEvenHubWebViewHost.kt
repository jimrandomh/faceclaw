package com.faceclaw.app

import android.app.Activity
import android.content.Context
import android.content.MutableContextWrapper
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

import java.util.ArrayList
import java.util.HashMap

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
 * Layout: the activity is edge-to-edge, so the overlay tracks the window
 * insets itself. A top bar (the shown app's name and a close button) sits
 * under the status bar, and the WebViews fill the area between it and the
 * navigation bar / keyboard. That area is the same whether or not the overlay
 * is shown, so showing an app doesn't resize (and re-lay-out) its page.
 *
 * Timer keep-alive: when the phone screen turns off, Chromium heavily throttles
 * the page's own setTimeout/setInterval (intensive background throttling clamps
 * them to ~1/sec), so timer-driven apps (e.g. snake's game loop) slow to a
 * crawl even though the renderer is still alive. Host-initiated
 * evaluateJavascript is NOT subject to that throttle, so we drive the app's
 * timers ourselves: a document-start shim replaces setTimeout/setInterval (and
 * requestAnimationFrame) with JS queues fired by window.__fcTick(), and this
 * host ticks those on the main thread regardless of screen state. The tick
 * returns when the page next has work, so an idle page isn't evaluated at
 * 60Hz; work scheduled between ticks wakes the host through
 * FaceclawEvenHubJsBridge.wakeTimers. The main Looper keeps running under the
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
 *
 * Activity recreation: this host outlives any one activity (it is a process
 * singleton, and apps keep running while the activity is destroyed and
 * recreated, e.g. after an app update or a config change). The overlay lives in
 * one activity's content view, so attach and showOnPhone first move it, with
 * every WebView in it, into the activity they are given if it isn't already
 * there; otherwise "show" would raise it in a dead window. WebViews are created
 * on a MutableContextWrapper whose base is re-pointed at the same time, so the
 * dialogs Chromium opens from the page (e.g. a <select>'s picker) use the live
 * activity too.
 */
class FaceclawEvenHubWebViewHost {
    private var overlay: FrameLayout? = null
    /** Holds the WebViews, inside [overlay] below the top bar. */
    private var stack: FrameLayout? = null
    private var titleView: TextView? = null
    private var overlayActivity: Activity? = null
    private var shown = false
    private var shownTitle = ""
    private var onClose: Runnable? = null

    private val mainHandler = Handler(Looper.getMainLooper())
    private val webViews: MutableList<WebView> = ArrayList()
    private val tickers: MutableMap<WebView, Ticker> = HashMap()

    /**
     * Drives one page's timer/rAF queues (window.__fcTick). Each tick's result
     * says when the page next has work; the ticker sleeps until then, or until
     * the page wakes it. It also re-ticks after IDLE_POLL_MS regardless, so a
     * lost evaluateJavascript callback (e.g. mid-navigation) or a page whose
     * wake didn't reach us stalls its timers for at most that long.
     */
    private inner class Ticker(private val web: WebView) : Runnable {
        private var inFlight = false
        private var wakePending = false
        private var stopped = false

        override fun run() {
            if (stopped) return
            inFlight = true
            web.evaluateJavascript(TICK_JS) { result -> onTicked(result) }
            schedule(IDLE_POLL_MS)
        }

        private fun onTicked(result: String?) {
            inFlight = false
            if (stopped) return
            // -1 (nothing pending) and null (shim not installed yet) both leave
            // only the idle poll; the page wakes us when it schedules work.
            val next = result?.toDoubleOrNull()?.toLong() ?: -1L
            val delay = when {
                wakePending -> 0L
                next < 0 -> IDLE_POLL_MS
                else -> next.coerceIn(TICK_MS, IDLE_POLL_MS)
            }
            wakePending = false
            schedule(delay)
        }

        fun wake() {
            if (stopped) return
            if (inFlight) wakePending = true else schedule(0)
        }

        fun stop() {
            stopped = true
            mainHandler.removeCallbacks(this)
        }

        private fun schedule(delayMs: Long) {
            mainHandler.removeCallbacks(this)
            mainHandler.postDelayed(this, delayMs)
        }
    }

    companion object {
        private var instance: FaceclawEvenHubWebViewHost? = null

        /** Shortest interval between ticks. 60Hz keeps games smooth. */
        private const val TICK_MS = 16L

        /** Longest a page goes without a tick, as a backstop for missed wakes. */
        private const val IDLE_POLL_MS = 1000L

        private const val TICK_JS = "window.__fcTick?__fcTick():null"

        /** Top bar height, below the status bar (Material toolbar height). */
        private const val BAR_HEIGHT_DP = 56f

        /** Matches the NativeScript ActionBar (NativeScriptToolbarStyle). */
        private val BAR_COLOR = Color.parseColor("#424242")

        @JvmStatic
        @Synchronized
        fun getInstance(): FaceclawEvenHubWebViewHost {
            if (instance == null) instance = FaceclawEvenHubWebViewHost()
            return instance!!
        }
    }

    /** The overlay, in [activity]'s content view (moved there, with its WebViews, if it was elsewhere). */
    private fun ensureOverlay(activity: Activity): FrameLayout {
        val existing = overlay
        if (existing != null && overlayActivity === activity && existing.parent != null) return existing
        val content = activity.findViewById<ViewGroup>(android.R.id.content)
        (existing?.parent as ViewGroup?)?.removeView(existing)
        val created = FrameLayout(activity)
        created.setBackgroundColor(Color.BLACK)
        val createdStack = FrameLayout(activity)
        created.addView(createdStack, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        val bar = buildTopBar(activity)
        created.addView(bar, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))
        for (web in webViews) {
            (web.parent as ViewGroup?)?.removeView(web)
            rebaseContext(web, activity)
            createdStack.addView(web, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        // Insets are passed on unconsumed: before API 30 a consuming child
        // would starve its later siblings (the NativeScript UI) of them.
        ViewCompat.setOnApplyWindowInsetsListener(created) { _, insets ->
            applyInsets(bar, createdStack, insets)
            insets
        }
        overlay = created
        stack = createdStack
        overlayActivity = activity
        // index 0 = behind the NativeScript content view (raised again below if shown).
        content.addView(created, 0, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        ViewCompat.requestApplyInsets(created)
        if (shown) created.bringToFront()
        return created
    }

    /** The bar across the top of a shown app: the app's name, then a close button. */
    private fun buildTopBar(activity: Activity): LinearLayout {
        val bar = LinearLayout(activity)
        bar.orientation = LinearLayout.HORIZONTAL
        bar.gravity = Gravity.CENTER_VERTICAL
        bar.setBackgroundColor(BAR_COLOR)
        // Swallow touches so they don't fall through to the WebViews.
        bar.isClickable = true

        val title = TextView(activity)
        title.text = shownTitle
        title.setTextColor(Color.WHITE)
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
        title.typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        title.maxLines = 1
        title.ellipsize = TextUtils.TruncateAt.END
        bar.addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
            marginStart = dp(activity, 16f)
            marginEnd = dp(activity, 12f)
        })

        val close = TextView(activity)
        close.text = "\u2715"
        close.setTextColor(Color.WHITE)
        close.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
        close.gravity = Gravity.CENTER
        close.contentDescription = "Close"
        val ripple = TypedValue()
        if (activity.theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, ripple, true)) {
            close.setBackgroundResource(ripple.resourceId)
        }
        close.setOnClickListener { onClose?.run() }
        val closeSize = dp(activity, 48f)
        bar.addView(close, LinearLayout.LayoutParams(closeSize, closeSize).apply {
            marginEnd = dp(activity, 4f)
        })
        titleView = title
        return bar
    }

    /**
     * Put the bar under the status bar (its background filling in behind it)
     * and the WebViews between the bar and the navigation bar or keyboard.
     */
    private fun applyInsets(bar: View, webStack: View, insets: WindowInsetsCompat) {
        val bars = insets.getInsets(
            WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
        val barHeight = dp(bar.context, BAR_HEIGHT_DP)
        bar.setPadding(bars.left, bars.top, bars.right, 0)
        bar.layoutParams = (bar.layoutParams as FrameLayout.LayoutParams).apply {
            height = bars.top + barHeight
        }
        webStack.layoutParams = (webStack.layoutParams as FrameLayout.LayoutParams).apply {
            setMargins(bars.left, bars.top + barHeight, bars.right, maxOf(bars.bottom, ime.bottom))
        }
    }

    private fun dp(context: Context, value: Float): Int {
        return TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, value, context.resources.displayMetrics).toInt()
    }

    private fun rebaseContext(web: WebView, activity: Activity) {
        (web.context as? MutableContextWrapper)?.baseContext = activity
    }

    /** Add a WebView to the host, full-size and rendering, hidden behind the UI. */
    fun attach(activity: Activity, web: WebView) {
        ensureOverlay(activity)
        rebaseContext(web, activity)
        web.visibility = View.VISIBLE
        if (web.parent == null) {
            stack!!.addView(web, FrameLayout.LayoutParams(
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
        if (!tickers.containsKey(web)) {
            val ticker = Ticker(web)
            tickers[web] = ticker
            mainHandler.postDelayed(ticker, TICK_MS)
        }
    }

    /**
     * A page scheduled a timer or animation frame due before its next tick.
     * Called from the JavaBridge thread; which page asked doesn't matter, as
     * an extra tick for another page is harmless.
     */
    fun wakeTimers() {
        mainHandler.post {
            for (ticker in tickers.values) ticker.wake()
        }
    }

    /**
     * Bring an app's WebView to the front of [activity] so it is visible on the
     * phone, titled [title]. The top bar's close button runs [onClose].
     */
    fun showOnPhone(activity: Activity?, web: WebView, title: String, onClose: Runnable) {
        val o = if (activity != null) ensureOverlay(activity) else overlay ?: return
        shownTitle = title
        this.onClose = onClose
        titleView?.text = title
        web.bringToFront()
        o.bringToFront()
        shown = true
    }

    /** Send the overlay back behind the NativeScript UI. */
    fun hideOnPhone() {
        shown = false
        onClose = null
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
        tickers.remove(web)?.stop()
        stack?.removeView(web)
        web.destroy()
    }
}
