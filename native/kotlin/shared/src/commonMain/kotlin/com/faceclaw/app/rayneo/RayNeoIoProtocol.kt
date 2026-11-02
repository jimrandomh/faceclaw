package com.faceclaw.app

import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic

/**
 * RayNeo iO wire codecs (stock link plus the Faceclaw custom-firmware link). Pure functions
 * and small value types; no I/O, threads or platform APIs.
 *
 * The iO is one SoC driving both eyes over ONE BLE connection. Everything travels in AA55
 * frames on one write characteristic and one notify characteristic; the frame's "business"
 * byte selects the subsystem: 0x10 handshake (TLV), 9 OTA and 13..22 apps (protobuf-style
 * envelope + JSON), 0xF0 the custom-firmware link. The CFW link carries Faceclaw's G2 records
 * unchanged (see [CfwTransport.encodeRecord]) inside `[opt][stream][chunk]` packets, and the
 * firmware answers with the G2's 9-byte ACK body, one ACK per targeted lens.
 *
 * Protocol knowledge from the MIT-licensed Glassly SDK and CFW (tetramo-labs/glassly,
 * tetramo-labs/glassly-rayneo-cfw); the Faceclaw firmware fork documents its additions in
 * faceclaw-rayneo-cfw/docs/FACECLAW.md.
 */
object RayNeoIoBle {
    const val SERVICE_UUID = "0000b81d-0000-1000-8000-00805f9b34fb"
    /** Phone -> glasses, write without response. */
    const val WRITE_CHAR_UUID = "ea8b70d5-2bd3-49ab-9c31-9c38b2c3c4f9"
    /** Glasses -> phone, notifications. */
    const val NOTIFY_CHAR_UUID = "7db3e235-3608-41f3-a03c-955fcbd2ea4b"
    const val REQUESTED_MTU = 512
    /** Advertised manufacturer data company id; the payload is `[07][MAC x6]...` (not in pairing mode). */
    const val MANUFACTURER_ID = 0x5716

    @JvmStatic fun matchesName(name: String?): Boolean = name != null && name.contains("rayneo", ignoreCase = true)

    /** The glasses' MAC ("00:6A:5E:5F:33:C2") from manufacturer data, or null. */
    @JvmStatic
    fun macFromManufacturerData(data: ByteArray?): String? {
        if (data == null || data.size < 7 || data[0].toInt() != 7) return null
        return (1..6).joinToString(":") { i -> (data[i].toInt() and 255).toString(16).padStart(2, '0').uppercase() }
    }
}

object RayNeoIoProtocol {
    const val BUSINESS_OTA = 9
    const val BUSINESS_VOICE = 13
    const val BUSINESS_LAUNCHER = 15
    const val BUSINESS_HANDSHAKE = 0x10
    const val BUSINESS_CFW = 0xf0

    const val FRAME_OVERHEAD = 10
    const val MIN_FRAME_BYTES = 10

    /** Program constant of the stock app's guest authentication (not a secret). */
    private val SALT = byteArrayOf(
        0x07, 0x12, 0xc8.toByte(), 0xad.toByte(), 0x27, 0x74, 0x41, 0x95.toByte(),
        0xde.toByte(), 0x5f, 0xa1.toByte(), 0xea.toByte(), 0x6d, 0x02, 0x5f, 0xb8.toByte(),
    )

    // ---- CRC-16/XMODEM (poly 0x1021, init 0) -----------------------------------------------

    @JvmStatic
    fun crc16Xmodem(bytes: ByteArray, from: Int = 0, to: Int = bytes.size): Int {
        var crc = 0
        for (i in from until to) {
            crc = crc xor ((bytes[i].toInt() and 255) shl 8)
            repeat(8) { crc = if (crc and 0x8000 != 0) ((crc shl 1) xor 0x1021) and 0xffff else (crc shl 1) and 0xffff }
        }
        return crc
    }

    // ---- AA55 frames --------------------------------------------------------------------------

    class Frame(
        @JvmField val messageNumber: Int,
        @JvmField val packetType: Int,
        @JvmField val business: Int,
        @JvmField val payload: ByteArray,
    )

