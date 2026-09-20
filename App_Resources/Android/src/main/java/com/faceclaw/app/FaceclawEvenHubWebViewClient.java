package com.faceclaw.app;

import android.os.Handler;
import android.os.Looper;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.net.Uri;
import android.util.Log;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

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
public class FaceclawEvenHubWebViewClient extends WebViewClient {
    private static final String TAG = "FaceclawEvenHub";

    private final String rootDir;
    private final String host;
    private final String injectScript;
    private final boolean injectOnPageStarted;
    private final FaceclawEvenHubListener listener;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    public FaceclawEvenHubWebViewClient(
            String rootDir,
            String host,
            String injectScript,
            boolean injectOnPageStarted,
            FaceclawEvenHubListener listener) {
        this.rootDir = rootDir;
        this.host = host;
        this.injectScript = injectScript;
        this.injectOnPageStarted = injectOnPageStarted;
        this.listener = listener;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        if (host == null || host.isEmpty()) {
            return null; // Remote app: everything comes from the network.
        }
        Uri url = request.getUrl();
        if (url == null || !host.equals(url.getHost())) {
            return null; // External hosts: normal network handling.
        }
        String path = url.getPath();
        if (path == null || path.isEmpty() || path.equals("/")) {
            path = "/index.html";
        }
        try {
            File root = new File(rootDir).getCanonicalFile();
            File target = new File(root, path.substring(1)).getCanonicalFile();
            if (!target.getPath().startsWith(root.getPath()) || !target.isFile()) {
                Log.w(TAG, "404 " + path);
                return new WebResourceResponse(
                        "text/plain", "utf-8",
                        new ByteArrayInputStream("not found".getBytes(StandardCharsets.UTF_8)));
            }
            String mime = mimeTypeFor(target.getName());
            if (mime.equals("text/html")) {
                return new WebResourceResponse(mime, "utf-8", new ByteArrayInputStream(injectIntoHtml(target)));
            }
            InputStream stream = new FileInputStream(target);
            return new WebResourceResponse(mime, null, stream);
        } catch (IOException e) {
            Log.e(TAG, "serve failed for " + path, e);
            return new WebResourceResponse(
                    "text/plain", "utf-8",
                    new ByteArrayInputStream("error".getBytes(StandardCharsets.UTF_8)));
        }
    }

    @Override
    public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
        super.onPageStarted(view, url, favicon);
        if (!injectOnPageStarted) return;
        // Best-effort: the document has committed but the parser has not run
        // the page's own scripts yet, so this usually lands first. Only used
        // when document-start scripts are unavailable.
        view.evaluateJavascript(injectScript, null);
    }

    @Override
    public void onPageFinished(WebView view, final String url) {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                listener.onPageFinished(url);
            }
        });
    }

    private byte[] injectIntoHtml(File file) throws IOException {
        byte[] raw = readAll(file);
        String html = new String(raw, StandardCharsets.UTF_8);
        String tag = "<script>" + injectScript + "</script>";
        // After <head...> if present, else before everything.
        int headIndex = indexOfIgnoreCase(html, "<head");
        if (headIndex >= 0) {
            int close = html.indexOf('>', headIndex);
            if (close >= 0) {
                return (html.substring(0, close + 1) + tag + html.substring(close + 1))
                        .getBytes(StandardCharsets.UTF_8);
            }
        }
        return (tag + html).getBytes(StandardCharsets.UTF_8);
    }

    private static int indexOfIgnoreCase(String haystack, String needle) {
        return haystack.toLowerCase(Locale.ROOT).indexOf(needle);
    }

    private static byte[] readAll(File file) throws IOException {
        FileInputStream in = new FileInputStream(file);
        try {
            byte[] data = new byte[(int) file.length()];
            int off = 0;
            while (off < data.length) {
                int n = in.read(data, off, data.length - off);
                if (n < 0) throw new IOException("short read: " + file);
                off += n;
            }
            return data;
        } finally {
            in.close();
        }
    }

    private static String mimeTypeFor(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".ico")) return "image/x-icon";
        if (lower.endsWith(".wasm")) return "application/wasm";
        if (lower.endsWith(".woff")) return "font/woff";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".ttf")) return "font/ttf";
        if (lower.endsWith(".txt") || lower.endsWith(".map")) return "text/plain";
        return "application/octet-stream";
    }
}
