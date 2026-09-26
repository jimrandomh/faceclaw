package com.faceclaw.app

import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic

/**
 * Process-wide registry of the glasses' builtin 20 px font's glyph rasters, fed from the TS side
 * (EvenHubFont's extracted firmware font data). Unlike GlyphAtlas/ImageAtlas entries, these are
 * never uploaded: the firmware already owns the font, and mode 15 draws it directly. The planner
 * needs the rasters purely phone-side — for the "would this draw land correctly" check against the
 * composite and for punching drawn ink out of delta rects.
 *
 * Placement model matches the firmware's mode-15 math: a glyph draws at (penX + ofsX, lineY +
 * inkTop) where inkTop already folds in the root font's line height and baseline. The TS side only
 * registers glyphs whose on-glasses rendering it predicts exactly (native-table glyphs; baseline-
 * shifted fallback symbols stay baked).
 */
class FwGlyphAtlas {
    companion object {
        private val lock = protocolPlatform().createLock()

        private val entries: MutableMap<Int, Entry> = HashMap()

        /**
         * Register glyph rasters. Little-endian buffer of records: [cp u32][ofsX s16][inkTop
         * s16][boxW u8][boxH u8] [boxH x ceil(boxW/2) nibble bytes] Re-registration of a codepoint
         * is ignored (the builtin font is fixed).
         */
        @JvmStatic
        fun register(buffer: ByteReader?): Unit {
            if ((buffer == null)) {
                return
            }
            val cursor: ByteReader = buffer
            lock.withLock {
                while ((cursor.remaining() >= 10)) {
                    var cp: Int = cursor.getInt()
                    var ofsX: Int = cursor.getShort().toInt()
                    var inkTop: Int = cursor.getShort().toInt()
                    var boxW: Int = (cursor.get() and 0xff)
                    var boxH: Int = (cursor.get() and 0xff)
                    var nibbles: ByteArray = ByteArray((((boxW + 1) shr 1) * boxH))
                    cursor.get(nibbles)
                    if ((((boxW > 0) && (boxH > 0)) && !entries.containsKey(cp))) {
                        entries.put(cp, Entry(ofsX, inkTop, boxW, boxH, nibbles))
                    }
                }
            }
        }

        @JvmStatic
        fun get(cp: Int): Entry? {
            lock.withLock {
                return entries.get(cp)
            }
        }
    }

    constructor() {}

    class Entry {
        /** Draw x = pen x + ofsX. */
        @JvmField val ofsX: Int

        /** First raster row relative to the run's line-top y. */
        @JvmField val inkTop: Int

        @JvmField val boxW: Int

        @JvmField val boxH: Int

        /** 4bpp rows, stride ceil(boxW/2), high nibble = left pixel. */
        @JvmField val nibbles: ByteArray

        constructor(ofsX: Int, inkTop: Int, boxW: Int, boxH: Int, nibbles: ByteArray) {
            this.ofsX = ofsX
            this.inkTop = inkTop
            this.boxW = boxW
            this.boxH = boxH
            this.nibbles = nibbles
        }

        /** The 4bpp source value at (col, row); the draw skips 0 (transparent). */
        fun nibbleAt(col: Int, row: Int): Int {
            var b: Int = (nibbles[((row * ((boxW + 1) shr 1)) + (col shr 1))] and 0xff)
            return (if (((col and 1) != 0)) (b and 0x0f) else (b shr 4))
        }
    }
}