    /** `AA 55 [len u16 BE = total-6] [msg u16 BE] [packetType] [business] payload [crc16 BE of bytes 4..end-2]`. */
    @JvmStatic
    fun encodeFrame(messageNumber: Int, business: Int, payload: ByteArray, packetType: Int = 0): ByteArray {
        val frame = ByteArray(FRAME_OVERHEAD + payload.size)
        val length = frame.size - 6
        frame[0] = 0xaa.toByte()
        frame[1] = 0x55
        frame[2] = (length ushr 8).toByte()
        frame[3] = length.toByte()
        frame[4] = (messageNumber ushr 8).toByte()
        frame[5] = messageNumber.toByte()
        frame[6] = packetType.toByte()
        frame[7] = business.toByte()
        payload.copyInto(frame, 8)
        val crc = crc16Xmodem(frame, 4, frame.size - 2)
        frame[frame.size - 2] = (crc ushr 8).toByte()
        frame[frame.size - 1] = crc.toByte()
        return frame
    }

    /** Split a frame into ATT writes of at most `mtu - 3` bytes. */
    @JvmStatic
    fun writes(frame: ByteArray, mtu: Int): List<ByteArray> {
        val chunk = (mtu - 3).coerceAtLeast(20)
        return (frame.indices step chunk).map { frame.copyOfRange(it, minOf(it + chunk, frame.size)) }
    }

    @JvmStatic
    fun decodeFrame(bytes: ByteArray): Frame? {
        if (bytes.size < MIN_FRAME_BYTES || bytes[0] != 0xaa.toByte() || bytes[1] != 0x55.toByte()) return null
        val total = (((bytes[2].toInt() and 255) shl 8) or (bytes[3].toInt() and 255)) + 6
        if (total != bytes.size) return null
        val crc = ((bytes[total - 2].toInt() and 255) shl 8) or (bytes[total - 1].toInt() and 255)
        if (crc != crc16Xmodem(bytes, 4, total - 2)) return null
        val number = ((bytes[4].toInt() and 255) shl 8) or (bytes[5].toInt() and 255)
        return Frame(number, bytes[6].toInt() and 255, bytes[7].toInt() and 255, bytes.copyOfRange(8, total - 2))
    }

    /**
     * Frames from notification chunks: a frame may span several notifications. Bytes before a
     * frame head are skipped; a head whose CRC fails is skipped past its magic.
     */
    class FrameReassembler {
        private var buffer = ByteArray(0)

        fun reset() {
            buffer = ByteArray(0)
        }

        fun ingest(chunk: ByteArray): List<Frame> {
            buffer += chunk
            val out = ArrayList<Frame>()
            var offset = 0
            while (true) {
                while (offset + 1 < buffer.size && !(buffer[offset] == 0xaa.toByte() && buffer[offset + 1] == 0x55.toByte())) offset++
                if (buffer.size - offset < 4) break
                val total = (((buffer[offset + 2].toInt() and 255) shl 8) or (buffer[offset + 3].toInt() and 255)) + 6
                if (total < MIN_FRAME_BYTES) { offset += 2; continue }
                if (buffer.size - offset < total) break
                val frame = decodeFrame(buffer.copyOfRange(offset, offset + total))
                if (frame == null) { offset += 2; continue }
                out.add(frame)
                offset += total
            }
            buffer = buffer.copyOfRange(minOf(offset, buffer.size), buffer.size)
            return out
        }

        val pendingBytes: Int get() = buffer.size
    }

    // ---- TLV (tag u8, length u16 BE) ------------------------------------------------------------

    class Tlv(@JvmField val tag: Int, @JvmField val value: ByteArray)

    @JvmStatic
    fun tlv(tag: Int, value: ByteArray): ByteArray {
        val out = ByteArray(3 + value.size)
        out[0] = tag.toByte()
        out[1] = (value.size ushr 8).toByte()
        out[2] = value.size.toByte()
        value.copyInto(out, 3)
        return out
    }

    @JvmStatic
    fun decodeTlvs(bytes: ByteArray): List<Tlv>? {
        val out = ArrayList<Tlv>()
        var i = 0
        while (i < bytes.size) {
            if (bytes.size - i < 3) return null
            val len = ((bytes[i + 1].toInt() and 255) shl 8) or (bytes[i + 2].toInt() and 255)
            if (bytes.size - i - 3 < len) return null
            out.add(Tlv(bytes[i].toInt() and 255, bytes.copyOfRange(i + 3, i + 3 + len)))
            i += 3 + len
        }
        return out
    }

