package com.faceclaw.app;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.io.BufferedReader;
import java.io.IOException;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Streaming HTTP POST for the TypeScript side, used for server-sent-events
 * APIs (e.g. the Anthropic Messages API with stream=true). The response body
 * is delivered line by line as it arrives, so the JS side can parse SSE
 * events incrementally. Like FaceclawWebSocket, listener callbacks are posted
 * to the Looper of the thread that constructed this object.
 */
public class FaceclawSseRequest {
    private static final String TAG = "FaceclawSseRequest";
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private static volatile OkHttpClient sharedClient;

    private final Handler callbackHandler;
    private final Call call;
    private volatile boolean cancelled;

    /**
     * Starts the request immediately. headers is a flat alternating
     * [name, value, name, value, ...] array (okhttp Headers can't cross the
     * JS bridge, and parallel arrays are easy to build with Array.create).
     */
    public FaceclawSseRequest(String url, String jsonBody, String[] headers, final FaceclawSseListener listener) {
        if (url == null || url.trim().isEmpty()) {
            throw new IllegalArgumentException("url is required");
        }
        if (listener == null) {
            throw new IllegalArgumentException("listener is required");
        }
        Looper looper = Looper.myLooper();
        callbackHandler = new Handler(looper != null ? looper : Looper.getMainLooper());
        Request.Builder builder = new Request.Builder()
            .url(url.trim())
            .post(RequestBody.create(JSON, jsonBody == null ? "" : jsonBody));
        if (headers != null) {
            for (int i = 0; i + 1 < headers.length; i += 2) {
                if (headers[i] != null && !headers[i].isEmpty() && headers[i + 1] != null) {
                    builder.addHeader(headers[i], headers[i + 1]);
                }
            }
        }
        call = getClient().newCall(builder.build());
        call.enqueue(new Callback() {
            @Override public void onFailure(Call call, IOException e) {
                postFailure(listener, String.valueOf(e));
            }

            @Override public void onResponse(Call call, Response response) {
                try (ResponseBody body = response.body()) {
                    if (!response.isSuccessful()) {
                        final int code = response.code();
                        String errorBody = "";
                        try {
                            errorBody = body == null ? "" : body.string();
                        } catch (IOException e) {
                            Log.w(TAG, "error body read failed", e);
                        }
                        final String finalBody = errorBody;
                        post(() -> listener.onHttpError(code, finalBody));
                        return;
                    }
                    if (body == null) {
                        post(listener::onComplete);
                        return;
                    }
                    BufferedReader reader = new BufferedReader(body.charStream());
                    String line;
                    while ((line = reader.readLine()) != null) {
                        final String finalLine = line;
                        post(() -> listener.onLine(finalLine));
                    }
                    post(listener::onComplete);
                } catch (IOException e) {
                    postFailure(listener, String.valueOf(e));
                }
            }
        });
    }

    public void cancel() {
        cancelled = true;
        call.cancel();
    }

    private void post(Runnable runnable) {
        if (cancelled) {
            return;
        }
        callbackHandler.post(() -> {
            if (cancelled) {
                return;
            }
            try {
                runnable.run();
            } catch (Throwable t) {
                Log.w(TAG, "listener callback failed", t);
            }
        });
    }

    private void postFailure(FaceclawSseListener listener, String message) {
        if (cancelled) {
            return;
        }
        post(() -> listener.onFailure(message));
    }

    private static OkHttpClient getClient() {
        OkHttpClient client = sharedClient;
        if (client == null) {
            synchronized (FaceclawSseRequest.class) {
                if (sharedClient == null) {
                    // Streaming responses can pause between events (e.g. while
                    // the model thinks), so the read timeout is generous. The
                    // Anthropic API sends periodic ping events well within it.
                    sharedClient = new OkHttpClient.Builder()
                        .connectTimeout(15, TimeUnit.SECONDS)
                        .readTimeout(180, TimeUnit.SECONDS)
                        .addInterceptor(FaceclawHttp.userAgentInterceptor())
                        .build();
                }
                client = sharedClient;
            }
        }
        return client;
    }
}
