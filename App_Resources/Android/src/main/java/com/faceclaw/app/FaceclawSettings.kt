package com.faceclaw.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * App settings store shared by every JS isolate (main thread and app
 * workers). JSONC encoding, typed values and migrations live in the shared
 * Kotlin SettingsDocument. This adapter serializes access and commits atomically.
 *
 * Change notifications: each isolate registers one listener from its own
 * thread. The registering thread's Looper is captured, and notifications are
 * posted through it so the JS callback always runs on the isolate's own
 * thread (calling into an isolate from a foreign thread is not allowed).
 * NativeScript worker threads run a message loop, so both the main thread
 * and workers have a Looper; a listener registered from a Looper-less thread
 * is accepted but never notified (it can still read fresh values on demand).
 * The string/boolean reads/writes and the fan-out live in the shared SettingsChangeHub.
 */
class FaceclawSettings private constructor(context: Context) {
    private val file = AtomicFile(configFile(context))
    private lateinit var document: SettingsDocument
    // Only reached through the synchronized public methods below, which never pass null.
    private val hub = SettingsChangeHub(object : SettingsStorage {
        override fun getString(key: String?, defaultValue: String?): String? = document.getString(key!!, defaultValue!!)

        override fun putString(key: String?, value: String?) = save(document.replacingString(key!!, value!!))

        override fun getBoolean(key: String?, defaultValue: Boolean): Boolean = document.getBoolean(key!!, defaultValue)

        override fun putBoolean(key: String?, value: Boolean) = save(document.replacingBoolean(key!!, value))
    })

    init {
        try {
            // AtomicFile also recovers an interrupted write before we consider XML.
            if (file.baseFile.exists() || File("${file.baseFile}.bak").exists()) {
                val original = String(file.readFully(), Charsets.UTF_8)
                document = decode(original)
                // Persist a migration, but preserve comments on already-current files.
                if (SettingsCodec().needsMigration(original)) persist(document)
            } else {
                val legacy = JSONObject(context.applicationContext
                    .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).all)
                // These keys were still stored through NativeScript's separate preferences.
                for ((key, stored) in context.getSharedPreferences("prefs.db", Context.MODE_PRIVATE).all) {
                    if (key.startsWith("deviceAddress.") || key.startsWith("deviceIdentity.") || key.startsWith("onboarding.") || key.startsWith("evenhub:")) {
                        val value = if (key == "deviceIdentity.pairedAtMs" && stored is Long) Double.fromBits(stored) else stored
                        if (!legacy.has(key)) legacy.put(key, value)
                    }
                }
                document = decode("{\"schema\":1,\"settings\":$legacy}")
                persist(document) // Never delete the legacy XML.
            }
        } catch (error: Exception) {
            throw IllegalStateException("Could not load settings; original config retained", error)
        }
    }

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

        @JvmStatic
        fun configFile(context: Context): File = File(context.filesDir, "faceclaw_settings.jsonc")

        @Throws(IOException::class)
        private fun decode(text: String): SettingsDocument =
            SettingsCodec().decode(text) ?: throw IOException("Invalid or unsupported Faceclaw settings config")
    }

    @Throws(IOException::class)
    private fun persist(next: SettingsDocument) {
        val encoded = next.encodeForStorage() ?: throw IOException("Settings exceed format limits")
        var stream: FileOutputStream? = null
        try {
            stream = file.startWrite()
            stream.write(encoded.toByteArray(Charsets.UTF_8))
            file.finishWrite(stream)
        } catch (error: IOException) {
            file.failWrite(stream)
            throw error
        }
        document = next
    }

    private fun save(next: SettingsDocument) {
        try {
            persist(next)
        } catch (error: IOException) {
            throw IllegalStateException("Could not save settings", error)
        }
    }

    @Synchronized
    fun exportConfig(): String = document.encode()

    @Synchronized
    @Throws(IOException::class)
    fun importConfig(text: String) {
        val next = decode(text)
        val backup = AtomicFile(File("${file.baseFile}.previous"))
        val stream = backup.startWrite()
        try {
            stream.write(file.readFully())
            backup.finishWrite(stream)
        } catch (error: IOException) {
            backup.failWrite(stream)
            throw error
        }
        persist(next)
    }

    @Synchronized
    fun getString(key: String, defaultValue: String): String? = hub.getString(key, defaultValue)

    @Synchronized
    fun setString(key: String, value: String) {
        if (!document.containsString(key, value)) hub.setString(key, value)
    }

    @Synchronized
    fun getBoolean(key: String, defaultValue: Boolean): Boolean = hub.getBoolean(key, defaultValue)

    @Synchronized
    fun setBoolean(key: String, value: Boolean) {
        if (document.getBoolean(key, !value) != value) hub.setBoolean(key, value)
    }

    @Synchronized
    fun getNumber(key: String, fallback: Double): Double = document.getNumber(key, fallback)

    @Synchronized
    fun setNumber(key: String, value: Double) {
        require(value.isFinite()) { "Non-finite setting" }
        save(document.replacingNumber(key, value))
        hub.notifyChanged(key)
    }

    @Synchronized
    fun remove(key: String) {
        save(document.removing(key))
        hub.notifyChanged(key)
    }

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
