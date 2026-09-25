package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class GlyphAndIconSourceTest {
    private fun u16(bytes: ByteArray, at: Int) = (bytes[at].toInt() and 0xff) or ((bytes[at + 1].toInt() and 0xff) shl 8)
    private fun s16(bytes: ByteArray, at: Int) = u16(bytes, at).toShort().toInt()

    // 6x4 raster: ink in columns 2..4, rows 1..2, one 128 edge pixel.
    private val raster = byteArrayOf(
        0, 0, 0, 0, 0, 0,
        0, 0, -1, -1, 0, 0,
        0, 0, 0, -1, 0x7f, 0,
        0, 0, 0, 0, 0, 0,
    )

    @Test
    fun gammaLutIsIdentityAtOneAndDarkensAboveOne() {
        val linear = GlyphPacket.gammaLut(1.0)
        for (i in 0 until 256) assertEquals(i, linear[i].toInt() and 0xff)
        assertContentEquals(linear, GlyphPacket.gammaLut(0.0))
        val squared = GlyphPacket.gammaLut(2.0)
        assertEquals(64, squared[128].toInt() and 0xff)
        assertEquals(255, squared[255].toInt() and 0xff)
    }

    @Test
    fun inkScansFindPaintedBoxes() {
        assertContentEquals(intArrayOf(2, 4), GlyphPacket.paintedColumnRange(raster, 6, 4))
        assertContentEquals(intArrayOf(2, 1, 4, 2), GlyphPacket.inkBounds(raster, 6, 4))
        assertNull(GlyphPacket.paintedColumnRange(ByteArray(12), 4, 3))
        assertNull(GlyphPacket.inkBounds(ByteArray(12), 4, 3))
    }

    @Test
    fun imagePacketsCarryLittleEndianHeaderAndGammaMappedRegion() {
        val whole = GlyphPacket.packImage(raster, 6, 4, 1.0)
        assertEquals(4 + 24, whole.size)
        assertEquals(6, u16(whole, 0))
        assertEquals(4, u16(whole, 2))
        assertContentEquals(raster, whole.copyOfRange(4, whole.size))
        val region = GlyphPacket.packImageRegion(raster, 6, 2, 1, 3, 2, 2.0)
        assertEquals(3, u16(region, 0))
        assertEquals(2, u16(region, 2))
        assertContentEquals(byteArrayOf(-1, -1, 0, 0, -1, 63), region.copyOfRange(4, region.size))
    }

    @Test
    fun glyphCellPacketsCropToInkAndEncodeSignedOffsets() {
        val cell = GlyphPacket.packGlyphCell(GlyphPacket.advanceFixed(5.5), raster, 6, 4, penX = 3, baselineY = 3, ascent = 10, gamma = 1.0)
        assertEquals(352, u16(cell, 0))
        assertEquals(-1, s16(cell, 2)) // ink starts one pixel left of the pen
        assertEquals(8, s16(cell, 4)) // ascent 10, ink top two rows above the baseline
        assertEquals(3, u16(cell, 6))
        assertEquals(2, u16(cell, 8))
        assertContentEquals(byteArrayOf(-1, -1, 0, 0, -1, 0x7f), cell.copyOfRange(10, cell.size))
        val empty = GlyphPacket.packGlyphCell(64, ByteArray(12), 4, 3, 0, 0, 10, 1.0)
        assertContentEquals(byteArrayOf(64, 0, 0, 0, 0, 0, 0, 0, 0, 0), empty)
        assertEquals(0xffff, GlyphPacket.advanceFixed(5000.0))
    }

    private fun nameTable(vararg records: Triple<Int, Int, String>): ByteArray {
        // records: (platformId, nameId, value); platform 1 stored Latin-1, others UTF-16BE
        val strings = ArrayList<ByteArray>()
        for ((platform, _, value) in records) {
            strings.add(if (platform == 1) ByteArray(value.length) { value[it].code.toByte() }
                else ByteArray(value.length * 2) { if (it % 2 == 0) (value[it / 2].code shr 8).toByte() else value[it / 2].code.toByte() })
        }
        val out = ByteSink()
        fun u16(v: Int) { out.write(v ushr 8); out.write(v) }
        fun u32(v: Int) { u16(v ushr 16); u16(v and 0xffff) }
        val nameOffset = 12 + 16
        val nameLength = 6 + records.size * 12 + strings.sumOf { it.size }
        u32(0x00010000); u16(1); u16(0); u16(0); u16(0) // offset table, 1 table
        u32(0x6e616d65); u32(0); u32(nameOffset); u32(nameLength) // 'name' record
        u16(0); u16(records.size); u16(6 + records.size * 12)
        var offset = 0
        for ((i, record) in records.withIndex()) {
            u16(record.first); u16(0); u16(0); u16(record.second); u16(strings[i].size); u16(offset)
            offset += strings[i].size
        }
        for (s in strings) out.write(s)
        return out.toByteArray()
    }

    @Test
    fun openTypeNamesPreferTypographicFamilyAndStyle() {
        assertEquals("Roboto\nLight", OpenTypeNames.parse(nameTable(Triple(3, 1, "Roboto Light"), Triple(3, 2, "Regular"), Triple(3, 16, "Roboto"), Triple(1, 17, "Light"))))
        assertEquals("Mono\n", OpenTypeNames.parse(nameTable(Triple(1, 1, " Mono "))))
        assertEquals("", OpenTypeNames.parse(nameTable(Triple(3, 2, "Bold"))))
        assertEquals("", OpenTypeNames.parse(ByteArray(8)))
    }

    @Test
    fun svgIconsParseShapesStrokeRuleAndPlacement() {
        val svg = """<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/>
            <circle cx="12" cy="12" r="0"/><circle cx="12" cy="12" r="3"/><path d="M4 4h16"/><polygon points="1,2 3 4 5"/><line x1="0" y1="0" x2="1" y2="1"/></svg>"""
        val icon = SvgIconSource.parse(svg)!!
        assertTrue(icon.stroked)
        assertEquals(listOf("Rect", "Circle", "PathData", "Polyline", "Line"), icon.shapes.map { it::class.simpleName })
        val rect = icon.shapes[0] as SvgShape.Rect
        assertEquals(2f, rect.rx); assertEquals(2f, rect.ry)
        assertEquals(3f, (icon.shapes[1] as SvgShape.Circle).r)
        assertEquals("M4 4h16", (icon.shapes[2] as SvgShape.PathData).d)
        val polygon = icon.shapes[3] as SvgShape.Polyline
        assertContentEquals(floatArrayOf(1f, 2f, 3f, 4f), polygon.points)
        assertTrue(polygon.closed)
        assertContentEquals(floatArrayOf(0f, 0f, 2f), icon.placement(48))
        val filled = SvgIconSource.parse("""<svg viewBox="-2 0 40 20"><rect width="4" height="2"/></svg>""")!!
        assertTrue(!filled.stroked)
        assertContentEquals(floatArrayOf(0f, 5f, 0.5f), filled.placement(20))
        assertEquals(-2f, filled.minX)
        assertNull(SvgIconSource.parse("""<svg><circle r="0"/><rect width="0" height="3"/></svg>"""))
    }

    @Test
    fun coverageQuantizesToThreeLevels() {
        assertEquals(0, SvgIconSource.quantizeCoverage(63))
        assertEquals(128, SvgIconSource.quantizeCoverage(64))
        assertEquals(128, SvgIconSource.quantizeCoverage(191))
        assertEquals(255, SvgIconSource.quantizeCoverage(192))
        assertContentEquals(byteArrayOf(0, -128, -1), SvgIconSource.quantizeArgb(intArrayOf(0x10ffffff, 0x80000000.toInt(), 0xff000000.toInt())))
    }
}
