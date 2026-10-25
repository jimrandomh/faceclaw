package com.faceclaw.app

import android.util.Log
import android.webkit.WebView
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

import java.security.MessageDigest

/**
 * Gives each EvenHub package its own WebView profile, so one app's browser
 * storage (cookies, localStorage, IndexedDB, caches, service workers) is out of
 * reach of every other app. That includes the storage of third-party sites an
 * app navigates to, such as a sign-in provider's session cookies, which in the
 * shared default profile any other app's WebView could reuse. The per-app fake
 * origins alone don't cover that, and `*.evenhub.invalid` hosts share a site,
 * so domain cookies would cross between packaged apps too.
 *
 * The profile persists across launches, and is shared by every instance of the
 * same package, like the iOS per-package WKWebsiteDataStore.
 */
class FaceclawEvenHubProfile private constructor() {
    companion object {
        private const val TAG = "FaceclawEvenHub"

        /** Stable per package; the hash input matches the iOS data-store identifier's. */
        @JvmStatic
        fun nameFor(packageId: String): String {
            val digest = MessageDigest.getInstance("SHA-256")
                .digest("com.faceclaw.ehpk:$packageId".toByteArray(Charsets.UTF_8))
            return "evenhub-" + digest.take(16).joinToString("") { "%02x".format(it) }
        }

        /**
         * Put a new WebView in [packageId]'s profile. Must run on the main thread
         * before anything else is done with the WebView.
         *
         * @return false when the WebView provider lacks multi-profile support,
         *   leaving the WebView in the shared default profile.
         */
        @JvmStatic
        fun apply(webView: WebView, packageId: String): Boolean {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
                Log.w(TAG, "multi-profile WebView unsupported; $packageId shares the default profile")
                return false
            }
            val name = nameFor(packageId)
            ProfileStore.getInstance().getOrCreateProfile(name)
            WebViewCompat.setProfile(webView, name)
            return true
        }
    }
}
