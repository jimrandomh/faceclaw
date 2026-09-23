package com.faceclaw.app

import android.content.Context
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.util.Log

import java.util.concurrent.CopyOnWriteArrayList

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
class FaceclawSettings private constructor(context: Context) {
    private val prefs: SharedPreferences = context.applicationContext
        .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val listeners = CopyOnWriteArrayList<ListenerEntry>()

    private class ListenerEntry(val listener: FaceclawSettingsListener, val handler: Handler?)

    companion object {
        private const val TAG = "FaceclawSettings"
        private const val PREFS_NAME = "faceclaw_settings"
        @Volatile
        private var instance: FaceclawSettings? = null

        /** Initialize (idempotent) and return the singleton. */
        @JvmStatic
        fun getInstance(context: Context): FaceclawSettings {
            if (instance == null) {
                synchronized(FaceclawSettings::class.java) {
                    if (instance == null) {
                        instance = FaceclawSettings(context)
                    }
                }
            }
            return instance!!
        }

        /** Return the singleton; the main isolate must have initialized it first. */
        @JvmStatic
        fun getInstance(): FaceclawSettings {
            val result = instance
                ?: throw IllegalStateException("FaceclawSettings not initialized; call getInstance(context) first")
            return result
        }
    }

    fun getString(key: String?, defaultValue: String?): String? {
        return prefs.getString(key, defaultValue)
    }

    fun setString(key: String?, value: String?) {
        prefs.edit().putString(key, value).apply()
        notifyChanged(key)
    }

    fun getBoolean(key: String?, defaultValue: Boolean): Boolean {
        return prefs.getBoolean(key, defaultValue)
    }

    fun setBoolean(key: String?, value: Boolean) {
        prefs.edit().putBoolean(key, value).apply()
        notifyChanged(key)
    }

    /**
     * Register a change listener. Must be called from the thread whose
     * isolate owns the listener; that thread's Looper is captured for
     * dispatch.
     */
    fun registerListener(listener: FaceclawSettingsListener) {
        val looper = Looper.myLooper()
        if (looper == null) {
            Log.w(TAG, "settings listener registered from a Looper-less thread; it will never be notified")
        }
        listeners.add(ListenerEntry(listener, if (looper != null) Handler(looper) else null))
    }

    fun unregisterListener(listener: FaceclawSettingsListener?) {
        for (entry in listeners) {
            if (entry.listener === listener) {
                listeners.remove(entry)
            }
        }
    }

    private fun notifyChanged(key: String?) {
        for (entry in listeners) {
            val handler = entry.handler ?: continue
            handler.post {
                try {
                    entry.listener.onSettingChanged(key)
                } catch (e: Exception) {
                    Log.w(TAG, "settings listener failed for key $key", e)
                }
            }
        }
    }
}
