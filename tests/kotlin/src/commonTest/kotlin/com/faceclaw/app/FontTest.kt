package com.faceclaw.app

import kotlin.test.*

class FontTest {
    @Test
    fun bundledFontMatchesJavaMetricsAndGlyphs() {
        assertContentEquals(byteArrayOf(25, 19), LvglFontFile.getMetrics(TEST_FONT_PATH))
        val vectors =
            mapOf(
                0x25a6 to "b08ecb603fd059b0a00ba3088f18b79185c421e73049797cd3cb0828e1e5cd04",
                0x25c6 to "c176d5dcdb5f7e3a7220455528efde3760672c40cee39b422fc3f5ad20df66dd",
                0x4e2d to "9bde2c8f1ffcf7afc598f4d0350c9ff262484816aa0c9b46d31f0c3c09613003",
                0xff21 to "0074f96299a75b86912282416e47e0823790e091352aec852eff49b89b2e719d",
            )
        vectors.forEach { (codePoint, expected) ->
            assertEquals(expected, digest(LvglFontFile.getGlyph(TEST_FONT_PATH, codePoint)))
        }
        assertTrue(LvglFontFile.getGlyph(TEST_FONT_PATH, 0x10ffff).isEmpty())
        assertTrue(LvglFontFile.getMetrics("/nonexistent/faceclaw-font").isEmpty())
    }
}
