package com.faceclaw.app

import kotlin.jvm.JvmField

/** The GATT service of g1v0, the firmware of an Even G1 (scouter_kit g1_firmware/docs/VM.md §6.1). */
object G1Ble {
    const val CTRL_CHAR_UUID = "f3da4d59-277a-4fc9-a1ed-41c9c22d4402"
    const val EVT_CHAR_UUID = "f3da4d59-277a-4fc9-a1ed-41c9c22d4403"
    /** Readable and writable only on an encrypted link: a write with response makes the OS pair, then proves the link is encrypted. */
    const val PAIR_CHAR_UUID = "f3da4d59-277a-4fc9-a1ed-41c9c22d4404"
    /** Faceclaw's records (VM.md §6.11). */
    const val FC_CHAR_UUID = "f3da4d59-277a-4fc9-a1ed-41c9c22d4405"
    /** The iPhone notification relay (VM.md §6.12): the G2's `AN` commands and frames, with this characteristic to itself. */
    const val ANCS_CHAR_UUID = "f3da4d59-277a-4fc9-a1ed-41c9c22d4406"
    const val REQUESTED_MTU = 247
    /** The oldest firmware this app works with: `PROP_SET` came in here. */
    const val REQUIRED_FIRMWARE = "0.5.63"

    /** Dotted versions, component by component. */
    fun firmwareAtLeast(version: String, required: String = REQUIRED_FIRMWARE): Boolean {
        val have = version.split(".").map { it.toIntOrNull() ?: 0 }
        val want = required.split(".").map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(have.size, want.size)) {
            val delta = have.getOrElse(i) { 0 } - want.getOrElse(i) { 0 }
            if (delta != 0) return delta > 0
        }
        return true
    }
}

/**
 * The wire formats of an Even G1 on g1v0: control requests and events (VM.md §6.3, §6.4), which Faceclaw uses as they
 * are, and the display path's packets and answers (§6.11). No VM instruction is sent; the records inside the packets
 * are [CfwTransport]'s, the same as on the G2.
 */
object G1Protocol {
    const val OP_HELLO = 0x01
    const val OP_HEALTH_OK = 0x07
    const val OP_PROPS = 0x0A
    const val OP_MIC = 0x13
    const val OP_EVENTS = 0x14
    const val OP_ASSET_INFO = 0x17
    const val OP_ASSET_FORMAT = 0x1B
    const val OP_FLASH_CRC = 0x1C
    const val OP_FC_INFO = 0x1D
    const val OP_PROP_SET = 0x1E

    /** Control statuses (VM.md §1). */
    const val STATUS_SAFE_MODE = 7
    /** A store request: a job runs, no space, no store. */
    const val STATUS_ASSET = 13

    const val EV_NOTICE = 0x05
    const val EV_MIC_DATA = 0x06
    const val EV_INPUT = 0x07
    const val EV_FC_ACK = 0x08
    private const val EV_REPLY = 0x80
    private const val EVENT_HEADER = 9
    private const val OPT_START = 0x80
    private const val OPT_END = 0x40
    private const val MAX_PACKET = 244
    private const val PACKET_HEADER = 2

    /** The light sensor converts only while something uses it, as this bit of `EVENTS` does; the left arm has none. */
    const val TRIGGER_LIGHT = 4
    const val TRIGGER_BATTERY = 5
    const val TRIGGER_CASE = 6
    const val TRIGGER_WEAR = 7
    const val TRIGGER_TOUCH = 8
    const val EVENTS_MASK = (1 shl TRIGGER_LIGHT) or (1 shl TRIGGER_BATTERY) or (1 shl TRIGGER_CASE) or
        (1 shl TRIGGER_WEAR) or (1 shl TRIGGER_TOUCH)

    const val NOTICE_MIC_STOPPED = 5
    const val MIC_STOPPED_LEASE = 3
    const val NOTICE_GUARD = 7
    /** A store job ended (VM.md §6.10). */
    const val NOTICE_STORE_JOB = 8

    const val STORE_JOB_FORMAT = 3
    const val STORE_JOB_CRC = 4
    /** `ASSET_INFO`'s job states. */
    const val STORE_IDLE = 0
    const val STORE_DONE = 4
    const val STORE_FAILED = 5
    /** The asset store's partition in the arm's QSPI flash, where Even's fonts and pictures were; its first two sectors hold its directory. */
    const val STORE_ADDRESS = 0x140000
    const val STORE_DIRECTORY_BYTES = 2 * 4096

