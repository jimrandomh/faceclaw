package com.faceclaw.app;

import android.app.Activity;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;

import java.util.ArrayList;
import java.util.List;

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
 * prevent that: the WebViews are {@link FaceclawEvenHubWebView}, which lies to
 * Chromium about window visibility so the page never goes hidden; and each is
 * pinned to IMPORTANT renderer priority (not waived when not visible) with
 * timers/onResume asserted on attach. The main Looper keeps ticking under the
 * foreground service, so apps keep driving their glasses windows in the
 * background.
 */
public class FaceclawEvenHubWebViewHost {
    private static FaceclawEvenHubWebViewHost instance;

    /** How often the host fires the JS timer queue. 60Hz keeps games smooth. */
    private static final long TICK_MS = 16;

    private FrameLayout overlay;
    private boolean shown = false;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final List<WebView> webViews = new ArrayList<>();
    private boolean ticking = false;
    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            for (int i = 0; i < webViews.size(); i++) {
                webViews.get(i).evaluateJavascript(
                        "window.__fcTimerTick&&__fcTimerTick();window.__fcRafTick&&__fcRafTick()", null);
            }
            if (ticking) mainHandler.postDelayed(this, TICK_MS);
        }
    };

    public static synchronized FaceclawEvenHubWebViewHost getInstance() {
        if (instance == null) instance = new FaceclawEvenHubWebViewHost();
        return instance;
    }

    private FrameLayout ensureOverlay(Activity activity) {
        if (overlay != null) return overlay;
        ViewGroup content = activity.findViewById(android.R.id.content);
        overlay = new FrameLayout(activity);
        // index 0 = behind the NativeScript content view.
        content.addView(overlay, 0, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        return overlay;
    }

    /** Add a WebView to the host, full-size and rendering, hidden behind the UI. */
    public void attach(Activity activity, WebView web) {
        FrameLayout o = ensureOverlay(activity);
        web.setVisibility(View.VISIBLE);
        if (web.getParent() == null) {
            o.addView(web, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        // resumeTimers() is process-global; make sure nothing left timers paused.
        // onResume() undoes any per-WebView pause. Together with
        // FaceclawEvenHubWebView faking window visibility, this keeps the page
        // running JS while Faceclaw is backgrounded.
        web.resumeTimers();
        web.onResume();
        // Keep the renderer process at IMPORTANT priority even when the WebView
        // isn't visible (waivedWhenNotVisible=false), so Android doesn't
        // deprioritize/kill it in the background.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
        if (!webViews.contains(web)) webViews.add(web);
        if (!ticking) {
            ticking = true;
            mainHandler.postDelayed(ticker, TICK_MS);
        }
    }

    /** Bring an app's WebView to the front so it is visible on the phone. */
    public void showOnPhone(WebView web) {
        if (overlay == null) return;
        web.bringToFront();
        overlay.bringToFront();
        shown = true;
    }

    /** Send the overlay back behind the NativeScript UI. */
    public void hideOnPhone() {
        shown = false;
        if (overlay == null) return;
        ViewGroup content = (ViewGroup) overlay.getParent();
        if (content != null) {
            content.removeView(overlay);
            content.addView(overlay, 0);
        }
    }

    public boolean isShown() {
        return shown;
    }

    /** Remove and destroy a WebView (its app is closing). */
    public void detach(WebView web) {
        webViews.remove(web);
        if (webViews.isEmpty() && ticking) {
            ticking = false;
            mainHandler.removeCallbacks(ticker);
        }
        if (overlay != null) overlay.removeView(web);
        web.destroy();
    }
}