    private fun List<Tlv>.value(tag: Int): ByteArray? = firstOrNull { it.tag == tag }?.value

    // ---- Handshake (business 0x10) ----------------------------------------------------------------

    const val PLATFORM_IOS = 1
    const val PLATFORM_ANDROID = 2

    /** Version request. `phoneId` is a stable 6-byte protocol identity the glasses bind to. */
    @JvmStatic
    fun versionRequest(phoneId: ByteArray, phoneName: String, manufacturer: String, model: String, platform: Int = PLATFORM_ANDROID): ByteArray {
        require(phoneId.size == 6)
        val inner = tlv(0x10, byteArrayOf(1)) + tlv(0x11, phoneId) + tlv(0x12, phoneName.encodeToByteArray()) +
            tlv(0x13, byteArrayOf(platform.toByte())) + tlv(0x16, manufacturer.encodeToByteArray()) +
            tlv(0x17, model.encodeToByteArray())
        return tlv(0x11, inner)
    }

    class VersionReply(
        @JvmField val protocolVersion: Int,
        /** The glasses' Bluetooth MAC, which the auth proof covers. */
        @JvmField val glassesId: ByteArray,
        @JvmField val serial: String?,
        /** Tags 0x19/0x1a: bound to another phone's account; guest auth will not work. */
        @JvmField val accountBound: Boolean,
    )

    @JvmStatic
    fun parseVersionReply(payload: ByteArray): VersionReply? {
        val body = decodeTlvs(payload)?.value(0x11) ?: return null
        val fields = decodeTlvs(body) ?: return null
        val id = fields.value(0x11)?.takeIf { it.size == 6 } ?: return null
        return VersionReply(
            fields.value(0x10)?.firstOrNull()?.toInt()?.and(255) ?: 0,
            id,
            fields.value(0x14)?.decodeToString()?.trimEnd('\u0000'),
            fields.value(0x19) != null || fields.value(0x1a) != null,
        )
    }

    /** `SHA-256(random4 ‖ phoneId6 ‖ glassesId6 ‖ SALT)`, both directions. */
    @JvmStatic
    fun authProof(random: ByteArray, phoneId: ByteArray, glassesId: ByteArray): ByteArray {
        val digest = Sha256Digest()
        digest.update(random)
        digest.update(phoneId)
        digest.update(glassesId)
        digest.update(SALT)
        return digest.digest()
    }

    @JvmStatic
    fun guestAuthRequest(random: ByteArray, phoneId: ByteArray, glassesId: ByteArray): ByteArray {
        require(random.size == 4 && phoneId.size == 6 && glassesId.size == 6)
        return tlv(0x18, tlv(0x10, random) + tlv(0x11, authProof(random, phoneId, glassesId)))
    }

    /** The glasses' answer proves they know the same phone and glasses ids. */
    @JvmStatic
    fun verifyGuestAuthReply(payload: ByteArray, phoneId: ByteArray, glassesId: ByteArray): Boolean {
        val body = decodeTlvs(payload)?.value(0x19) ?: return false
        val fields = decodeTlvs(body) ?: return false
        val random = fields.value(0x10)?.takeIf { it.size == 4 } ?: return false
        val proof = fields.value(0x11)?.takeIf { it.size == 32 } ?: return false
        return proof.contentEquals(authProof(random, phoneId, glassesId))
    }

    /** True for a guest-auth reply (outer tag 0x19), valid or not. */
    @JvmStatic fun isGuestAuthReply(payload: ByteArray): Boolean = decodeTlvs(payload)?.value(0x19) != null

    // ---- Business envelope (9, 13..22): 08 version, 10 type, 1A json, 22 bytes, 28 seq, 30 mode ----

    const val MODE_REQUEST = 1
    const val MODE_REPLY = 2
    const val LAUNCHER_GENERAL_STATUS = 1
    const val LAUNCHER_BRIGHTNESS = 2
    const val LAUNCHER_GENERAL_SETTINGS = 4
    const val LAUNCHER_AI_VOICE_WAKEUP = 16
    const val OTA_VERSION = 1
    const val GENERAL_STATUS_REQUEST = """{"cmd":"request_general_status","payload":{"data":"","mode":0,"value":0}}"""
    /** The reply (type 4) carries `generalSettings`, among them the wake-word preferences. */
    const val GENERAL_SETTINGS_REQUEST = """{"cmd":"request_general_settings","payload":{"value":0,"mode":0,"data":""}}"""