    const val PROP_BATT_PCT = 0x11
    const val PROP_CHARGE = 0x12
    const val PROP_IN_CASE = 0x13
    const val PROP_WORN = 0x14
    const val PROP_ACC_X = 0x18
    const val PROP_ACC_Y = 0x19
    const val PROP_ACC_Z = 0x1A
    /** 0.01 lux, on the right arm, while the panel is on. */
    const val PROP_LIGHT = 0x1C
    const val PROP_IMU_RATE = 0x28
    const val PROP_BRIGHTNESS_MAX = 0x29
    const val IMU_RATE_IDLE = 13
    const val IMU_RATE_STREAM = 26
    const val BRIGHTNESS_LEVEL_MAX = 42
    /** A property without a value yet (VM_UNKNOWN). */
    const val UNKNOWN = Int.MIN_VALUE

    const val CHARGE_CHARGING = 1

    const val GESTURE_TAP = 1
    const val GESTURE_DOUBLE_TAP = 2
    const val GESTURE_TRIPLE_TAP = 3
    const val GESTURE_LONG_START = 4
    const val GESTURE_LONG_END = 5

    /** The packets of one record: `[0x80 first | 0x40 last][stream][the next bytes]`. */
    fun packets(record: ByteArray, stream: Int, mtu: Int): List<ByteArray> {
        val chunk = minOf(mtu - 3, MAX_PACKET) - PACKET_HEADER
        require(record.isNotEmpty() && chunk >= 5 && stream in 0..255)
        val packets = ArrayList<ByteArray>(record.size / chunk + 1)
        var offset = 0
        while (offset < record.size) {
            val count = minOf(chunk, record.size - offset)
            val packet = ByteArray(PACKET_HEADER + count)
            packet[0] = ((if (offset == 0) OPT_START else 0) or (if (offset + count == record.size) OPT_END else 0)).toByte()
            packet[1] = stream.toByte()
            record.copyInto(packet, PACKET_HEADER, offset, offset + count)
            packets.add(packet)
            offset += count
        }
        return packets
    }

    fun control(op: Int, tag: Int, body: ByteArray = ByteArray(0)): ByteArray =
        byteArrayOf(op.toByte(), tag.toByte()) + body

    fun eventsRequest(mask: Int): ByteArray = byteArrayOf(mask.toByte(), (mask ushr 8).toByte())

    /** `PROP_SET` (0.5.63+): what SYS_WRITE does, for a host that runs no instructions. */
    fun propSet(id: Int, value: Int): ByteArray =
        byteArrayOf(id.toByte(), value.toByte(), (value ushr 8).toByte(), (value ushr 16).toByte(), (value ushr 24).toByte())

    /** On, or a renewal of the lease; 32 kbps, the rate [Lc3PacketFramer] decodes. */
    fun micRequest(on: Boolean): ByteArray = byteArrayOf(if (on) 1 else 0, 0)

    /** An event's type, or -1 for bytes too short to be one. */
    fun eventType(data: ByteArray): Int = if (data.size >= EVENT_HEADER) data[0].toInt() and 255 else -1

    class Reply(@JvmField val op: Int, @JvmField val tag: Int, @JvmField val status: Int, @JvmField val body: ByteArray)

    fun parseReply(data: ByteArray): Reply? {
        val type = eventType(data)
        if (type < EV_REPLY || data.size < EVENT_HEADER + 2) return null
        return Reply(type and 0x7f, data[EVENT_HEADER].toInt() and 255, data[EVENT_HEADER + 1].toInt() and 255,
            data.copyOfRange(EVENT_HEADER + 2, data.size))
    }

    /** Same shape as [CfwTransport.parseAcks]'s, so the shared window takes it. */
    fun parseFcAck(data: ByteArray): CfwTransport.Ack? {
        if (eventType(data) != EV_FC_ACK || data.size < EVENT_HEADER + 9) return null
        val kind = data[EVENT_HEADER].toInt() and 255
        if (kind != 1 && kind != 3) return null
        return CfwTransport.Ack(kind == 3, data[EVENT_HEADER + 1].toInt() and 255, u16(data, EVENT_HEADER + 2),
            data[EVENT_HEADER + 4].toInt() and 255, u16(data, EVENT_HEADER + 5), u16(data, EVENT_HEADER + 7))
    }

