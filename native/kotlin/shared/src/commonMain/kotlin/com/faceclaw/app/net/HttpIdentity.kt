package com.faceclaw.app

import kotlin.concurrent.Volatile
import kotlin.jvm.JvmStatic

/**
 * Shared HTTP identity for the native networking helpers on both platforms. The version
 * lives in app/version.ts, so the TypeScript side pushes the real string in at startup
 * (see installNativeUserAgent in app/util/http.ts); the default is only a fallback for
 * requests that somehow beat that call.
 */
object HttpIdentity {
    const val DEFAULT_USER_AGENT = "Faceclaw"

    @Volatile
    private var userAgent = DEFAULT_USER_AGENT

    @JvmStatic
    fun setUserAgent(value: String?) {
        val trimmed = value?.trim()
        if (!trimmed.isNullOrEmpty()) userAgent = trimmed
    }

    @JvmStatic
    fun getUserAgent(): String = userAgent
}
