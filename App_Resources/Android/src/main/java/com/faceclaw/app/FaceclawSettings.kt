package com.faceclaw.app

import android.content.Context
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper

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
 * The reads/writes and the fan-out live in the shared SettingsChangeHub.
 */
class FaceclawSettings private constructor(context: Context) {
    private val prefs: SharedPreferences = context.applicationContext
        .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val hub = SettingsChangeHub(object : SettingsStorage {
        override fun getString(key: String?, defaultValue: String?): String? = prefs.getString(key, defaultValue)

        override fun putString(key: String?, value: String?) {
            prefs.edit().putString(key, value).apply()
        }

        override fun getBoolean(key: String?, defaultValue: Boolean): Boolean = prefs.getBoolean(key, defaultValue)

        override fun putBoolean(key: String?, value: Boolean) {
            prefs.edit().putBoolean(key, value).apply()
        }
    })

    companion object {
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

    fun getString(key: String?, defaultValue: String?): String? = hub.getString(key, defaultValue)

    fun setString(key: String?, value: String?) = hub.setString(key, value)

    fun getBoolean(key: String?, defaultValue: Boolean): Boolean = hub.getBoolean(key, defaultValue)

    fun setBoolean(key: String?, value: Boolean) = hub.setBoolean(key, value)

    /**
     * Register a change listener. Must be called from the thread whose
     * isolate owns the listener; that thread's Looper is captured for
     * dispatch.
     */
    fun registerListener(listener: FaceclawSettingsListener) {
        val looper = Looper.myLooper()
        val handler = if (looper != null) Handler(looper) else null
        hub.register(listener, if (handler != null) SettingsDispatcher { action -> handler.post(action) } else null)
    }

    fun unregisterListener(listener: FaceclawSettingsListener?) = hub.unregister(listener)
}
