package com.faceclaw.app;

import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;

/**
 * The object injected into a hosted EvenHub app's WebView as
 * window.__faceclawEvenHub. The document-start shim (served inline by
 * FaceclawEvenHubWebViewClient) wraps it in a promise-returning
 * window.flutter_inappwebview.callHandler, which is what the EvenHub SDK
 * actually talks to.
 *
 * JavascriptInterface methods run on a WebView-internal thread; everything
 * is bounced to the main thread before touching the NativeScript listener.
 */
public class FaceclawEvenHubJsBridge {
    private final FaceclawEvenHubListener listener;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    public FaceclawEvenHubJsBridge(FaceclawEvenHubListener listener) {
        this.listener = listener;
    }

    @JavascriptInterface
    public void postMessage(final String handlerName, final String argsJson, final int callId) {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                listener.onEvenAppMessage(handlerName, argsJson, callId);
            }
        });
    }
}
