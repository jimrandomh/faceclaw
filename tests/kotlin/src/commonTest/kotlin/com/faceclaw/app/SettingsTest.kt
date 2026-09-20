package com.faceclaw.app

import kotlin.test.*

class SettingsTest {
    private val codec = SettingsCodec()
    @Test fun migratesStructuredSettingsWithoutInterpretingOrdinaryText() {
        val old = """{"schema":1,"settings":{"terminal.connections":"[{\"url\":\"ssh://test\"}]","teleprompter.recents":"[]","assistant.conversations":"{\"records\":[]}","prompt":"{\"literal\":true}","files.bookmarks":"broken","enabled":true,"number":9223372036854775807}}"""
        val doc = assertNotNull(codec.decode(old))
        assertTrue(codec.needsMigration(old))
        assertEquals("[{\"url\":\"ssh://test\"}]", doc.getString("terminal.connections", ""))
        assertEquals("broken", doc.getString("files.bookmarks", ""))
        assertTrue(doc.getBoolean("enabled", false))
        val encoded = doc.encode()
        assertTrue(encoded.contains("\"terminal.connections\": ["))
        assertTrue(encoded.contains("\"assistant.conversations\": {"))
        assertTrue(encoded.contains("9223372036854775807"))
        assertTrue(encoded.contains("\"prompt\": \""))
        assertFalse(codec.needsMigration(encoded))
        assertEquals(encoded, assertNotNull(codec.decode(encoded)).encode())
    }
    @Test fun readsJsoncAndRoundTripsEscapesAndNestedValues() {
        val doc = assertNotNull(codec.decode("""
            // exported config
            {"schema": 2, /* version */ "settings": {
              "terminal.connections": [{"url":"ssh://host/path/*literal*/", "nested":[null, true, 1.2e-7,],},],
              "text":"π & < 🔋\nnext\t\\\"\u0001",
            },}
        """))
        val encoded = doc.encode()
        assertEquals(encoded, assertNotNull(codec.decode(encoded)).encode())
        assertEquals("π & < 🔋\nnext\t\\\"\u0001", doc.getString("text", ""))
        assertEquals("fallback", doc.getString("absent", "fallback"))
    }
    @Test fun settersKeepStructuredValuesNativeAndAreImmutable() {
        val before = assertNotNull(codec.decode("""{"schema":2,"settings":{"keep":"yes"}}"""))
        val after = before.replacingString("teleprompter.recents", "[{\"path\":\"a\"}]").replacingBoolean("enabled", true)
        assertEquals("missing", before.getString("teleprompter.recents", "missing"))
        assertTrue(after.encode().contains("\"teleprompter.recents\": ["))
        assertEquals("yes", after.getString("keep", ""))
        assertEquals("fallback", after.getString("enabled", "fallback"))
        val numbered = after.replacingNumber("timestamp", 123.25)
        assertEquals(123.25, numbered.getNumber("timestamp", 0.0))
        assertEquals(7.0, numbered.removing("timestamp").getNumber("timestamp", 7.0))
        val merged = after.merged(assertNotNull(codec.decode("""{"schema":1,"settings":{"keep":"new"}}""")))
        assertEquals("new", merged.getString("keep", ""))
        assertTrue(merged.getBoolean("enabled", false))
    }
    @Test fun oversizedMutationsCannotBeCommitted() {
        val doc = assertNotNull(codec.decode("""{"schema":2,"settings":{}}"""))
        assertNull(doc.replacingString("", "invalid key").encodeForStorage())
        assertNull(doc.replacingString("large", "x".repeat(2 * 1024 * 1024)).encodeForStorage())
        assertNotNull(doc.encodeForStorage())
    }
    @Test fun rejectsBadConfigsAndFutureSchemas() {
        for (invalid in listOf(
            "{}", "[]", "{\"schema\":3,\"settings\":{}}", "{\"schema\":0,\"settings\":{}}",
            "{\"schema\":2,\"settings\":{\"x\":null}}", "{\"schema\":2,\"settings\":{\"\":true}}",
            "{\"schema\":2,\"settings\":{\"x\":NaN}}", "{\"schema\":2,\"settings\":{\"x\":01}}",
            "{\"schema\":2,\"settings\":{\"x\":1,\"x\":2}}", "{\"schema\":2,\"settings\":{}} trailing",
            "{\"schema\":2,\"settings\":{\"x\":1e999}}",
            "{\"schema\":2,\"settings\":{\"x\":\"\\u+001\"}}",
            "/* unterminated", "{\"schema\":2,\"settings\":{\"x\":\"bad\\q\"}}",
            "{\"schema\":2,\"settings\":{\"x\":" + "[".repeat(70) + "0" + "]".repeat(70) + "}}"
        )) assertNull(codec.decode(invalid), invalid)
    }
}
