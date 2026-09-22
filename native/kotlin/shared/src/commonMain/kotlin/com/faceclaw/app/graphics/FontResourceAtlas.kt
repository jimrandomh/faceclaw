package com.faceclaw.app

/** Self-contained font snapshots; their 96 u16 glyph offsets survive firmware compaction. */
class FontResourceAtlas {
    class Font(val resource: CachedResource, val encodings: Set<Int>)

    companion object {
        private val lock = protocolPlatform().createLock()
        private val fonts = HashMap<Int, Font>()

        fun get(fontId: Int, requested: Set<Int>): Font {
            lock.withLock {
                val old = fonts[fontId]
                if (old != null && old.encodings.containsAll(requested)) return old
                val glyphs = HashMap<Int, GlyphAtlas.Glyph>()
                var size = 193
                // Current-frame glyphs take precedence if the entire font cannot fit.
                for (encoding in requested.sorted() + (old?.encodings ?: emptySet()).sorted()) {
                    if (encoding !in 32..127 || glyphs.containsKey(encoding)) continue
                    val glyph = GlyphAtlas.get(fontId, encoding) ?: continue
                    if (size + glyph.cachedBytes.size > ResourceCacheState.MAX_RESOURCE_SIZE) continue
                    glyphs[encoding] = glyph; size += glyph.cachedBytes.size
                }
                val bytes = ByteArray(size)
                bytes[0] = DrawProtocol.FONT.toByte()
                var offset = 193
                for (encoding in glyphs.keys.sorted()) {
                    val glyph = glyphs.getValue(encoding)
                    val slot = 1 + (encoding - 32) * 2
                    bytes[slot] = offset.toByte(); bytes[slot + 1] = (offset ushr 8).toByte()
                    glyph.cachedBytes.copyInto(bytes, offset)
                    offset += glyph.cachedBytes.size
                }
                val font = Font(CachedResource(bytes), glyphs.keys.toSet())
                fonts[fontId] = font
                return font
            }
        }
    }
}
