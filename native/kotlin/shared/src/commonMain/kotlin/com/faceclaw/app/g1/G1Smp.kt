package com.faceclaw.app

import kotlin.jvm.JvmField

/** The part of CBOR that MCUmgr uses: integers, byte and text strings, arrays, maps, booleans and null. */
object G1Cbor {
    fun encode(value: Any?): ByteArray {
        val out = Output()
        write(out, value)
        return out.toByteArray()
    }

    fun decode(data: ByteArray, start: Int = 0): Any? = Reader(data, start).value()

    private class Output {
        private var bytes = ByteArray(256)
        private var size = 0

        private fun reserve(extra: Int) {
            if (size + extra > bytes.size) bytes = bytes.copyOf(maxOf(bytes.size * 2, size + extra))
        }

        fun add(byte: Int) {
            reserve(1)
            bytes[size++] = byte.toByte()
        }

        fun add(data: ByteArray) {
            reserve(data.size)
            data.copyInto(bytes, size)
            size += data.size
        }

        fun toByteArray(): ByteArray = bytes.copyOf(size)
    }

    private fun head(out: Output, major: Int, n: Long) {
        val first = major shl 5
        val width = when {
            n < 24 -> {
                out.add(first or n.toInt())
                return
            }
            n < 0x100L -> 1
            n < 0x10000L -> 2
            n < 0x100000000L -> 4
            else -> 8
        }
        out.add(first or (24 + width.countTrailingZeroBits()))
        for (i in width - 1 downTo 0) out.add(((n ushr (8 * i)) and 0xff).toInt())
    }

    private fun write(out: Output, value: Any?) {
        when (value) {
            null -> out.add(0xf6)
            is Boolean -> out.add(if (value) 0xf5 else 0xf4)
            is Int -> write(out, value.toLong())
            is Long -> if (value >= 0) head(out, 0, value) else head(out, 1, -1 - value)
            is ByteArray -> {
                head(out, 2, value.size.toLong())
                out.add(value)
            }
            is String -> {
                val text = value.encodeToByteArray()
                head(out, 3, text.size.toLong())
                out.add(text)
            }
            is List<*> -> {
                head(out, 4, value.size.toLong())
                for (item in value) write(out, item)
            }
            is Map<*, *> -> {
                head(out, 5, value.size.toLong())
                for ((key, item) in value) {
                    write(out, key)
                    write(out, item)
                }
            }
            else -> throw IllegalArgumentException("not CBOR: $value")
        }
    }

    private class Reader(private val data: ByteArray, private var at: Int) {
        private fun u8(): Int {
            if (at >= data.size) throw IllegalArgumentException("CBOR cut short")
            return data[at++].toInt() and 0xff
        }

        fun value(): Any? {
            val first = u8()
            val major = first ushr 5
            val info = first and 31
            val n: Long? = when {
                info < 24 -> info.toLong()
                info in 24..27 -> {
                    var v = 0L
                    repeat(1 shl (info - 24)) { v = (v shl 8) or u8().toLong() }
                    v
                }
                info == 31 -> null
                else -> throw IllegalArgumentException("bad CBOR header $first")
            }
            return when (major) {
                0 -> n ?: throw IllegalArgumentException("bad CBOR integer")
                1 -> -1 - (n ?: throw IllegalArgumentException("bad CBOR integer"))
                2, 3 -> {
                    val size = (n ?: throw IllegalArgumentException("indefinite CBOR string")).toInt()
                    if (size < 0 || at + size > data.size) throw IllegalArgumentException("CBOR cut short")
                    val bytes = data.copyOfRange(at, at + size)
                    at += size
                    if (major == 2) bytes else bytes.decodeToString()
                }
                4 -> {
                    val items = ArrayList<Any?>()
                    while (more(n, items.size)) items.add(value())
                    if (n == null) at++
                    items
                }
                5 -> {
                    val items = LinkedHashMap<Any?, Any?>()
                    while (more(n, items.size)) {
                        val key = value()
                        items[key] = value()
                    }
                    if (n == null) at++
                    items
                }
                7 -> when (info) {
                    20 -> false
                    21 -> true
                    22 -> null
                    else -> throw IllegalArgumentException("unsupported CBOR simple value $info")
                }
                else -> throw IllegalArgumentException("unsupported CBOR major type $major")
            }
        }

