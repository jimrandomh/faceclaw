package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class FirmwareImageTest {
    private fun putU32(buf: ByteArray, offset: Int, value: Long) {
        for (i in 0 until 4) buf[offset + i] = ((value ushr (8 * i)) and 0xff).toByte()
    }

    private class Component(val name: String, val payload: ByteArray)

    /** Builds a checksum-fixed container; [tamper] runs before the CRCs are recorded. */
    private fun container(components: List<Component>, tamper: (ByteArray) -> Unit = {}): ByteArray {
        val count = components.size
        val toc = FirmwareImage.HEADER_SIZE + count * FirmwareImage.TOC_ENTRY_SIZE
        var offset = toc
        val offsets = components.map { c -> offset.also { offset += FirmwareImage.SUBHEADER_SIZE + c.payload.size } }
        val img = ByteArray(offset)
        putU32(img, 8, count.toLong())
        components.forEachIndexed { i, c ->
            val off = offsets[i]
            putU32(img, FirmwareImage.HEADER_SIZE + i * 16 + 4, off.toLong())
            putU32(img, off + 8, c.payload.size.toLong())
            c.name.encodeToByteArray().copyInto(img, off + FirmwareImage.NAME_OFFSET)
            c.payload.copyInto(img, off + FirmwareImage.SUBHEADER_SIZE)
        }
        tamper(img)
        components.forEachIndexed { i, c ->
            val off = offsets[i]
            val crc = FirmwareImage.crc32cUnsigned(img, off + FirmwareImage.SUBHEADER_SIZE, c.payload.size)
            putU32(img, FirmwareImage.HEADER_SIZE + i * 16 + 12, crc)
            putU32(img, off + 12, crc)
        }
        return img
    }

    private fun mainApp(size: Int): ByteArray {
        val payload = ByteArray(size) { (it * 7).toByte() }
        putU32(payload, 0, size.toLong())
        putU32(payload, 0x14, FirmwareImage.APP_LOAD_ADDR)
        return payload
    }

    private fun validComponents(): List<Component> =
        listOf(
            Component("ota/bootloader.bin", ByteArray(300) { it.toByte() }),
            Component("ota/a.bin", ByteArray(64) { 1 }),
            Component("ota/b.bin", ByteArray(128) { 2 }),
            Component("ota/c.bin", ByteArray(32) { 3 }),
            Component(FirmwareImage.REQUIRED_SEGMENT, mainApp(600)),
        )

    @Test
    fun crc32cMatchesKnownVector() {
        // Castagnoli polynomial, MSB-first, init 0, no reflection or final xor (g2flash.py
        // crc32c_msb); vectors from an independent Python implementation of that definition.
        assertEquals(0xc052a8c8L, FirmwareImage.crc32cUnsigned("123456789".encodeToByteArray()))
        assertEquals(0xd7b91914L, FirmwareImage.crc32cUnsigned(ByteArray(256) { it.toByte() }))
        assertEquals(0L, FirmwareImage.crc32cUnsigned(ByteArray(0)))
        assertEquals(FirmwareImage.crc32cUnsigned("23456789".encodeToByteArray()), FirmwareImage.crc32cUnsigned("123456789".encodeToByteArray(), 1, 8))
    }

    @Test
    fun validImageParsesAllComponents() {
        val segs = FirmwareImage.validate(container(validComponents()))
        assertEquals(5, segs.size)
        assertEquals(listOf(300, 64, 128, 32, 600), segs.map { it.ps })
        assertEquals(FirmwareImage.REQUIRED_SEGMENT, segs[4].name)
        assertTrue(segs.zipWithNext().all { (a, b) -> a.end <= b.off })
    }

    @Test
    fun rejectsStaleCrc() {
        val img = container(validComponents())
        img[img.size - 1] = (img[img.size - 1] + 1).toByte()
        assertTrue(assertFailsWith<IllegalStateException> { FirmwareImage.validate(img) }.message!!.contains("CRC32C"))
    }

    @Test
    fun rejectsOverlappingComponents() {
        val img = container(validComponents()) { buf ->
            // Point component 1's TOC entry at component 0, so both claim the same bytes.
            val off0 = FirmwareImage.readU32(buf, FirmwareImage.HEADER_SIZE + 4)
            putU32(buf, FirmwareImage.HEADER_SIZE + 16 + 4, off0)
        }
        assertTrue(assertFailsWith<IllegalStateException> { FirmwareImage.parseSegments(img) }.message!!.contains("overlap"))
    }

    @Test
    fun rejectsTruncatedPayload() {
        val img = container(validComponents())
        val truncated = img.copyOf(img.size - 10)
        assertTrue(assertFailsWith<IllegalStateException> { FirmwareImage.parseSegments(truncated) }.message!!.contains("truncated"))
        assertFailsWith<IllegalStateException> { FirmwareImage.parseSegments(ByteArray(0x10)) }
    }

    @Test
    fun rejectsWrongComponentCountAndMissingMain() {
        val four = validComponents().dropLast(1)
        assertTrue(assertFailsWith<IllegalStateException> { FirmwareImage.validate(container(four)) }.message!!.contains("components"))
        val noMain = validComponents().dropLast(1) + Component("ota/other.bin", ByteArray(40))
        assertTrue(assertFailsWith<IllegalStateException> { FirmwareImage.validate(container(noMain)) }.message!!.contains("not found"))
    }

    @Test
    fun rejectsMainAppBeyondMramCeiling() {
        val ceiling = (FirmwareImage.APP_MAX_END - FirmwareImage.APP_LOAD_ADDR + FirmwareImage.APP_PREAMBLE).toInt()
        val fits = validComponents().dropLast(1) + Component(FirmwareImage.REQUIRED_SEGMENT, mainApp(ceiling))
        FirmwareImage.validate(container(fits))
        val tooBig = validComponents().dropLast(1) + Component(FirmwareImage.REQUIRED_SEGMENT, mainApp(ceiling + 1))
        assertTrue(assertFailsWith<IllegalStateException> { FirmwareImage.validate(container(tooBig)) }.message!!.contains("MRAM"))
        val badAddr = validComponents().dropLast(1) + Component(FirmwareImage.REQUIRED_SEGMENT, mainApp(600).also { putU32(it, 0x14, 0x1234L) })
        assertTrue(assertFailsWith<IllegalStateException> { FirmwareImage.validate(container(badAddr)) }.message!!.contains("load address"))
    }
}
