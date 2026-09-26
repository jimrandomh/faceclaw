package com.faceclaw.app

/** Shared on-disk settings format. Native adapters own locking and atomic IO. */
class SettingsDocument private constructor(private val settings: Map<String, Any?>) {
    fun containsString(key: String, value: String): Boolean = settings[key] == structuredValue(key, value)
    fun getString(key: String, fallback: String): String = when (val value = settings[key]) {
        is String -> value
        is Map<*, *>, is List<*> -> Json.write(value)
        else -> fallback
    }
    fun getBoolean(key: String, fallback: Boolean): Boolean = settings[key] as? Boolean ?: fallback
    fun getNumber(key: String, fallback: Double): Double = (settings[key] as? JsonNumber)?.text?.toDoubleOrNull() ?: fallback
    fun replacingNumber(key: String, value: Double): SettingsDocument =
        SettingsDocument(settings + (key to JsonNumber(value.toString())))
    fun removing(key: String): SettingsDocument = SettingsDocument(settings - key)
    fun replacingString(key: String, value: String): SettingsDocument =
        SettingsDocument(settings + (key to structuredValue(key, value)))
    fun replacingBoolean(key: String, value: Boolean): SettingsDocument = SettingsDocument(settings + (key to value))
    fun merged(other: SettingsDocument): SettingsDocument = SettingsDocument(settings + other.settings)
    fun encode(): String = Json.write(mapOf("schema" to JsonNumber(CURRENT_SCHEMA.toString()), "settings" to settings), pretty = true) + "\n"

    // A mutation/merge must never commit a document that the next launch rejects.
    fun encodeForStorage(): String? {
        val text = encode()
        return if (runCatching { decode(text) }.isSuccess) text else null
    }

    companion object {
        const val CURRENT_SCHEMA = 2
        // Explicit keys avoid interpreting arbitrary text (prompts, passwords, drafts) as JSON.
        private val structuredKeys = setOf(
            "terminal.connections", "teleprompter.recents", "launcher.folders", "notifications.sources",
            "files.bookmarks", "music.apps", "microphones.array-config", "display.uiFont2", "terminal.font",
            "navigate.savedDestinations", "navigate.recentDestinations", "evenhub.installedApps.v1", "timers.state", "assistant.conversations"
        )
        private fun structuredValue(key: String, value: Any?): Any? {
            if ((key !in structuredKeys && !key.startsWith("ios.ble.peripheral.")) || value !is String) return value
            // Preserve empty/invalid old values: callers already provide their own fallback.
            val parsed = runCatching { Json.parse(value) }.getOrNull()
            return if (parsed is Map<*, *> || parsed is List<*>) parsed else value
        }
        // Each entry migrates version N to N+1. Never rewrite unknown future schemas.
        private val migrations: Map<Int, (Map<String, Any?>) -> Map<String, Any?>> = mapOf(
            1 to { old -> old.mapValues { (key, value) -> structuredValue(key, value) } }
        )
        internal fun decode(text: String): SettingsDocument {
            require(text.encodeToByteArray().size <= 2 * 1024 * 1024) { "Config exceeds 2 MiB" }
            val root = Json.parse(text) as? Map<*, *> ?: error("Expected config object")
            var schema = (root["schema"] as? JsonNumber)?.text?.toIntOrNull() ?: error("Missing schema")
            require(schema in 1..CURRENT_SCHEMA) { "Unsupported settings schema" }
            val raw = root["settings"] as? Map<*, *> ?: error("Missing settings")
            require(raw.size <= 4096)
            var values: Map<String, Any?> = raw.entries.associate { (key, value) ->
                require(key is String && key.isNotEmpty() && key.length <= 512)
                require(value != null) { "Null setting" }
                key to value
            }
            while (schema < CURRENT_SCHEMA) values = migrations.getValue(schema++)(values)
            return SettingsDocument(values)
        }
    }
}

/** Nullable decode keeps invalid files recoverable across Objective-C/JVM bridges. */
class SettingsCodec {
    fun needsMigration(text: String): Boolean = runCatching {
        ((Json.parse(text) as Map<*, *>)["schema"] as JsonNumber).text != SettingsDocument.CURRENT_SCHEMA.toString()
    }.getOrDefault(false)
    fun decode(text: String): SettingsDocument? = runCatching { SettingsDocument.decode(text) }.getOrNull()
}