    class Input(@JvmField val trigger: Int, @JvmField val value: Int)

    fun parseInput(data: ByteArray): Input? {
        if (eventType(data) != EV_INPUT || data.size < EVENT_HEADER + 7) return null
        return Input(data[EVENT_HEADER + 2].toInt() and 255, u32(data, EVENT_HEADER + 3))
    }

    class Notice(@JvmField val kind: Int, @JvmField val body: ByteArray)

    fun parseNotice(data: ByteArray): Notice? {
        if (eventType(data) != EV_NOTICE || data.size < EVENT_HEADER + 1) return null
        return Notice(data[EVENT_HEADER].toInt() and 255, data.copyOfRange(EVENT_HEADER + 1, data.size))
    }

    /** `ASSET_FORMAT` frees the whole store; with [wipe] it also erases every sector that isn't erased already. */
    fun assetFormatRequest(wipe: Boolean): ByteArray =
        le32(0x534B4153) + if (wipe) le32(0x50570000) else ByteArray(0)

    /** `FLASH_CRC`: a read-only fingerprint of flash bytes address…address + n - 1, given in `NOTICE` 8. */
    fun flashCrcRequest(address: Int, n: Int): ByteArray = le32(address) + le32(n)

    class AssetInfo(
        @JvmField val assets: Int,
        @JvmField val state: Int,
        @JvmField val lastError: Int,
        /** Without a usable flash there is no store, and nothing was ever written to it. */
        @JvmField val available: Boolean,
        /** The directory's commit count: 0 for a store that is empty and never was written, or was formatted since. */
        @JvmField val seq: Long,
    ) {
        val running: Boolean get() = state in 1..3
    }

    fun parseAssetInfo(body: ByteArray): AssetInfo? {
        if (body.size < 20) return null
        return AssetInfo(body[12].toInt() and 255, body[13].toInt() and 255, body[14].toInt() and 255, body[15].toInt() and 1 != 0,
            u32(body, 16).toLong() and 0xffffffffL)
    }

    class StoreNotice(
        @JvmField val job: Int,
        @JvmField val result: Int,
        /** A crc job's range, crc32 and how many of its bytes are not 0xFF; 0 for the other jobs. */
        @JvmField val address: Int,
        @JvmField val n: Int,
        @JvmField val nonErased: Long,
    )

    fun parseStoreNotice(data: ByteArray): StoreNotice? {
        val notice = parseNotice(data) ?: return null
        val body = notice.body
        if (notice.kind != NOTICE_STORE_JOB || body.size < 18) return null
        return StoreNotice(body[0].toInt() and 255, body[1].toInt() and 255, u32(body, 2), u32(body, 6), u32(body, 14).toLong() and 0xffffffffL)
    }

    private fun le32(value: Int): ByteArray =
        byteArrayOf(value.toByte(), (value ushr 8).toByte(), (value ushr 16).toByte(), (value ushr 24).toByte())

    /**
     * What the arm's light reading looks like to [BrightnessPolicy] and the Developer app: a live passive poll in the
     * G2 custom firmware's report (settings field 105), whose value counts tenths of a lux.
     */
    fun alsReport(centilux: Int, brightness: Int, tickMs: Long): ByteArray {
        val report = ByteArray(24)
        report[0] = 0x41
        report[1] = 0x4c
        report[2] = 1
        report[3] = 2    // a poll
        report[4] = 0x0b // opened, passive, read ok
        report[5] = 3    // polling
        val tenths = centilux / 10
        for (i in 0..3) {
            report[6 + i] = (tenths ushr (8 * i)).toByte()
            report[10 + i] = (tenths ushr (8 * i)).toByte()
            report[20 + i] = (tickMs ushr (8 * i)).toByte()
        }
        report[14] = brightness.toByte()
        report[16] = brightness.toByte()
        report[18] = 0
        report[19] = 4   // scale 1.0 in Q10
        return report
    }

    class Hello(
        @JvmField val version: String,
        @JvmField val leftArm: Boolean,
        @JvmField val safeMode: Boolean,
        @JvmField val panelOk: Boolean,
        @JvmField val encrypted: Boolean,
        @JvmField val inCase: Boolean,
        /** `MIC` captures here: the right arm. */
        @JvmField val mic: Boolean,
        /** The iPhone notification relay answers here (0.5.65+). */
        @JvmField val ancs: Boolean,
    )

