package com.faceclaw.app

import android.content.Context
import android.location.Address
import android.location.Geocoder
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.Locale
import kotlin.concurrent.thread

/**
 * Place name for the Weather header where the weather source doesn't supply
 * one (outside National Weather Service coverage), from Android's own
 * Geocoder. Its lookup blocks on the network, so it runs on a thread of its
 * own; the listener hears back on the main thread, with nulls when the phone
 * has no geocoder or the lookup fails.
 */
class FaceclawReverseGeocoder(context: Context) {
    interface Listener {
        fun onResult(locality: String?, region: String?, country: String?)
    }

    companion object {
        private const val TAG = "FaceclawGeocoder"
    }

    private val context: Context = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())

    fun lookup(latitude: Double, longitude: Double, listener: Listener) {
        thread(name = "FaceclawReverseGeocoder", isDaemon = true) {
            val address = lookupBlocking(latitude, longitude)
            mainHandler.post { listener.onResult(address?.locality, address?.adminArea, address?.countryName) }
        }
    }

    private fun lookupBlocking(latitude: Double, longitude: Double): Address? {
        if (!Geocoder.isPresent()) {
            return null
        }
        return try {
            // The listener form needs API 33; this one is fine off the main thread.
            @Suppress("DEPRECATION")
            Geocoder(context, Locale.getDefault()).getFromLocation(latitude, longitude, 1)?.firstOrNull()
        } catch (error: Throwable) {
            Log.w(TAG, "reverse geocode failed: $error")
            null
        }
    }
}
