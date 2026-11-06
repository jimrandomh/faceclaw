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
    const val REQUESTED_MTU = 247
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
    const val OP_EVENTS = 0x14
    const val OP_FC_INFO = 0x1D

    const val EV_INPUT = 0x07
    const val EV_FC_ACK = 0x08
    private const val EV_REPLY = 0x80
    private const val EVENT_HEADER = 9
    private const val OPT_START = 0x80
    private const val OPT_END = 0x40
    private const val MAX_PACKET = 244
    private const val PACKET_HEADER = 2

    const val TRIGGER_BATTERY = 5
    const val TRIGGER_CASE = 6
    const val TRIGGER_WEAR = 7
    const val TRIGGER_TOUCH = 8
    const val EVENTS_MASK = (1 shl TRIGGER_BATTERY) or (1 shl TRIGGER_CASE) or (1 shl TRIGGER_WEAR) or (1 shl TRIGGER_TOUCH)

    const val PROP_BATT_PCT = 0x11
    const val PROP_CHARGE = 0x12
    const val PROP_IN_CASE = 0x13
    const val PROP_WORN = 0x14
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

    class Hello(
        @JvmField val version: String,
        @JvmField val leftArm: Boolean,
        @JvmField val safeMode: Boolean,
        @JvmField val panelOk: Boolean,
        @JvmField val encrypted: Boolean,
        @JvmField val inCase: Boolean,
    )

    fun parseHello(body: ByteArray): Hello? {
        if (body.size < 7 || body[0].toInt() != 5) return null
        val flags = body[5].toInt() and 255
        return Hello("${body[1].toInt() and 255}.${body[2].toInt() and 255}.${body[3].toInt() and 255}",
            body[4].toInt() == 1, flags and 1 != 0, flags and 2 != 0, flags and 64 != 0, flags and 128 != 0)
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

    private fun u16(b: ByteArray, p: Int): Int = (b[p].toInt() and 255) or ((b[p + 1].toInt() and 255) shl 8)

    private fun u32(b: ByteArray, p: Int): Int = u16(b, p) or (u16(b, p + 2) shl 16)
}
