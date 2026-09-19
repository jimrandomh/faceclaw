package com.faceclaw.app;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * Thin okhttp WebSocket wrapper for the TypeScript side. Sends text frames
 * (JSON protocols) and binary frames (raw audio for Soniox). Listener callbacks are
 * posted to the Looper of the thread that constructed this object, so a JS
 * isolate (main thread or app worker) always receives them on its own
 * thread; a Looper-less constructing thread falls back to the main thread.
 */
public class FaceclawWebSocket {
    private static final String TAG = "FaceclawWebSocket";
    private static volatile OkHttpClient sharedClient;

    private final Handler callbackHandler;
    private final WebSocket socket;
    private volatile boolean closeRequested;

    // Single constructor (no overloads) so NativeScript constructor resolution
    // can never pick a variant that drops the auth header; callers with no
    // header pass null/null.
    public FaceclawWebSocket(String url, final FaceclawWebSocketListener listener, String headerName, String headerValue) {
        if (url == null || url.trim().isEmpty()) {
            throw new IllegalArgumentException("url is required");
        }
        if (listener == null) {
            throw new IllegalArgumentException("listener is required");
        }
        Looper looper = Looper.myLooper();
        callbackHandler = new Handler(looper != null ? looper : Looper.getMainLooper());
        Request.Builder builder = new Request.Builder().url(url.trim());
        if (headerName != null && !headerName.isEmpty() && headerValue != null) {
            builder.addHeader(headerName, headerValue);
        }
        Request request = builder.build();
        // Redacted diagnostics: confirm the auth header is actually present on
        // the handshake and carries a plausible value (not empty/truncated).
        StringBuilder headerLog = new StringBuilder();
        for (String name : request.headers().names()) {
            String value = request.header(name);
            headerLog.append(name).append('=').append(redact(value)).append(' ');
        }
        Log.i(TAG, "ws connect host=" + request.url().host() + request.url().encodedPath()
                + " headers=[" + headerLog.toString().trim() + "]");
        socket = getClient().newWebSocket(request, new WebSocketListener() {
            @Override public void onOpen(WebSocket webSocket, Response response) {
                callbackHandler.post(() -> {
                    try {
                        listener.onOpen();
                    } catch (Throwable t) {
                        Log.w(TAG, "listener onOpen failed", t);
                    }
                });
            }

            @Override public void onMessage(WebSocket webSocket, String text) {
                callbackHandler.post(() -> {
                    try {
                        listener.onTextMessage(text);
                    } catch (Throwable t) {
                        Log.w(TAG, "listener onTextMessage failed", t);
                    }
                });
            }

            @Override public void onClosing(WebSocket webSocket, int code, String reason) {
                webSocket.close(code, reason);
            }

            @Override public void onClosed(WebSocket webSocket, int code, String reason) {
                callbackHandler.post(() -> {
                    try {
                        listener.onClosed(code, reason == null ? "" : reason);
                    } catch (Throwable t) {
                        Log.w(TAG, "listener onClosed failed", t);
                    }
                });
            }

            @Override public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                if (closeRequested) {
                    return;
                }
                final String message = t == null ? "unknown websocket failure" : String.valueOf(t);
                callbackHandler.post(() -> {
                    try {
                        listener.onFailure(message);
                    } catch (Throwable inner) {
                        Log.w(TAG, "listener onFailure failed", inner);
                    }
                });
            }
        });
    }

    private static OkHttpClient getClient() {
        OkHttpClient client = sharedClient;
        if (client == null) {
            synchronized (FaceclawWebSocket.class) {
                if (sharedClient == null) {
                    sharedClient = new OkHttpClient.Builder()
                        .pingInterval(20, TimeUnit.SECONDS)
                        .addInterceptor(FaceclawHttp.userAgentInterceptor())
                        .build();
                }
                client = sharedClient;
            }
        }
        return client;
    }

    private static String redact(String value) {
        if (value == null) {
            return "null";
        }
        int len = value.length();
        String prefix = value.substring(0, Math.min(4, len));
        return "len" + len + ":" + prefix + "...";
    }

    public boolean sendText(String message) {
        return socket.send(message == null ? "" : message);
    }

    public boolean sendBinary(byte[] bytes) {
        return socket.send(ByteString.of(bytes == null ? new byte[0] : bytes));
    }

    public void close(int code, String reason) {
        closeRequested = true;
        try {
            if (!socket.close(code, reason)) {
                socket.cancel();
            }
        } catch (Throwable t) {
            socket.cancel();
        }
    }
}
