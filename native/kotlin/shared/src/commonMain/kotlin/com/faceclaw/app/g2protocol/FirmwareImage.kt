package com.faceclaw.app

import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic

/**
 * Stock EVENOTA container layout, validation and CRC-32C, shared by the Android flasher and
 * (via stage 3) the iOS port of app/g2/firmware-ota.ts. Mirrors g2flash.py: a 0x40-byte
 * header (component count at +8), a 16-byte table-of-contents entry per component
 * (offset at +4, CRC at +12), and per component a 128-byte subheader (payload size at +8,
 * CRC at +12, NUL-terminated name at +48) followed by the payload.
 *
 * Validation takes the stricter of the two former implementations: the Android checks
 * (component count, CRC in both TOC and subheader, main-app preamble/MRAM ceiling) plus the
 * TypeScript ones (TOC/subheader/payload bounds, no overlapping components).
 */
object FirmwareImage {
    const val HEADER_SIZE = 0x40
    const val TOC_ENTRY_SIZE = 16
    const val SUBHEADER_SIZE = 128
    const val NAME_OFFSET = 48
    const val NAME_MAX = 80

    // Firmware 2.2.4 has 5 components; 2.2.6 has 6.
    const val MIN_SEGMENTS = 5
    const val MAX_SEGMENTS = 6
    const val REQUIRED_SEGMENT = "ota/s200_firmware_ota.bin"
    const val APP_LOAD_ADDR = 0x00438000L
    const val APP_MAX_END = 0x007F0000L
    const val APP_PREAMBLE = 0x20

    class Segment(
        /** Offset of the 128-byte subheader within the image. */
        @JvmField val off: Int,
        /** Payload size in bytes (payload starts at off + SUBHEADER_SIZE). */
        @JvmField val ps: Int,
        /** CRC-32C recorded in the table of contents. */
        @JvmField val crc: Long,
        @JvmField val name: String,
    ) {
        val payloadStart: Int get() = off + SUBHEADER_SIZE
        val end: Int get() = payloadStart + ps
    }

    private val CRC32C_TABLE: IntArray = IntArray(256).also { table ->
        for (b in 0 until 256) {
            var c = b shl 24
            for (i in 0 until 8) {
                c = if ((c and 0x80000000.toInt()) != 0) (c shl 1) xor 0x1edc6f41 else c shl 1
            }
            table[b] = c
        }
    }

    /** CRC-32C, MSB-first, init 0, no final xor (matches g2flash.py crc32c_msb). */
    @JvmStatic
    fun crc32cMsb(data: ByteArray, offset: Int = 0, length: Int = data.size - offset): Int {
        require(offset >= 0 && length >= 0 && offset + length <= data.size)
        var crc = 0
        for (i in offset until offset + length) {
            crc = (crc shl 8) xor CRC32C_TABLE[((crc ushr 24) xor (data[i].toInt() and 0xff)) and 0xff]
        }
        return crc
    }

    /** Unsigned CRC-32C as a Long, for comparison with recorded values. */
    @JvmStatic
    fun crc32cUnsigned(data: ByteArray, offset: Int = 0, length: Int = data.size - offset): Long =
        crc32cMsb(data, offset, length).toLong() and 0xffffffffL

    @JvmStatic
    fun readU32(buf: ByteArray, offset: Int): Long {
        if (offset < 0 || offset + 4 > buf.size) throw IllegalStateException("firmware header is truncated")
        return (buf[offset].toLong() and 0xffL) or
            ((buf[offset + 1].toLong() and 0xffL) shl 8) or
            ((buf[offset + 2].toLong() and 0xffL) shl 16) or
            ((buf[offset + 3].toLong() and 0xffL) shl 24)
    }

    @JvmStatic
    fun readCString(buf: ByteArray, offset: Int, maxLen: Int): String {
        var end = offset
        val limit = minOf(buf.size, offset + maxLen)
        while (end < limit && buf[end].toInt() != 0) end++
        return buildString(end - offset) { for (i in offset until end) append((buf[i].toInt() and 0xff).toChar()) }
    }

