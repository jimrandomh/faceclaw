package com.faceclaw.app;

import android.util.Log;
import android.webkit.WebView;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.util.Collections;
import java.util.Set;

/**
 * Injects the EvenHub bridge shim at document start into a WebView that loads
 * a page over the real network (the developer "Load app from URL" flow).
 *
 * Packaged apps get the shim spliced into the HTML they are served
 * (FaceclawEvenHubWebViewClient), which is not an option for a page fetched
 * from a live server. WebViewCompat.addDocumentStartJavaScript is the
 * supported way to run script before any page script, and unlike an
 * onPageStarted evaluateJavascript it is guaranteed to win the race — apps
 * poll for window.flutter_inappwebview with a few seconds' patience, but the
 * timer shim must be in place before the app captures setTimeout.
 *
 * Requires WebView 83+; the caller falls back to onPageStarted injection when
 * this returns false.
 */
public final class FaceclawEvenHubDocumentStart {
    private static final String TAG = "FaceclawEvenHub";

    private FaceclawEvenHubDocumentStart() {}

    /**
     * @param originRule an allowed-origin rule, e.g. "https://example.com" or "*".
     * @return whether the script was registered.
     */
    public static boolean install(WebView webView, String script, String originRule) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            Log.w(TAG, "document-start scripts unsupported; falling back to onPageStarted");
            return false;
        }
        try {
            Set<String> rules = Collections.singleton(originRule);
            WebViewCompat.addDocumentStartJavaScript(webView, script, rules);
            return true;
        } catch (Throwable error) {
            Log.w(TAG, "addDocumentStartJavaScript failed for " + originRule, error);
            return false;
        }
    }
}
