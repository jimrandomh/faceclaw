package com.faceclaw.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.util.concurrent.CopyOnWriteArrayList;

/**
 * App settings store shared by every JS isolate (main thread and app
 * workers). Values live in a dedicated SharedPreferences file, distinct from
 * NativeScript's ApplicationSettings file, so this store owns its keys
 * outright (the old TS-side settings were deliberately abandoned, not
 * migrated).
 *
 * Change notifications: each isolate registers one listener from its own
 * thread. The registering thread's Looper is captured, and notifications are
 * posted through it so the JS callback always runs on the isolate's own
 * thread (calling into an isolate from a foreign thread is not allowed).
 * NativeScript worker threads run a message loop, so both the main thread
 * and workers have a Looper; a listener registered from a Looper-less thread
 * is accepted but never notified (it can still read fresh values on demand).
 */
public final class FaceclawSettings {
    private static final String TAG = "FaceclawSettings";
    private static final String PREFS_NAME = "faceclaw_settings";
    private static volatile FaceclawSettings instance;

    private final SharedPreferences prefs;
    private final CopyOnWriteArrayList<ListenerEntry> listeners = new CopyOnWriteArrayList<>();

    private static final class ListenerEntry {
        final FaceclawSettingsListener listener;
        final Handler handler;

        ListenerEntry(FaceclawSettingsListener listener, Handler handler) {
            this.listener = listener;
            this.handler = handler;
        }
    }

    private FaceclawSettings(Context context) {
        this.prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        // Effective overrides are derived from installed signer/grant state on each process start.
        // Never trust a restored or imported cached snapshot before the native registry checks it.
        this.prefs.edit().remove("apps.extensions.effective").commit();
    }

    /** Initialize (idempotent) and return the singleton. */
    public static FaceclawSettings getInstance(Context context) {
        if (instance == null) {
            synchronized (FaceclawSettings.class) {
                if (instance == null) {
                    instance = new FaceclawSettings(context);
                }
            }
        }
        return instance;
    }

    /** Return the singleton; the main isolate must have initialized it first. */
    public static FaceclawSettings getInstance() {
        FaceclawSettings result = instance;
        if (result == null) {
            throw new IllegalStateException("FaceclawSettings not initialized; call getInstance(context) first");
        }
        return result;
    }

    public String getString(String key, String defaultValue) {
        return prefs.getString(key, defaultValue);
    }

    public void setString(String key, String value) {
        prefs.edit().putString(key, value).apply();
        notifyChanged(key);
    }

    public boolean getBoolean(String key, boolean defaultValue) {
        return prefs.getBoolean(key, defaultValue);
    }

    public void setBoolean(String key, boolean value) {
        prefs.edit().putBoolean(key, value).apply();
        notifyChanged(key);
    }

    /**
     * Register a change listener. Must be called from the thread whose
     * isolate owns the listener; that thread's Looper is captured for
     * dispatch.
     */
    public void registerListener(FaceclawSettingsListener listener) {
        Looper looper = Looper.myLooper();
        if (looper == null) {
            Log.w(TAG, "settings listener registered from a Looper-less thread; it will never be notified");
        }
        listeners.add(new ListenerEntry(listener, looper != null ? new Handler(looper) : null));
    }

    public void unregisterListener(FaceclawSettingsListener listener) {
        for (ListenerEntry entry : listeners) {
            if (entry.listener == listener) {
                listeners.remove(entry);
            }
        }
    }

    private void notifyChanged(String key) {
        for (ListenerEntry entry : listeners) {
            if (entry.handler == null) continue;
            entry.handler.post(() -> {
                try {
                    entry.listener.onSettingChanged(key);
                } catch (Exception e) {
                    Log.w(TAG, "settings listener failed for key " + key, e);
                }
            });
        }
    }
}
