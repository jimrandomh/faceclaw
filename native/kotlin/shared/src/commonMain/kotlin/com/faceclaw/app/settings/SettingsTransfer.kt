package com.faceclaw.app

/**
 * What an import will store: the values to merge into the phone's settings, plus the
 * platform-local keys left out because the document was exported on another platform.
 */
class SettingsImportPlan internal constructor(
    /** String, Boolean or JsonNumber. Objects/arrays in the document arrive as compact JSON strings. */
    val values: Map<String, Any>,
    val skipped: List<String>,
    /** The platform that exported the document, or null when it doesn't say. */
    val sourcePlatform: String?,
)

/**
 * The settings export/import document shared by Android and iOS (scripts/config-transfer.md).
 * Only the transfer format is shared: each platform keeps storing settings natively
 * (SharedPreferences / NSUserDefaults), and its config port converts with this codec.
 *
 * ```
 * {
 *   "schema": 2,
 *   "platform": "android",           // the exporting platform
 *   "appVersion": "0.8.3",           // informational
 *   "settings": { ... },             // imported on any platform
 *   "platformSettings": { ... }      // imported only when "platform" matches the importer
 * }
 * ```
 *
 * Values are strings, booleans and numbers, as stored. A string holding a JSON object or array
 * is written as that object/array when doing so is lossless (re-serializing it reproduces the
 * stored text exactly), so structured settings are readable and editable; any object/array value
 * is stored back as its compact JSON text. No setting is stored as a native object, so this never
 * changes a setting's type.
 *
 * Schema 1 (flat `settings`, strings only; written by older iOS builds and by the scripts'
 * conversion of Android shared-preferences XML) is still accepted: its keys are classified with
 * [isPlatformLocal] at import time instead.
 */
object SettingsTransfer {
    private const val SCHEMA = 2
    private const val MAX_BYTES = 2 * 1024 * 1024
    private const val MAX_ENTRIES = 4096
    private const val MAX_KEY_CHARS = 512

    /** Bookkeeping that is never exported or imported. */
    private val internalKeys = setOf("ios.settings.changeToken")

    // Platform-local: values that would be wrong, or would clobber something correct, on another
    // phone. Everything else is portable, including settings only one platform currently uses,
    // so that they survive an Android -> iOS -> Android round trip. Enum values a platform doesn't
    // offer need no entry here: each setting falls back to its default when read.
    private val platformLocalPrefixes = listOf(
        "ios.", "android.", // platform internals, e.g. CoreBluetooth peripheral identifiers
        "deviceAddress.", "deviceIdentity.", // glasses and ring paired with this phone (bonds are per phone)
        "onboarding.", // whether this phone has been set up: pairing, permissions, firmware
    )
    private val platformLocalKeys = setOf(
        "notifications.sources", // Android package names vs iOS bundle identifiers
        "music.apps", "music.lastApp", // Android media-browser packages
        "files.bookmarks", "teleprompter.recents", // paths in this phone's storage
        "evenhub.installedApps.v1", // packages unpacked into this phone's storage
        "integrations.evenhub.terminalId", "integrations.evenhub.openUdid", // per-phone EvenHub device IDs
    )

    fun isPlatformLocal(key: String): Boolean =
        key in platformLocalKeys || platformLocalPrefixes.any { key.startsWith(it) }

    /**
     * Encode a phone's settings as a document. [values] holds String, Boolean and numeric
     * (JsonNumber, Int, Long, Float, Double) values; other types are rejected.
     */
    fun export(values: Map<String, Any?>, platform: String, appVersion: String? = null): String {
        val settings = linkedMapOf<String, Any?>()
        val local = linkedMapOf<String, Any?>()
        for (key in values.keys.sorted()) {
            if (key in internalKeys) continue
            val value = values[key]
            requireKey(key)
            val encoded = when (value) {
                is String -> structured(value) ?: value
                is Boolean, is JsonNumber -> value
                is Int, is Long -> JsonNumber(value.toString())
                is Float -> JsonNumber.of(value.toDouble())
                is Double -> JsonNumber.of(value)
                else -> throw IllegalArgumentException("Unsupported value type for setting $key")
            }
            (if (isPlatformLocal(key)) local else settings)[key] = encoded
        }
        require(settings.size + local.size <= MAX_ENTRIES) { "Too many settings" }
        val document = linkedMapOf<String, Any?>("schema" to JsonNumber.of(SCHEMA), "platform" to platform)
        if (!appVersion.isNullOrEmpty()) document["appVersion"] = appVersion
        document["settings"] = settings
        document["platformSettings"] = local
        val text = Json.write(document, pretty = true) + "\n"
        require(text.encodeToByteArray().size <= MAX_BYTES) { "Config exceeds 2 MiB" }
        return text
    }

