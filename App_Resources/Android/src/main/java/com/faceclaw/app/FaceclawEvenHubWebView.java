package com.faceclaw.app;

import android.content.Context;
import android.view.View;
import android.webkit.WebView;

/**
 * A WebView for hosting an EvenHub app that keeps rendering and running JS even
 * when the whole Faceclaw activity is backgrounded (phone on the home screen or
 * another app).
 *
 * The problem: Chromium ties a WebView's page-visibility to its window's
 * visibility. When the host activity stops, every view gets
 * onWindowVisibilityChanged(GONE); Chromium then marks the page hidden and
 * freezes/throttles the renderer. A frozen renderer doesn't execute
 * evaluateJavascript, so the host timer/rAF ticks AND pushed input events queue
 * up and only run once the app is foregrounded again — exactly the "Hub apps
 * freeze in the background" symptom (also seen in early official-app versions).
 *
 * The occluded-overlay trick in FaceclawEvenHubWebViewHost keeps the VIEW
 * visible while the activity is foreground, but can't help once the WINDOW goes
 * away. So we lie about window visibility: this WebView always tells Chromium
 * the window is VISIBLE, so the page never goes hidden and the renderer keeps
 * running in the background. We drive the glasses over BLE from the foreground
 * service regardless of the phone's screen, so "always rendering" is what we
 * actually want; there is no on-phone cost while the app is unseen.
 */
public class FaceclawEvenHubWebView extends WebView {

    public FaceclawEvenHubWebView(Context context) {
        super(context);
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        // Never propagate a hidden window: keep Chromium's page-visibility
        // "visible" so the renderer isn't frozen when Faceclaw backgrounds.
        super.onWindowVisibilityChanged(View.VISIBLE);
    }
}
