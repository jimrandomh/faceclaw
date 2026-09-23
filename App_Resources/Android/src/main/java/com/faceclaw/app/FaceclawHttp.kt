package com.faceclaw.app

import java.io.IOException

import okhttp3.Interceptor
import okhttp3.Request
import okhttp3.Response

/**
 * Android okhttp face of the shared HTTP identity. The version lives in
 * app/version.ts, so the TypeScript side pushes the real string in at startup
 * (see installNativeUserAgent in app/util/http.ts); the value itself is held
 * by the shared HttpIdentity so every platform's networking reads one string.
 */
class FaceclawHttp private constructor() {
    companion object {
        @JvmStatic
        fun setUserAgent(value: String?) = HttpIdentity.setUserAgent(value)

        @JvmStatic
        fun getUserAgent(): String = HttpIdentity.getUserAgent()

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
                    return chain.proceed(request.newBuilder().header("User-Agent", HttpIdentity.getUserAgent()).build())
                }
            }
        }
    }
}