    /** Validate a document and work out what importing it on [platform] stores. */
    fun planImport(text: String, platform: String): SettingsImportPlan {
        require(text.encodeToByteArray().size <= MAX_BYTES) { "Config exceeds 2 MiB" }
        val root = runCatching { Json.parse(text) }.getOrElse { throw IllegalArgumentException("Config is not valid JSON: ${it.message}") }
            .asObject() ?: throw IllegalArgumentException("Expected a Faceclaw config object")
        val schema = (root["schema"] as? JsonNumber)?.text
        val source = root["platform"]?.let { it as? String ?: throw IllegalArgumentException("\"platform\" must be a string") }
        val portable = section(root, "settings") ?: throw IllegalArgumentException("Missing \"settings\" object")
        val values = linkedMapOf<String, Any>()
        val skipped = ArrayList<String>()
        val seen = HashSet<String>()
        fun add(key: String, value: Any?, include: Boolean) {
            requireKey(key)
            require(seen.add(key)) { "Setting $key appears more than once" }
            require(seen.size <= MAX_ENTRIES) { "Too many settings" }
            val stored = storedValue(key, value)
            if (key in internalKeys) return
            if (include) values[key] = stored else skipped.add(key)
        }
        val from = when (schema) {
            "1" -> {
                // Old builds exported iOS settings only; the scripts tag converted Android XML.
                val from = source ?: "ios"
                for ((key, value) in portable) add(key, value, from == platform || !isPlatformLocal(key))
                from
            }
            "2" -> {
                for ((key, value) in portable) add(key, value, true)
                section(root, "platformSettings")?.forEach { (key, value) -> add(key, value, source == platform) }
                source
            }
            else -> throw IllegalArgumentException(if (schema == null) "Missing \"schema\"" else "Unsupported config schema $schema")
        }
        return SettingsImportPlan(values, skipped, from)
    }

    /**
     * Objective-C bridge (FaceclawConfigPort.m, `exportValuesJson:platform:appVersion:`): [json]
     * is a JSON object of the phone's settings. Returns the document, or null when the values
     * can't be exported.
     */
    fun exportValues(json: String, platform: String, appVersion: String?): String? = runCatching {
        export(Json.parseObject(json), platform, appVersion)
    }.onFailure { PlatformLog.w("SettingsTransfer", "export failed: ${it.message}") }.getOrNull()

    /**
     * Objective-C bridge (`importPlanDocument:platform:`): never throws. Returns a JSON object, either
     * `{"ok":true,"settings":{...},"skipped":[...],"sourcePlatform":...}` or `{"ok":false,"message":...}`.
     */
    fun importPlan(document: String, platform: String): String = try {
        val plan = planImport(document, platform)
        Json.write(linkedMapOf("ok" to true, "settings" to plan.values, "skipped" to plan.skipped, "sourcePlatform" to plan.sourcePlatform))
    } catch (error: Exception) {
        Json.write(mapOf("ok" to false, "message" to (error.message ?: "Invalid config")))
    }

    private fun section(root: Map<String, Any?>, name: String): Map<String, Any?>? {
        val value = root[name] ?: return null
        return value.asObject() ?: throw IllegalArgumentException("\"$name\" must be an object")
    }

    private fun requireKey(key: String) {
        require(key.isNotEmpty() && key.length <= MAX_KEY_CHARS) { "Invalid setting name" }
    }

    private fun storedValue(key: String, value: Any?): Any = when (value) {
        is String, is Boolean, is JsonNumber -> value
        is Map<*, *>, is List<*> -> Json.write(value)
        null -> throw IllegalArgumentException("Setting $key is null; supply an empty value to clear it")
        else -> throw IllegalArgumentException("Unsupported value for setting $key")
    }

    /** The object/array a string holds, when writing it back reproduces the string exactly. */
    private fun structured(text: String): Any? {
        if (text.isEmpty() || (text[0] != '{' && text[0] != '[')) return null
        val parsed = runCatching { Json.parse(text) }.getOrNull()
        if (parsed !is Map<*, *> && parsed !is List<*>) return null
        return parsed.takeIf { Json.write(it) == text }
    }
}
