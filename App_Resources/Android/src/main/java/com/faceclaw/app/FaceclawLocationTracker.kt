package com.faceclaw.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock

import androidx.core.content.ContextCompat

/**
 * Continuous location updates for turn-by-turn navigation. Unlike
 * FaceclawLocationProvider (one-shot, coarse, for Weather), this streams
 * fixes with bearing and speed until stopped.
 *
 * It listens to GPS and to the network (Wi-Fi/cell) provider together. GPS
 * alone gives nothing until the receiver locks, which takes tens of seconds
 * from a cold start and may never happen indoors; the network provider
 * answers within a second or two, so there is a position to start from, and
 * GPS takes over once it is producing fixes.
 *
 * Callbacks are delivered on the Looper of the thread that constructed the
 * tracker, so a worker isolate receives them on its own thread (the same
 * convention as FaceclawSseRequest).
 */
class FaceclawLocationTracker(context: Context) : LocationListener {
    companion object {
        /**
         * Only seed from the platform's cached fix when it is this fresh. An older
         * one is likely wherever the phone was last used (for example the previous
         * navigation's destination), and guidance built on it is wrong from the
         * first frame: the route starts there and arrival fires immediately.
         */
        private const val MAX_SEED_AGE_MS = 60L * 1000L

        /**
         * A network fix is passed on only once GPS has been silent this long, so
         * a coarse Wi-Fi/cell position never interleaves with a live GPS track.
         */
        private const val GPS_SILENT_MS = 10L * 1000L

        /** Fastest rate asked of GPS, whatever interval the caller wants. */
        private const val MIN_GPS_INTERVAL_MS = 500L

        /**
         * Fastest rate asked of the network provider. It only fills in while
         * GPS has nothing, and each of its fixes costs a Wi-Fi scan.
         */
        private const val MIN_NETWORK_INTERVAL_MS = 5L * 1000L

        /** Marks that GPS has produced no fix since tracking started. */
        private const val NEVER = Long.MIN_VALUE

        /** The providers listened to, in order of preference. */
        private val SOURCE_PROVIDERS = arrayOf(
            LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)

        /** Age via the monotonic clock, so a wall-clock change can't make an old fix look fresh. */
        private fun ageMs(location: Location): Long {
            val ageNanos = SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos
            return ageNanos / 1_000_000L
        }
    }

    private val context: Context = context.applicationContext
    private val locationManager: LocationManager? =
        this.context.getSystemService(Context.LOCATION_SERVICE) as LocationManager?
    private val callbackHandler: Handler

    private var listener: FaceclawLocationTrackerListener? = null
    private var running = false

    /** SystemClock.elapsedRealtime() of the latest live GPS fix, or NEVER. */
    private var lastGpsFixAtMs = NEVER

    init {
        val looper = Looper.myLooper()
        this.callbackHandler = Handler(looper ?: Looper.getMainLooper())
    }

    fun setListener(listener: FaceclawLocationTrackerListener?) {
        this.listener = listener
    }

    /** Begin streaming fixes at roughly the requested interval. */
    fun start(intervalMs: Long) {
        callbackHandler.post { startOnCallbackThread(intervalMs) }
    }

    fun stop() {
        callbackHandler.post {
            if (!running) {
                return@post
            }
            running = false
            try {
                locationManager!!.removeUpdates(this)
            } catch (ignored: Throwable) {
            }
        }
    }

    private fun startOnCallbackThread(intervalMs: Long) {
        if (running) {
            return
        }
        val manager = locationManager
        if (manager == null) {
            deliverError("Android location service is unavailable.")
            return
        }
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) !=
            PackageManager.PERMISSION_GRANTED) {
            deliverError("Precise location permission is required for navigation.")
            return
        }

        val providers = enabledSourceProviders()
        if (providers.isEmpty()) {
            deliverError("Turn on Location on your phone, then retry.")
            return
        }

        try {
            running = true
            lastGpsFixAtMs = NEVER
            for (provider in providers) {
                val minimumIntervalMs = if (provider == LocationManager.GPS_PROVIDER)
                    MIN_GPS_INTERVAL_MS else MIN_NETWORK_INTERVAL_MS
                manager.requestLocationUpdates(provider, Math.max(minimumIntervalMs, intervalMs),
                    0f, this, callbackHandler.looper)
            }
            // Seed with the freshest cached fix so the UI has a position
            // before the first live fix, but only if it's recent enough to
            // still be where the user is.
            val cached = freshestCachedLocation()
            if (cached != null) {
                deliverLocation(cached)
            }
        } catch (error: SecurityException) {
            abandonStart("Precise location permission is required for navigation.")
        } catch (error: Throwable) {
            abandonStart("Unable to start location updates.")
        }
    }

    /** Undo a start that failed part-way: one provider may already be registered. */
    private fun abandonStart(message: String) {
        running = false
        try {
            locationManager!!.removeUpdates(this)
        } catch (ignored: Throwable) {
        }
        deliverError(message)
    }

    /**
     * The newest cached fix from any provider, including the passive and fused
     * ones: whatever another app (a maps app, say) located the phone with last.
     */
    private fun freshestCachedLocation(): Location? {
        val manager = locationManager ?: return null
        val providers: List<String>
        try {
            providers = manager.getProviders(true)
        } catch (ignored: Throwable) {
            return null
        }
        var best: Location? = null
        for (provider in providers) {
            val candidate: Location?
            try {
                candidate = manager.getLastKnownLocation(provider)
            } catch (ignored: Throwable) {
                continue
            }
            if (candidate == null || ageMs(candidate) > MAX_SEED_AGE_MS) {
                continue
            }
            if (best == null || candidate.elapsedRealtimeNanos > best.elapsedRealtimeNanos) {
                best = candidate
            }
        }
        return best
    }

    private fun enabledSourceProviders(): List<String> {
        val manager = locationManager ?: return emptyList()
        return SOURCE_PROVIDERS.filter { provider ->
            try {
                manager.isProviderEnabled(provider)
            } catch (ignored: Throwable) {
                false
            }
        }
    }

    override fun onLocationChanged(location: Location) {
        if (location.provider == LocationManager.GPS_PROVIDER) {
            lastGpsFixAtMs = SystemClock.elapsedRealtime()
        } else if (lastGpsFixAtMs != NEVER &&
            SystemClock.elapsedRealtime() - lastGpsFixAtMs < GPS_SILENT_MS) {
            return
        }
        deliverLocation(location)
    }

    override fun onProviderDisabled(provider: String) {
        // Losing one source leaves the other usable: the network provider
        // goes away with the phone's Location Accuracy setting alone.
        if (enabledSourceProviders().isEmpty()) {
            deliverError("Location was turned off on the phone.")
        }
    }

    override fun onProviderEnabled(provider: String) {
    }

    @Deprecated("Deprecated in Java")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {
    }

    private fun deliverLocation(location: Location?) {
        val current = listener
        if (current == null || location == null) {
            return
        }
        current.onLocation(
            location.latitude,
            location.longitude,
            if (location.hasAccuracy()) location.accuracy else -1f,
            if (location.hasBearing()) location.bearing else -1f,
            if (location.hasSpeed()) location.speed else -1f,
            // When the fix was taken, by the phone's own clock: receivers judge
            // a fix's age against that clock, and Location.getTime() is
            // satellite time for a GPS fix, which need not agree with it.
            System.currentTimeMillis() - ageMs(location))
    }

    private fun deliverError(message: String) {
        val current = listener
        current?.onError(message)
    }
}