    /**
     * The launcher's wake-word switch. Every `set_ai_*` handler takes the new value from
     * `mode` and ignores `value` (RnLinkMsgProcessor::handleAssistantSettingCommand, see
     * notes/rayneo-io-wakeword-re.md): mode 1 on, 0 off.
     */
    @JvmStatic
    fun launcherSetAiVoiceWakeup(enabled: Boolean): String =
        """{"cmd":"set_ai_voice_wakeup","payload":{"value":0,"mode":${if (enabled) 1 else 0},"data":""}}"""

    // ---- Voice assistant (business 13), as Glassly's RayNeoIOProtocol maps it ----
    // The stock assistant: the wake word (or a temple long/double press) opens a session
    // and sends VOICE_WAKE; the phone answers VOICE_RC {"rc":1} for Opus as VOICE_AUDIO,
    // or {"rc":2} plus VOICE_ABORT to end it; VOICE_EXITED reports it gone. The remote
    // stream (VOICE_STREAM_CONTROL {"rc":1|2}, packets as VOICE_STREAM_AUDIO) needs
    // IDENT_FLAG_MIC firmware and runs without a session or its page, until a session,
    // a call, SCO or a recording takes the recorder. Packets are 16 kHz mono Opus in
    // the envelope's bytes field.

    const val VOICE_WAKE = 1
    const val VOICE_RC = 2
    const val VOICE_AUDIO = 3
    const val VOICE_VAD = 4
    const val VOICE_ABORT = 7
    const val VOICE_EXITED = 8
    const val VOICE_STREAM_CONTROL = 58
    const val VOICE_STREAM_AUDIO = 59
    const val VOICE_RC_START = 1
    const val VOICE_RC_STOP = 2
    const val VOICE_SAMPLE_RATE = 16_000

    /** A voice-channel message: `{"rc":n}` as [type] (VOICE_RC, VOICE_STREAM_CONTROL or VOICE_ABORT). */
    @JvmStatic
    fun voiceRc(type: Int, rc: Int): ByteArray = encodeEnvelope(Envelope(type, """{"rc":$rc}"""))

    class Envelope(
        @JvmField val type: Int,
        @JvmField val json: String,
        @JvmField val binary: ByteArray? = null,
        @JvmField val sequence: Int? = null,
        @JvmField val mode: Int? = null,
    )

    private fun varint(out: MutableList<Byte>, value: Long) {
        var v = value
        while (v and 0x7fL.inv() != 0L) { out.add(((v and 0x7f) or 0x80).toByte()); v = v ushr 7 }
        out.add(v.toByte())
    }

    @JvmStatic
    fun encodeEnvelope(e: Envelope): ByteArray {
        val out = ArrayList<Byte>()
        out.add(0x08); varint(out, 1)
        out.add(0x10); varint(out, e.type.toLong())
        val json = e.json.encodeToByteArray()
        out.add(0x1a); varint(out, json.size.toLong()); json.forEach { out.add(it) }
        e.binary?.let { b -> out.add(0x22); varint(out, b.size.toLong()); b.forEach { out.add(it) } }
        e.sequence?.let { out.add(0x28); varint(out, it.toLong()) }
        e.mode?.let { out.add(0x30); varint(out, it.toLong()) }
        return out.toByteArray()
    }

    @JvmStatic
    fun decodeEnvelope(bytes: ByteArray): Envelope? {
        var pos = 0
        fun readVarint(): Long? {
            var shift = 0
            var result = 0L
            while (pos < bytes.size && shift <= 63) {
                val b = bytes[pos++].toInt() and 255
                result = result or ((b and 0x7f).toLong() shl shift)
                if (b and 0x80 == 0) return result
                shift += 7
            }
            return null
        }
        var type: Int? = null
        var json = ""
        var binary: ByteArray? = null
        var sequence: Int? = null
        var mode: Int? = null
        while (pos < bytes.size) {
            val key = readVarint() ?: return null
            when ((key and 7).toInt()) {
                0 -> {
                    val v = readVarint() ?: return null
                    when ((key ushr 3).toInt()) { 2 -> type = v.toInt(); 5 -> sequence = v.toInt(); 6 -> mode = v.toInt() }
                }
                2 -> {
                    val len = readVarint() ?: return null
                    if (len < 0 || len > bytes.size - pos) return null
                    val v = bytes.copyOfRange(pos, pos + len.toInt())
                    pos += len.toInt()
                    when ((key ushr 3).toInt()) { 3 -> json = v.decodeToString(); 4 -> binary = v }
                }
                1 -> pos += 8
                5 -> pos += 4
                else -> return null
            }
        }
        return Envelope(type ?: return null, json, binary, sequence, mode)
    }