        /** An indefinite-length array or map (what Zephyr's image list uses) ends at a 0xFF. */
        private fun more(n: Long?, count: Int): Boolean {
            if (n != null) return count < n
            if (at >= data.size) throw IllegalArgumentException("CBOR cut short")
            return (data[at].toInt() and 0xff) != 0xff
        }
    }
}

/**
 * MCUmgr SMP, the update service of both Even's firmware and g1v0: as much of it as installing an image takes, and what
 * an MCUboot image says about itself. The same requests as scouter_kit's tools/g1host.py (class Smp), which was proven on
 * real arms first.
 */
object G1Smp {
    const val SMP_CHAR_UUID = "da2e7828-fbce-4e01-ae9e-261174997c48"
    const val NUS_RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
    const val NUS_TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

    const val OP_READ = 0
    const val OP_WRITE = 2
    const val GROUP_OS = 0
    const val GROUP_IMAGE = 1
    const val CMD_IMAGE_STATE = 0
    const val CMD_IMAGE_UPLOAD = 1
    const val CMD_OS_RESET = 5
    const val UPLOAD_CHUNK = 2048
    private const val HEADER = 8

    /** Even's firmware drops a link it hears no heartbeat on. */
    fun stockHeartbeat(seq: Int): ByteArray =
        byteArrayOf(0x25, 0x06, 0x00, seq.toByte(), 0x04, seq.toByte())

    /** Even's firmware's battery query; its reply is `2C 66`, then the percentage. The bytes its real firmware answered in emulation. */
    val STOCK_BATTERY_QUERY = byteArrayOf(0x2c, 0x04, 0x00, 0x00)

    /** The percentage in a reply to [STOCK_BATTERY_QUERY]; null for anything else, or a value that can't be one. */
    fun parseStockBattery(data: ByteArray): Int? {
        if (data.size < 3 || data[0].toInt() != 0x2c || (data[1].toInt() and 0xff) != 0x66) return null
        return (data[2].toInt() and 0xff).takeIf { it in 1..100 }
    }

    fun frame(op: Int, group: Int, seq: Int, cmd: Int, payload: Map<String, Any?>): ByteArray {
        val body = G1Cbor.encode(payload)
        val out = ByteArray(HEADER + body.size)
        out[0] = op.toByte()
        out[2] = (body.size ushr 8).toByte()
        out[3] = body.size.toByte()
        out[4] = (group ushr 8).toByte()
        out[5] = group.toByte()
        out[6] = seq.toByte()
        out[7] = cmd.toByte()
        body.copyInto(out, HEADER)
        return out
    }

    /** One ATT write at most [mtu] - 3 bytes long; MCUmgr joins them again. */
    fun split(frame: ByteArray, mtu: Int): List<ByteArray> {
        val size = maxOf(mtu - 3, 20)
        return (frame.indices step size).map { frame.copyOfRange(it, minOf(it + size, frame.size)) }
    }

    /** The first chunk also says what is coming, which lets the arm resume an upload of the same file. */
    fun uploadRequest(image: ByteArray, offset: Int, fileSha256: ByteArray): Map<String, Any?> {
        val data = image.copyOfRange(offset, minOf(offset + UPLOAD_CHUNK, image.size))
        return if (offset == 0) {
            mapOf("image" to 0, "len" to image.size, "off" to 0, "sha" to fileSha256, "data" to data, "upgrade" to false)
        } else {
            mapOf("off" to offset, "data" to data)
        }
    }

    fun confirmRequest(imageHash: ByteArray): Map<String, Any?> = mapOf("hash" to imageHash, "confirm" to true)

