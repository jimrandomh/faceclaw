package com.faceclaw.app

/** Shared on-disk settings format. Native adapters own locking and atomic IO. */
class SettingsDocument private constructor(private val settings: Map<String, Any?>) {
    fun containsString(key: String, value: String): Boolean = settings[key] == structuredValue(key, value)
    fun getString(key: String, fallback: String): String = when (val value = settings[key]) {
        is String -> value
        is Map<*, *>, is List<*> -> SettingsJson.write(value)
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
    fun encode(): String = SettingsJson.write(mapOf("schema" to JsonNumber(CURRENT_SCHEMA.toString()), "settings" to settings), pretty = true) + "\n"

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
            val parsed = runCatching { SettingsJson.parse(value) }.getOrNull()
            return if (parsed is Map<*, *> || parsed is List<*>) parsed else value
        }
        // Each entry migrates version N to N+1. Never rewrite unknown future schemas.
        private val migrations: Map<Int, (Map<String, Any?>) -> Map<String, Any?>> = mapOf(
            1 to { old -> old.mapValues { (key, value) -> structuredValue(key, value) } }
        )
        internal fun decode(text: String): SettingsDocument {
            require(text.encodeToByteArray().size <= 2 * 1024 * 1024) { "Config exceeds 2 MiB" }
            val root = SettingsJson.parse(text) as? Map<*, *> ?: error("Expected config object")
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
        ((SettingsJson.parse(text) as Map<*, *>)["schema"] as JsonNumber).text != SettingsDocument.CURRENT_SCHEMA.toString()
    }.getOrDefault(false)
    fun decode(text: String): SettingsDocument? = runCatching { SettingsDocument.decode(text) }.getOrNull()
}

private data class JsonNumber(val text: String)

/** Strict JSON plus // and block comments and trailing commas, on both platforms. */
private object SettingsJson {
    private val numberPattern = Regex("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")
    fun parse(text: String): Any? = Parser(text).parse()
    fun write(value: Any?, pretty: Boolean = false, depth: Int = 0): String {
        fun quoted(text: String): String = buildString {
            append('"')
            for (c in text) when (c) {
                '"' -> append("\\\""); '\\' -> append("\\\\"); '\n' -> append("\\n"); '\r' -> append("\\r"); '\t' -> append("\\t")
                else -> if (c < ' ') append("\\u" + c.code.toString(16).padStart(4, '0')) else append(c)
            }
            append('"')
        }
        fun collection(open: String, close: String, entries: List<String>): String {
            if (entries.isEmpty()) return open + close
            return if (pretty) open + "\n" + entries.joinToString(",\n") { "  ".repeat(depth + 1) + it } + "\n" + "  ".repeat(depth) + close
            else open + entries.joinToString(",") + close
        }
        return when (value) {
            null -> "null"
            is String -> quoted(value)
            is Boolean -> value.toString()
            is JsonNumber -> value.text
            is List<*> -> collection("[", "]", value.map { write(it, pretty, depth + 1) })
            is Map<*, *> -> collection("{", "}", value.entries.map { quoted(it.key as String) + (if (pretty) ": " else ":") + write(it.value, pretty, depth + 1) })
            else -> error("Unsupported JSON value")
        }
    }
    private class Parser(val text: String) {
        var i = 0
        fun parse(): Any? { val result = value(0); space(); require(i == text.length); return result }
        fun space() {
            while (i < text.length) {
                if (text[i] in " \r\n\t\uFEFF") { i++; continue }
                if (text.startsWith("//", i)) { while (i < text.length && text[i] != '\n' && text[i] != '\r') i++; continue }
                if (text.startsWith("/*", i)) { val end = text.indexOf("*/", i + 2); require(end >= 0); i = end + 2; continue }
                break
            }
        }
        fun take(c: Char): Boolean { space(); return if (i < text.length && text[i] == c) { i++; true } else false }
        fun value(depth: Int): Any? {
            require(depth < 64); space(); require(i < text.length)
            return when (text[i]) {
                '"' -> string()
                '{' -> {
                    i++; val result = linkedMapOf<String, Any?>()
                    if (!take('}')) while (true) {
                        space(); val key = string(); require(!result.containsKey(key)); require(take(':'))
                        result[key] = value(depth + 1)
                        if (take('}')) break
                        require(take(',')); if (take('}')) break
                    }
                    result
                }
                '[' -> {
                    i++; val result = mutableListOf<Any?>()
                    if (!take(']')) while (true) {
                        result.add(value(depth + 1)); if (take(']')) break
                        require(take(',')); if (take(']')) break
                    }
                    result
                }
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> {
                    val match = numberPattern.find(text, i)
                    require(match != null && match.range.first == i)
                    require(match.value.toDouble().isFinite()); i += match.value.length; JsonNumber(match.value)
                }
            }
        }
        fun literal(word: String, result: Any?): Any? { require(text.startsWith(word, i)); i += word.length; return result }
        fun string(): String {
            require(i < text.length && text[i++] == '"')
            return buildString {
                while (true) {
                    require(i < text.length); val c = text[i++]
                    if (c == '"') break
                    require(c >= ' ')
                    if (c != '\\') { append(c); continue }
                    require(i < text.length)
                    append(when (val escaped = text[i++]) {
                        '"', '\\', '/' -> escaped
                        'b' -> '\b'; 'f' -> '\u000c'; 'n' -> '\n'; 'r' -> '\r'; 't' -> '\t'
                        'u' -> { require(i + 4 <= text.length); val hex = text.substring(i, i + 4); require(hex.all { it in "0123456789abcdefABCDEF" }); val code = hex.toInt(16); i += 4; code.toChar() }
                        else -> error("Invalid escape")
                    })
                }
            }
        }
    }
}