    /**
     * Set the launcher's brightness (1..8). The stock handler also turns the screen on
     * (BrightnessMonitor::setBrightness -> turnOnScreenForSetting), which is how the phone
     * wakes the iO's display and keeps the stock auto-off from blanking a static page.
     */
    @JvmStatic
    fun launcherBrightness(level: Int): String =
        """{"cmd":"brightness_change","payload":{"value":${level.coerceIn(1, 8)},"mode":0,"data":""}}"""

    /** Faceclaw's 0..100 brightness target on the launcher's 1..8 scale. */
    @JvmStatic fun brightnessLevel(target: Int): Int = maxOf(1, (target.coerceIn(0, 100) * 8 + 50) / 100)

    /** `screen_status` push value (1 on, 0 off), or -1 for anything else. */
    @JvmStatic
    fun screenStatusFromLauncherJson(json: String): Int {
        val root = try { Json.parse(json).asObject() } catch (_: Exception) { null } ?: return -1
        if (root["cmd"].asString() != "screen_status") return -1
        return root["payload"].asObject()?.get("value").asInt() ?: -1
    }

    /** `generalStatus.battery` from a launcher reply or push, or -1. */
    @JvmStatic
    fun batteryFromLauncherJson(json: String): Int {
        val root = try { Json.parse(json).asObject() } catch (_: Exception) { null } ?: return -1
        val status = root["generalStatus"].asObject() ?: root["payload"].asObject()?.get("generalStatus").asObject()
        status?.get("battery").asInt()?.let { return it }
        // pushes: {"cmd":"battery_change","payload":{"value":N,...}}
        if (root["cmd"].asString() == "battery_change") return root["payload"].asObject()?.get("value").asInt() ?: -1
        return -1
    }

    // ---- Custom-firmware link (business 0xF0) -----------------------------------------------------

    const val OPT_LENS = 0x01
    const val OPT_CONTROL = 0x10
    const val OPT_END = 0x40
    const val OPT_RESET = 0x80
    const val CTRL_QUERY = 1
    const val CTRL_PAGE_OPEN = 2
    const val CTRL_PAGE_CLOSE = 3
    const val CTRL_KEEPALIVE = 4
    /** Records up to this many bytes per packet (IDENT reports the firmware's maxChunk). */
    const val DEFAULT_MAX_CHUNK = 240
    /** The page closes this long after the last PAGE_OPEN/KEEPALIVE. */
    const val PAGE_LEASE_MS = 120_000L

    @JvmStatic
    fun controlPacket(ctrl: Int, arg: Int? = null): ByteArray =
        if (arg == null) byteArrayOf(OPT_CONTROL.toByte(), 0, ctrl.toByte())
        else byteArrayOf(OPT_CONTROL.toByte(), 0, ctrl.toByte(), arg.toByte())

    /**
     * One record (from [CfwTransport.encodeRecord]) as business-0xF0 payloads
     * `[opt][stream][chunk]`. `stream` is echoed in the ACKs, so it plays the G2 stream id's role.
     */
    @JvmStatic
    fun cfwPackets(record: ByteArray, streamId: Int, maxChunk: Int = DEFAULT_MAX_CHUNK): List<ByteArray> {
        require(streamId in 0..255 && maxChunk > 0)
        val out = ArrayList<ByteArray>()
        var offset = 0
        do {
            val end = minOf(offset + maxChunk, record.size)
            var opt = OPT_LENS
            if (offset == 0) opt = opt or OPT_RESET
            if (end >= record.size) opt = opt or OPT_END
            val p = ByteArray(2 + end - offset)
            p[0] = opt.toByte()
            p[1] = streamId.toByte()
            record.copyInto(p, 2, offset, end)
            out.add(p)
            offset = end
        } while (offset < record.size)
        return out
    }

