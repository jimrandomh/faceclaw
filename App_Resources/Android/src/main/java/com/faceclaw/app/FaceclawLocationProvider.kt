package com.faceclaw.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Criteria
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper

import androidx.core.content.ContextCompat

/**
 * One-shot, foreground-only location lookup for Weather. It prefers a fresh
 * coarse network fix, but can fall back to the newest cached provider fix if
 * Android cannot produce a new location before the timeout.
 */
class FaceclawLocationProvider(context: Context) : LocationListener {
    companion object {
        private const val FRESH_CACHE_MS = 10L * 60L * 1000L
        private const val MAX_CACHE_MS = 24L * 60L * 60L * 1000L
        private const val TIMEOUT_MS = 15L * 1000L

        private fun isRecent(location: Location?, maximumAgeMs: Long): Boolean {
            return location != null &&
                location.time > 0L &&
                System.currentTimeMillis() - location.time <= maximumAgeMs
        }
    }

    private val context: Context = context.applicationContext
    private val locationManager: LocationManager? =
        this.context.getSystemService(Context.LOCATION_SERVICE) as LocationManager?
    private val mainHandler = Handler(Looper.getMainLooper())
    private val timeout = Runnable { onTimeout() }

    private var listener: FaceclawLocationListener? = null
    private var cachedLocation: Location? = null
    private var running = false

    fun setListener(listener: FaceclawLocationListener?) {
        this.listener = listener
    }

    fun start() {
        mainHandler.post { startOnMainThread() }
    }

    fun cancel() {
        mainHandler.post { finish(null, null) }
    }

    private fun startOnMainThread() {
        if (running) {
            return
        }
        val manager = locationManager
        if (manager == null) {
            deliverError("Android location service is unavailable.")
            return
        }
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) !=
            PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) !=
            PackageManager.PERMISSION_GRANTED) {
            deliverError("Location permission is required.")
            return
        }

        cachedLocation = newestCachedLocation()
        if (isRecent(cachedLocation, FRESH_CACHE_MS)) {
            deliverLocation(cachedLocation)
            return
        }

        val provider = chooseProvider()
        if (provider == null) {
            if (isRecent(cachedLocation, MAX_CACHE_MS)) {
                deliverLocation(cachedLocation)
            } else {
                deliverError("Turn on Location on your phone, then retry.")
            }
            return
        }

        try {
            running = true
            @Suppress("DEPRECATION")
            manager.requestSingleUpdate(provider, this, Looper.getMainLooper())
            mainHandler.postDelayed(timeout, TIMEOUT_MS)
        } catch (error: SecurityException) {
            finish(null, "Location permission is required.")
        } catch (error: Throwable) {
            finish(null, "Unable to request the current location.")
        }
    }

    private fun chooseProvider(): String? {
        try {
            if (locationManager!!.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                return LocationManager.NETWORK_PROVIDER
            }
            val criteria = Criteria()
            criteria.accuracy = Criteria.ACCURACY_COARSE
            criteria.powerRequirement = Criteria.POWER_LOW
            return locationManager.getBestProvider(criteria, true)
        } catch (ignored: Throwable) {
            return null
        }
    }

    private fun newestCachedLocation(): Location? {
        var newest: Location? = null
        try {
            val providers = locationManager!!.getProviders(true)
            for (provider in providers) {
                val candidate = locationManager.getLastKnownLocation(provider)
                if (candidate != null && (newest == null || candidate.time > newest.time)) {
                    newest = candidate
                }
            }
        } catch (ignored: SecurityException) {
            // The explicit permission check above owns the user-facing error.
        } catch (ignored: Throwable) {
            // A fresh request may still succeed even if cached providers fail.
        }
        return newest
    }

    private fun onTimeout() {
        if (isRecent(cachedLocation, MAX_CACHE_MS)) {
            finish(cachedLocation, null)
        } else {
            finish(null, "Couldn't get your current location. Tap to retry.")
        }
    }

    override fun onLocationChanged(location: Location) {
        finish(location, null)
    }

    override fun onProviderDisabled(provider: String) {
        // Keep waiting: Android may still deliver a queued fix or the timeout
        // can fall back to another provider's cached location.
    }

    override fun onProviderEnabled(provider: String) {
    }

    @Deprecated("Deprecated in Java")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {
    }

    private fun finish(location: Location?, error: String?) {
        if (running) {
            try {
                locationManager!!.removeUpdates(this)
            } catch (ignored: Throwable) {
            }
        }
        running = false
        mainHandler.removeCallbacks(timeout)
        if (location != null) {
            deliverLocation(location)
        } else if (error != null) {
            deliverError(error)
        }
    }

    private fun deliverLocation(location: Location?) {
        val current = listener
        if (current != null && location != null) {
            current.onLocation(
                location.latitude,
                location.longitude,
                if (location.hasAccuracy()) location.accuracy else -1f,
                location.time)
        }
    }

    private fun deliverError(message: String) {
        val current = listener
        current?.onError(message)
    }
}
