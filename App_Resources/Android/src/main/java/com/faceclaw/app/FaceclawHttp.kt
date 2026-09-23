package com.faceclaw.app

import java.io.IOException

import okhttp3.Interceptor
import okhttp3.Request
import okhttp3.Response

/**
 * Shared HTTP identity for the Java networking helpers. The version lives in
 * app/version.ts, so the TypeScript side pushes the real string in at startup
 * (see installNativeUserAgent in app/util/http.ts); the default below is only
 * a fallback for requests that somehow beat that call.
 */
class FaceclawHttp private constructor() {
    companion object {
        @Volatile
        private var userAgent = "Faceclaw"

        @JvmStatic
        fun setUserAgent(value: String?) {
            if (value != null && !value.trim().isEmpty()) {
                userAgent = value.trim()
            }
        }

        @JvmStatic
        fun getUserAgent(): String {
            return userAgent
        }

        /** Stamps our User-Agent on any request that doesn't already carry one. */
        @JvmStatic
        fun userAgentInterceptor(): Interceptor {
            return object : Interceptor {
                @Throws(IOException::class)
                override fun intercept(chain: Interceptor.Chain): Response {
                    val request: Request = chain.request()
                    if (request.header("User-Agent") != null) {
                        return chain.proceed(request)
                    }
                    return chain.proceed(request.newBuilder().header("User-Agent", userAgent).build())
                }
            }
        }
    }
}
