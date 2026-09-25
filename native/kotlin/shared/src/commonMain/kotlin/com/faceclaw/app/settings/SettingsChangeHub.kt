package com.faceclaw.app

/** Key/value backing store for app settings (the JSONC SettingsDocument on Android). */
interface SettingsStorage {
    fun getString(key: String?, defaultValue: String?): String?

    fun putString(key: String?, value: String?)

    fun getBoolean(key: String?, defaultValue: Boolean): Boolean

    fun putBoolean(key: String?, value: Boolean)
}

/** Runs an action on the thread that registered a listener (a Looper Handler, a dispatch queue). */
fun interface SettingsDispatcher {
    fun post(action: () -> Unit)
}

/**
 * Settings reads/writes plus change fan-out. Each JS isolate registers one listener together
 * with a dispatcher for its own thread; every write notifies every listener through its own
 * dispatcher, so callbacks never run on a foreign thread. A listener registered without a
 * dispatcher is accepted but never notified (it can still read fresh values on demand).
 */
class SettingsChangeHub(
    private val storage: SettingsStorage,
    private val warn: (String) -> Unit = { PlatformLog.w("FaceclawSettings", it) },
    platform: ProtocolPlatform = protocolPlatform(),
) {
    private class Entry(val listener: FaceclawSettingsListener, val dispatcher: SettingsDispatcher?)

    private val lock = platform.createLock()
    private var listeners: List<Entry> = emptyList()

    fun getString(key: String?, defaultValue: String?): String? = storage.getString(key, defaultValue)

    fun setString(key: String?, value: String?) {
        storage.putString(key, value)
        notifyChanged(key)
    }

    fun getBoolean(key: String?, defaultValue: Boolean): Boolean = storage.getBoolean(key, defaultValue)

    fun setBoolean(key: String?, value: Boolean) {
        storage.putBoolean(key, value)
        notifyChanged(key)
    }

    fun register(listener: FaceclawSettingsListener, dispatcher: SettingsDispatcher?) {
        if (dispatcher == null) warn("settings listener registered from a thread without a dispatcher; it will never be notified")
        lock.withLock { listeners = listeners + Entry(listener, dispatcher) }
    }

    fun unregister(listener: FaceclawSettingsListener?) {
        lock.withLock { listeners = listeners.filter { it.listener !== listener } }
    }

    fun notifyChanged(key: String?) {
        val current = lock.withLock { listeners }
        for (entry in current) {
            val dispatcher = entry.dispatcher ?: continue
            dispatcher.post {
                try {
                    entry.listener.onSettingChanged(key)
                } catch (error: Exception) {
                    warn("settings listener failed for key $key: ${error.message}")
                }
            }
        }
    }
}