    /** Parses the table of contents without checking CRCs; throws on bounds violations. */
    @JvmStatic
    fun parseSegments(img: ByteArray): List<Segment> {
        if (img.size < HEADER_SIZE) throw IllegalStateException("file is too small to be a firmware image")
        val n = readU32(img, 8)
        if (n <= 0 || n > 64) throw IllegalStateException("implausible component count $n (corrupt image?)")
        val count = n.toInt()
        val tocEnd = HEADER_SIZE + count * TOC_ENTRY_SIZE
        if (tocEnd > img.size) throw IllegalStateException("table of contents runs past end of file")
        val segs = ArrayList<Segment>(count)
        for (i in 0 until count) {
            val base = HEADER_SIZE + i * TOC_ENTRY_SIZE
            val crc = readU32(img, base + 12)
            val offLong = readU32(img, base + 4)
            if (offLong < tocEnd || offLong + SUBHEADER_SIZE > img.size) {
                throw IllegalStateException("segment $i subheader is out of bounds")
            }
            val off = offLong.toInt()
            val psLong = readU32(img, off + 8)
            if (psLong <= 0 || off + SUBHEADER_SIZE + psLong > img.size) {
                throw IllegalStateException("segment $i payload is truncated")
            }
            val name = readCString(img, off + NAME_OFFSET, NAME_MAX)
            val seg = Segment(off, psLong.toInt(), crc, name)
            for (other in segs) {
                if (seg.off < other.end && other.off < seg.end) {
                    throw IllegalStateException("components ${other.name} and ${seg.name} overlap")
                }
            }
            segs.add(seg)
        }
        return segs
    }

    /** Full validation: layout, component count, CRCs, and the main-app preamble/MRAM check. */
    @JvmStatic
    fun validate(img: ByteArray): List<Segment> {
        val segs = parseSegments(img)
        if (segs.size < MIN_SEGMENTS || segs.size > MAX_SEGMENTS) {
            throw IllegalStateException("expected $MIN_SEGMENTS-$MAX_SEGMENTS components, found ${segs.size}")
        }
        var main: Segment? = null
        for (s in segs) {
            val calc = crc32cUnsigned(img, s.payloadStart, s.ps)
            val subCrc = readU32(img, s.off + 12)
            if (calc != s.crc || calc != subCrc) {
                throw IllegalStateException("component ${s.name} CRC32C is stale (image not checksum-fixed)")
            }
            if (REQUIRED_SEGMENT == s.name) {
                if (main != null) throw IllegalStateException("required component $REQUIRED_SEGMENT is duplicated")
                main = s
            }
        }
        if (main == null) throw IllegalStateException("required component $REQUIRED_SEGMENT not found")
        checkMainAppFitsMram(img, main)
        return segs
    }

    @JvmStatic
    fun checkMainAppFitsMram(img: ByteArray, main: Segment) {
        if (main.ps < APP_PREAMBLE) throw IllegalStateException("main-app payload is smaller than its preamble")
        val loadAddr = readU32(img, main.payloadStart + 0x14)
        val preLen = readU32(img, main.payloadStart) and 0xFFFFFFL
        if (loadAddr != APP_LOAD_ADDR) {
            throw IllegalStateException(
                "main-app preamble load address is 0x" + loadAddr.toString(16) +
                    ", expected 0x" + APP_LOAD_ADDR.toString(16))
        }
        if (preLen != main.ps.toLong()) {
            throw IllegalStateException("main-app preamble length ($preLen) != staged payload size (${main.ps})")
        }
        val progEnd = APP_LOAD_ADDR + main.ps - APP_PREAMBLE
        if (progEnd > APP_MAX_END) {
            val over = progEnd - APP_MAX_END
            throw IllegalStateException(
                "main-app is too large: programmed region ends at 0x" + progEnd.toString(16) +
                    ", " + over + " bytes past the safe MRAM ceiling — refusing to flash (brick risk)")
        }
    }
}
