package com.faceclaw.app;

import java.io.IOException;

import okhttp3.Interceptor;
import okhttp3.Request;
import okhttp3.Response;

/**
 * Shared HTTP identity for the Java networking helpers. The version lives in
 * app/version.ts, so the TypeScript side pushes the real string in at startup
 * (see installNativeUserAgent in app/util/http.ts); the default below is only
 * a fallback for requests that somehow beat that call.
 */
public final class FaceclawHttp {
    private static volatile String userAgent = "Faceclaw";

    private FaceclawHttp() {}

    public static void setUserAgent(String value) {
        if (value != null && !value.trim().isEmpty()) {
            userAgent = value.trim();
        }
    }

    public static String getUserAgent() {
        return userAgent;
    }

    /** Stamps our User-Agent on any request that doesn't already carry one. */
    public static Interceptor userAgentInterceptor() {
        return new Interceptor() {
            @Override public Response intercept(Chain chain) throws IOException {
                Request request = chain.request();
                if (request.header("User-Agent") != null) {
                    return chain.proceed(request);
                }
                return chain.proceed(request.newBuilder().header("User-Agent", userAgent).build());
            }
        };
    }
}