    /** Joins notifications into replies; [feed] gives each complete one as sequence number and body. */
    class Assembler {
        private var pending = ByteArray(0)

        fun reset() {
            pending = ByteArray(0)
        }

        fun feed(data: ByteArray): List<Pair<Int, Map<*, *>>> {
            pending += data
            val replies = ArrayList<Pair<Int, Map<*, *>>>()
            while (pending.size >= HEADER) {
                val size = ((pending[2].toInt() and 0xff) shl 8) or (pending[3].toInt() and 0xff)
                if (pending.size < HEADER + size) break
                val seq = pending[6].toInt() and 0xff
                val body = try {
                    if (size == 0) emptyMap<Any?, Any?>() else G1Cbor.decode(pending, HEADER) as? Map<*, *>
                } catch (e: IllegalArgumentException) {
                    null
                }
                if (body == null) {
                    // A frame cut by a lost link: the request is sent again.
                    pending = ByteArray(0)
                    break
                }
                pending = pending.copyOfRange(HEADER + size, pending.size)
                replies.add(seq to body)
            }
            return replies
        }
    }

    class Slot(
        @JvmField val image: Int,
        @JvmField val slot: Int,
        @JvmField val version: String,
        @JvmField val hash: ByteArray,
        @JvmField val flags: List<String>,
    ) {
        override fun toString(): String =
            "image $image slot $slot: $version ${BinaryEncoding.bytesToHex(hash.copyOf(minOf(8, hash.size)))} ${flags.joinToString(" ")}".trim()
    }

    fun parseSlots(reply: Map<*, *>): List<Slot> {
        val images = reply["images"] as? List<*> ?: return emptyList()
        return images.mapNotNull { item ->
            val entry = item as? Map<*, *> ?: return@mapNotNull null
            val hash = entry["hash"] as? ByteArray ?: return@mapNotNull null
            Slot((entry["image"] as? Long ?: 0L).toInt(), (entry["slot"] as? Long ?: -1L).toInt(), entry["version"] as? String ?: "?", hash,
                listOf("bootable", "pending", "confirmed", "active", "permanent").filter { entry[it] == true })
        }
    }

    fun replyCode(reply: Map<*, *>): Int = (reply["rc"] as? Long ?: 0L).toInt()

    fun replyOffset(reply: Map<*, *>): Int? = (reply["off"] as? Long)?.toInt()

    /** The dotted version in an MCUboot header. */
    fun imageVersion(image: ByteArray): String {
        requireImage(image)
        val revision = (image[22].toInt() and 0xff) or ((image[23].toInt() and 0xff) shl 8)
        return "${image[20].toInt() and 0xff}.${image[21].toInt() and 0xff}.$revision"
    }

    /** The SHA-256 TLV: how MCUmgr names an image. */
    fun imageHash(image: ByteArray): ByteArray {
        requireImage(image)
        var at = u16(image, 8) + u32(image, 12)
        require(at + 4 <= image.size && u16(image, at) == 0x6907) { "the image has no TLV area" }
        val end = at + u16(image, at + 2)
        require(end <= image.size) { "the image's TLV area is cut short" }
        at += 4
        while (at + 4 <= end) {
            val type = u16(image, at)
            val size = u16(image, at + 2)
            if (type == 0x10 && size == 32 && at + 4 + size <= end) return image.copyOfRange(at + 4, at + 4 + size)
            at += 4 + size
        }
        throw IllegalArgumentException("the image has no SHA-256 TLV")
    }

    private fun requireImage(image: ByteArray) {
        require(image.size > 32 && u32(image, 0) == 0x96f3b83d.toInt()) { "not an MCUboot image" }
    }

    private fun u16(data: ByteArray, at: Int): Int = (data[at].toInt() and 0xff) or ((data[at + 1].toInt() and 0xff) shl 8)

    private fun u32(data: ByteArray, at: Int): Int = u16(data, at) or (u16(data, at + 2) shl 16)
}
