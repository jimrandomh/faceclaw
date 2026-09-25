package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SettingsChangeHubTest {
    private class MemorySettings : SettingsStorage {
        val values = HashMap<String?, Any?>()
        override fun getString(key: String?, defaultValue: String?): String? = values[key] as? String ?: defaultValue
        override fun putString(key: String?, value: String?) { values[key] = value }
        override fun getBoolean(key: String?, defaultValue: Boolean): Boolean = values[key] as? Boolean ?: defaultValue
        override fun putBoolean(key: String?, value: Boolean) { values[key] = value }
    }

    @Test
    fun writesNotifyEachListenerThroughItsOwnDispatcher() {
        val warnings = ArrayList<String>()
        val hub = SettingsChangeHub(MemorySettings(), { warnings.add(it) }, testPlatform())
        val queued = ArrayList<() -> Unit>()
        val seen = ArrayList<String?>()
        val listener = object : FaceclawSettingsListener { override fun onSettingChanged(key: String?) { seen.add(key) } }
        hub.register(listener) { queued.add(it) }
        val silent = object : FaceclawSettingsListener { override fun onSettingChanged(key: String?) { seen.add("silent") } }
        hub.register(silent, null)
        assertEquals(1, warnings.size)

        hub.setString("font", "Inter")
        hub.setBoolean("dark", true)
        assertEquals("Inter", hub.getString("font", null))
        assertTrue(hub.getBoolean("dark", false))
        assertTrue(seen.isEmpty()) // delivered only when the dispatcher runs
        queued.forEach { it() }
        assertEquals(listOf<String?>("font", "dark"), seen)

        val failing = object : FaceclawSettingsListener { override fun onSettingChanged(key: String?) { throw IllegalStateException("boom") } }
        hub.register(failing) { it() }
        hub.setString("x", null)
        assertTrue(warnings.last().contains("boom"))
        hub.unregister(listener)
        hub.unregister(failing)
        queued.clear()
        hub.setBoolean("dark", false)
        assertTrue(queued.isEmpty())
    }
}