    const val KIND_ACK = 1
    const val KIND_NACK = 3
    const val KIND_REPLY = 5
    const val KIND_GESTURE = 7
    const val KIND_IDENT = 0x11
    const val KIND_PAGE = 0x13
    const val KIND_DIAG = 0x15

    /** `[01|03][stream][ordinal u16][lens][size u16][crc u16]`: the G2 ACK body, one per lens. */
    @JvmStatic
    fun parseCfwAck(payload: ByteArray): CfwTransport.Ack? {
        if (payload.size != 9) return null
        val kind = payload[0].toInt() and 255
        val lens = payload[4].toInt() and 255
        if ((kind != KIND_ACK && kind != KIND_NACK) || (lens != 1 && lens != 2)) return null
        fun u16(o: Int) = (payload[o].toInt() and 255) or ((payload[o + 1].toInt() and 255) shl 8)
        return CfwTransport.Ack(kind == KIND_NACK, payload[1].toInt() and 255, u16(2), lens, u16(5), u16(7))
    }

    const val IDENT_FLAG_ZLIB = 0x01
    const val IDENT_FLAG_STEREO = 0x08
    /** The assistant's remote audio stream (type 58/59 below) is allowed (CFW revision 10). */
    const val IDENT_FLAG_MIC = 0x20
    const val IDENT_FLAG_FACECLAW = 0x80

    class Ident(
        @JvmField val width: Int,
        @JvmField val height: Int,
        @JvmField val maxChunk: Int,
        @JvmField val revision: Int,
        @JvmField val flags: Int,
        @JvmField val name: String,
        /** "Faceclaw/<n>" -> n when the firmware runs the Faceclaw display lists, else -1. */
        @JvmField val faceclawRevision: Int,
    ) {
        val acceptsCompressed: Boolean get() = flags and IDENT_FLAG_ZLIB != 0
        val micStream: Boolean get() = flags and IDENT_FLAG_MIC != 0
        val faceclaw: Boolean get() = flags and IDENT_FLAG_FACECLAW != 0 && faceclawRevision > 0
    }

    /** `[11][ver][w u16][h u16][maxChunk u16][storeKiB u16][rev u16][flags]name\0[lineHeight]["Faceclaw/n"\0]`. */
    @JvmStatic
    fun parseIdent(payload: ByteArray): Ident? {
        if (payload.size < 13 || payload[0].toInt() != KIND_IDENT) return null
        fun u16(o: Int) = (payload[o].toInt() and 255) or ((payload[o + 1].toInt() and 255) shl 8)
        var end = 13
        while (end < payload.size && payload[end].toInt() != 0) end++
        val name = payload.copyOfRange(13, end).decodeToString()
        var faceclaw = -1
        val extra = end + 2 // NUL, line height
        if (extra < payload.size) {
            var e = extra
            while (e < payload.size && payload[e].toInt() != 0) e++
            val text = payload.copyOfRange(extra, e).decodeToString()
            if (text.startsWith("Faceclaw/")) faceclaw = text.removePrefix("Faceclaw/").toIntOrNull() ?: -1
        }
        return Ident(u16(2), u16(4), u16(6), u16(10), payload[12].toInt() and 255, name, faceclaw)
    }

    /** PAGE `[13][state][reason]`: state 1 open. */
    @JvmStatic fun parsePageState(payload: ByteArray): Int = if (payload.size >= 2 && payload[0].toInt() == KIND_PAGE) payload[1].toInt() and 255 else -1

    class Gesture(@JvmField val eventType: Int, @JvmField val source: Int, @JvmField val tick: Long)

    /**
     * GESTURE `[07][eventType][source][tick u32]`. Event types use the G2's OsEventTypeList numbering:
     * 0 single tap, 1 swipe up, 2 swipe down, 3 double tap, 11 tap-then-hold, 12 head up, 15 head down.
     */
    @JvmStatic
    fun parseGesture(payload: ByteArray): Gesture? {
        if (payload.size < 7 || payload[0].toInt() != KIND_GESTURE) return null
        val tick = (payload[3].toLong() and 255) or ((payload[4].toLong() and 255) shl 8) or
            ((payload[5].toLong() and 255) shl 16) or ((payload[6].toLong() and 255) shl 24)
        return Gesture(payload[1].toInt() and 255, payload[2].toInt() and 255, tick)
    }
}