    fun parseHello(body: ByteArray): Hello? {
        if (body.size < 7 || body[0].toInt() != 5) return null
        val flags = body[5].toInt() and 255
        return Hello("${body[1].toInt() and 255}.${body[2].toInt() and 255}.${body[3].toInt() and 255}",
            body[4].toInt() == 1, flags and 1 != 0, flags and 2 != 0, flags and 64 != 0, flags and 128 != 0, body[6].toInt() and 4 != 0,
            body[6].toInt() and 8 != 0)
    }

    /** The display path's version, or -1 for a body that isn't FC_INFO's. */
    fun parseFcVersion(body: ByteArray): Int = if (body.size >= 14) body[0].toInt() and 255 else -1

    /** One value per requested property, or null if the reply is short. */
    fun parseProps(body: ByteArray, count: Int): IntArray? =
        if (body.size < 4 * count) null else IntArray(count) { u32(body, 4 * it) }

    /**
     * What a TouchBar gesture means to Faceclaw, which expects a G2's temple: a tap, a double tap and two slides. A
     * G1's TouchBar cannot slide, but it has one per arm, so a tap moves (left up, right down), a double tap selects
     * and a triple tap or long press goes back. Null: no event. With the display [dark] nothing can scroll: a tap is
     * the G2's tap, which shows the Glanceboard, and the session reports a double tap as a wake.
     */
    fun gestureEventType(gesture: Int, leftArm: Boolean, dark: Boolean = false): Int? = when (gesture) {
        GESTURE_TAP -> if (dark) BleProtocol.EVENT_CLICK else if (leftArm) BleProtocol.EVENT_SCROLL_TOP else BleProtocol.EVENT_SCROLL_BOTTOM
        GESTURE_DOUBLE_TAP -> if (dark) BleProtocol.EVENT_DOUBLE_CLICK else BleProtocol.EVENT_CLICK
        GESTURE_TRIPLE_TAP, GESTURE_LONG_START -> BleProtocol.EVENT_DOUBLE_CLICK
        else -> null
    }

    /** `MIC_DATA`'s frames: the counter of the first one, how many, and where they start in [data]. */
    fun micFrames(data: ByteArray): Triple<Int, Int, Int>? {
        if (eventType(data) != EV_MIC_DATA || data.size < EVENT_HEADER + 3) return null
        val count = data[EVENT_HEADER + 2].toInt() and 255
        val start = EVENT_HEADER + 3
        return if (data.size - start < count * Lc3PacketFramer.FRAME_BYTES) null else Triple(u16(data, EVENT_HEADER), count, start)
    }

    private fun u16(b: ByteArray, p: Int): Int = (b[p].toInt() and 255) or ((b[p + 1].toInt() and 255) shl 8)

    private fun u32(b: ByteArray, p: Int): Int = u16(b, p) or (u16(b, p + 2) shl 16)
}

/**
 * A G1's microphone frames as the packets [Lc3PacketFramer] takes from a G2: five 10 ms LC3 frames, then the two values
 * of the G2's stereo capture (a G1 has one mic: zero) and a packet counter. A gap loses the part-filled packet, and the
 * counter tells the decoder to conceal it.
 */
class G1MicAssembler {
    private val frames = ByteArray(Lc3PacketFramer.LC3_BYTES)
    private var have = 0
    private var firstCounter = 0
    private var nextCounter = -1

    fun reset() {
        have = 0
        nextCounter = -1
    }

    fun ingest(first: Int, count: Int, data: ByteArray, start: Int, emit: (ByteArray) -> Unit) {
        val size = Lc3PacketFramer.FRAME_BYTES
        for (i in 0 until count) {
            val counter = (first + i) and 0xffff
            if (counter != nextCounter) have = 0
            if (have == 0) firstCounter = counter
            data.copyInto(frames, have * size, start + i * size, start + (i + 1) * size)
            have++
            nextCounter = (counter + 1) and 0xffff
            if (have == Lc3PacketFramer.FRAMES_PER_PACKET) {
                val packet = ByteArray(Lc3PacketFramer.PACKET_BYTES)
                frames.copyInto(packet)
                packet[Lc3PacketFramer.COUNTER_OFFSET] = (firstCounter / Lc3PacketFramer.FRAMES_PER_PACKET).toByte()
                emit(packet)
                have = 0
            }
        }
    }
}
