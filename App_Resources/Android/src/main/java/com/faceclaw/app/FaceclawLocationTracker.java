package com.faceclaw.app;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import androidx.core.content.ContextCompat;

/**
 * Continuous location updates for turn-by-turn navigation. Unlike
 * FaceclawLocationProvider (one-shot, coarse, for Weather), this streams GPS
 * fixes with bearing and speed until stopped.
 *
 * Callbacks are delivered on the Looper of the thread that constructed the
 * tracker, so a worker isolate receives them on its own thread (the same
 * convention as FaceclawSseRequest).
 */
public final class FaceclawLocationTracker implements LocationListener {
    private final Context context;
    private final LocationManager locationManager;
    private final Handler callbackHandler;

    /**
     * Only seed from the platform's cached fix when it is this fresh. An older
     * one is likely wherever the phone was last used (for example the previous
     * navigation's destination), and guidance built on it is wrong from the
     * first frame: the route starts there and arrival fires immediately.
     */
    private static final long MAX_SEED_AGE_MS = 60L * 1000L;

    private FaceclawLocationTrackerListener listener;
    private boolean running;

    public FaceclawLocationTracker(Context context) {
        this.context = context.getApplicationContext();
        this.locationManager = (LocationManager) this.context.getSystemService(Context.LOCATION_SERVICE);
        Looper looper = Looper.myLooper();
        this.callbackHandler = new Handler(looper != null ? looper : Looper.getMainLooper());
    }

    public void setListener(FaceclawLocationTrackerListener listener) {
        this.listener = listener;
    }

    /** Begin streaming fixes at roughly the requested interval. */
    public void start(long intervalMs) {
        callbackHandler.post(() -> startOnCallbackThread(intervalMs));
    }

    public void stop() {
        callbackHandler.post(() -> {
            if (!running) {
                return;
            }
            running = false;
            try {
                locationManager.removeUpdates(this);
            } catch (Throwable ignored) {
            }
        });
    }

    private void startOnCallbackThread(long intervalMs) {
        if (running) {
            return;
        }
        if (locationManager == null) {
            deliverError("Android location service is unavailable.");
            return;
        }
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            deliverError("Precise location permission is required for navigation.");
            return;
        }

        String provider = chooseProvider();
        if (provider == null) {
            deliverError("Turn on Location on your phone, then retry.");
            return;
        }

        try {
            running = true;
            locationManager.requestLocationUpdates(provider, Math.max(500L, intervalMs), 0f, this,
                    callbackHandler.getLooper());
            // Seed with the freshest cached fix so the UI has a position
            // before the first live fix (GPS cold starts can take a while),
            // but only if it's recent enough to still be where the user is.
            Location cached = freshestCachedLocation(provider);
            if (cached != null) {
                deliverLocation(cached);
            }
        } catch (SecurityException error) {
            running = false;
            deliverError("Precise location permission is required for navigation.");
        } catch (Throwable error) {
            running = false;
            deliverError("Unable to start location updates.");
        }
    }

    private Location freshestCachedLocation(String primaryProvider) {
        Location best = null;
        for (String provider : new String[] {primaryProvider, LocationManager.NETWORK_PROVIDER,
                LocationManager.GPS_PROVIDER}) {
            Location candidate;
            try {
                candidate = locationManager.getLastKnownLocation(provider);
            } catch (Throwable ignored) {
                continue;
            }
            if (candidate == null || ageMs(candidate) > MAX_SEED_AGE_MS) {
                continue;
            }
            if (best == null || candidate.getElapsedRealtimeNanos() > best.getElapsedRealtimeNanos()) {
                best = candidate;
            }
        }
        return best;
    }

    /** Age via the monotonic clock, so a wall-clock change can't make an old fix look fresh. */
    private static long ageMs(Location location) {
        long ageNanos = SystemClock.elapsedRealtimeNanos() - location.getElapsedRealtimeNanos();
        return ageNanos / 1_000_000L;
    }

    private String chooseProvider() {
        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                return LocationManager.GPS_PROVIDER;
            }
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                return LocationManager.NETWORK_PROVIDER;
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    @Override
    public void onLocationChanged(Location location) {
        deliverLocation(location);
    }

    @Override
    public void onProviderDisabled(String provider) {
        deliverError("Location was turned off on the phone.");
    }

    @Override
    public void onProviderEnabled(String provider) {
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onStatusChanged(String provider, int status, Bundle extras) {
    }

    private void deliverLocation(Location location) {
        FaceclawLocationTrackerListener current = listener;
        if (current == null || location == null) {
            return;
        }
        current.onLocation(
                location.getLatitude(),
                location.getLongitude(),
                location.hasAccuracy() ? location.getAccuracy() : -1f,
                location.hasBearing() ? location.getBearing() : -1f,
                location.hasSpeed() ? location.getSpeed() : -1f,
                location.getTime());
    }

    private void deliverError(String message) {
        FaceclawLocationTrackerListener current = listener;
        if (current != null) {
            current.onError(message);
        }
    }
}
