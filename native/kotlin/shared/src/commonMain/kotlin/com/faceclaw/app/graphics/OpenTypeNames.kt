package com.faceclaw.app

import kotlin.jvm.JvmStatic

/** Random access over font bytes, so large files are not read whole just for a name. */
interface RandomAccessBytes {
    val length: Long

    /** Reads exactly [count] bytes at [offset] into [into]; throws when out of range. */
    fun read(offset: Long, into: ByteArray, count: Int)
}

class ArrayRandomAccessBytes(private val bytes: ByteArray) : RandomAccessBytes {
    override val length: Long
        get() = bytes.size.toLong()

    override fun read(offset: Long, into: ByteArray, count: Int) {
        require(offset >= 0 && count >= 0 && offset + count <= bytes.size) { "read out of range" }
        bytes.copyInto(into, 0, offset.toInt(), offset.toInt() + count)
    }
}

/**
 * Minimal OpenType 'name' table reader (TTF/OTF/TTC, first face) for font titles.
 * Returns "Family\nStyle" ("Style" may be empty), preferring the typographic names
 * (ids 16/17) over the legacy ones (1/2), or "" when the table cannot be parsed.
 */
object OpenTypeNames {
    private const val TTCF = 0x74746366
    private const val NAME = 0x6e616d65

    @JvmStatic
    fun parseFile(path: String): String = parse(ArrayRandomAccessBytes(readFileData(path)))

    @JvmStatic
    fun parse(bytes: ByteArray): String = parse(ArrayRandomAccessBytes(bytes))

    @JvmStatic
    fun parse(source: RandomAccessBytes): String {
        val fileSize = source.length
        if (fileSize < 12) return ""
        var offset = 0L
        if (readU32(source, 0) == TTCF) { // 'ttcf': use the first face
            if (readU32(source, 8) < 1) return ""
            offset = readU32(source, 12).toLong() and 0xffffffffL
        }
        val numTables = readU16(source, offset + 4)
        var nameOffset = -1L
        for (i in 0 until numTables) {
            val rec = offset + 12 + i * 16L
            if (rec + 16 > fileSize) return ""
            if (readU32(source, rec) == NAME) {
                nameOffset = readU32(source, rec + 8).toLong() and 0xffffffffL
                break
            }
        }
        if (nameOffset < 0 || nameOffset + 6 > fileSize) return ""
        val count = readU16(source, nameOffset + 2)
        val stringStorage = nameOffset + readU16(source, nameOffset + 4)
        var family: String? = null
        var style: String? = null
        var preferredFamily: String? = null
        var preferredStyle: String? = null
        for (i in 0 until count) {
            val rec = nameOffset + 6 + i * 12L
            if (rec + 12 > fileSize) break
            val platform = readU16(source, rec)
            val nameId = readU16(source, rec + 6)
            if (nameId != 1 && nameId != 2 && nameId != 16 && nameId != 17) continue
            val length = readU16(source, rec + 8)
            val strOffset = stringStorage + readU16(source, rec + 10)
            if (strOffset + length > fileSize || length <= 0 || length > 512) continue
            val data = ByteArray(length)
            source.read(strOffset, data, length)
            // Platform 0 (Unicode) and 3 (Windows) store UTF-16BE;
            // platform 1 (Mac) is close enough to Latin-1 for names.
            val value = (if (platform == 1) latin1(data) else utf16be(data)).trim()
            if (value.isEmpty()) continue
            if (nameId == 1 && family == null) family = value
            if (nameId == 2 && style == null) style = value
            if (nameId == 16 && preferredFamily == null) preferredFamily = value
            if (nameId == 17 && preferredStyle == null) preferredStyle = value
        }
        val outFamily = preferredFamily ?: family ?: return ""
        return outFamily + "\n" + (preferredStyle ?: style ?: "")
    }

    private fun latin1(data: ByteArray): String =
        CharArray(data.size) { (data[it].toInt() and 0xff).toChar() }.concatToString()

    private fun utf16be(data: ByteArray): String {
        val chars = CharArray(data.size / 2) {
            (((data[2 * it].toInt() and 0xff) shl 8) or (data[2 * it + 1].toInt() and 0xff)).toChar()
        }
        return chars.concatToString()
    }

    private fun readU16(source: RandomAccessBytes, offset: Long): Int {
        val b = ByteArray(2)
        source.read(offset, b, 2)
        return ((b[0].toInt() and 0xff) shl 8) or (b[1].toInt() and 0xff)
    }

    private fun readU32(source: RandomAccessBytes, offset: Long): Int {
        val b = ByteArray(4)
        source.read(offset, b, 4)
        return ((b[0].toInt() and 0xff) shl 24) or ((b[1].toInt() and 0xff) shl 16) or
            ((b[2].toInt() and 0xff) shl 8) or (b[3].toInt() and 0xff)
    }
}
