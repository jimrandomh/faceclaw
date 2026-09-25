package com.faceclaw.app

import kotlin.jvm.JvmStatic

/** A JSON number kept as its source text so integers and decimals survive a round trip. */
data class JsonNumber(val text: String) {
    fun toLong(): Long = text.toLongOrNull() ?: text.toDouble().toLong()

    fun toInt(): Int = toLong().toInt()

    fun toDouble(): Double = text.toDouble()

    companion object {
        @JvmStatic fun of(value: Long): JsonNumber = JsonNumber(value.toString())

        @JvmStatic fun of(value: Int): JsonNumber = JsonNumber(value.toString())

        @JvmStatic
        fun of(value: Double): JsonNumber {
            require(value.isFinite()) { "JSON numbers must be finite" }
            val whole = value.toLong()
            return JsonNumber(if (whole.toDouble() == value) whole.toString() else value.toString())
        }
    }
}

/**
 * Minimal JSON codec shared by both platforms (org.json is JVM-only). Values are
 * `Map<String, Any?>` (insertion ordered), `List<Any?>`, `String`, `Boolean`, `JsonNumber`
 * and `null`. `parse` also accepts `//` and block comments plus trailing commas, which the
 * settings documents rely on; `write` always emits strict JSON.
 */
object Json {
    private val numberPattern = Regex("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")

    @JvmStatic fun parse(text: String): Any? = Parser(text).parse()

    @JvmStatic fun parseObject(text: String): Map<String, Any?> = parse(text).asObject() ?: error("JSON object expected")

    @JvmStatic fun parseArray(text: String): List<Any?> = parse(text).asArray() ?: error("JSON array expected")

    @JvmStatic
    fun write(value: Any?, pretty: Boolean = false): String = write(value, pretty, 0)

    @JvmStatic
    fun quote(text: String): String = buildString {
        append('"')
        for (c in text) when (c) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (c < ' ') append("\\u" + c.code.toString(16).padStart(4, '0')) else append(c)
        }
        append('"')
    }

    private fun write(value: Any?, pretty: Boolean, depth: Int): String {
        fun collection(open: String, close: String, entries: List<String>): String {
            if (entries.isEmpty()) return open + close
            return if (pretty) open + "\n" + entries.joinToString(",\n") { "  ".repeat(depth + 1) + it } + "\n" + "  ".repeat(depth) + close
            else open + entries.joinToString(",") + close
        }
        return when (value) {
            null -> "null"
            is String -> quote(value)
            is Boolean -> value.toString()
            is JsonNumber -> value.text
            is Int -> value.toString()
            is Long -> value.toString()
            is Float -> JsonNumber.of(value.toDouble()).text
            is Double -> JsonNumber.of(value).text
            is List<*> -> collection("[", "]", value.map { write(it, pretty, depth + 1) })
            is Array<*> -> collection("[", "]", value.map { write(it, pretty, depth + 1) })
            is Map<*, *> -> collection("{", "}", value.entries.map { quote(it.key as String) + (if (pretty) ": " else ":") + write(it.value, pretty, depth + 1) })
            else -> error("Unsupported JSON value: ${value::class.simpleName}")
        }
    }

    private class Parser(val text: String) {
        var i = 0
        fun parse(): Any? { val result = value(0); space(); require(i == text.length) { "Trailing characters in JSON" }; return result }
        fun space() {
            while (i < text.length) {
                if (text[i] in " \r\n\t﻿") { i++; continue }
                if (text.startsWith("//", i)) { while (i < text.length && text[i] != '\n' && text[i] != '\r') i++; continue }
                if (text.startsWith("/*", i)) { val end = text.indexOf("*/", i + 2); require(end >= 0); i = end + 2; continue }
                break
            }
        }
        fun take(c: Char): Boolean { space(); return if (i < text.length && text[i] == c) { i++; true } else false }
        fun value(depth: Int): Any? {
            require(depth < 64); space(); require(i < text.length) { "Unexpected end of JSON" }
            return when (text[i]) {
                '"' -> string()
                '{' -> {
                    i++; val result = linkedMapOf<String, Any?>()
                    if (!take('}')) while (true) {
                        space(); val key = string(); require(!result.containsKey(key)) { "Duplicate key $key" }; require(take(':'))
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
                    require(match != null && match.range.first == i) { "Invalid JSON value at $i" }
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

// Typed accessors for parsed values; each returns null when the value has another type.
@Suppress("UNCHECKED_CAST")
fun Any?.asObject(): Map<String, Any?>? = this as? Map<String, Any?>

fun Any?.asArray(): List<Any?>? = this as? List<Any?>

fun Any?.asString(): String? = this as? String

fun Any?.asBoolean(): Boolean? = this as? Boolean

fun Any?.asLong(): Long? = (this as? JsonNumber)?.toLong() ?: (this as? Long) ?: (this as? Int)?.toLong()

fun Any?.asInt(): Int? = asLong()?.toInt()

fun Any?.asDouble(): Double? = (this as? JsonNumber)?.toDouble() ?: (this as? Double) ?: (this as? Int)?.toDouble() ?: (this as? Long)?.toDouble()
