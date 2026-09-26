package com.faceclaw.app

import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic

/**
 * RingProtocol: frame build/parse plus per-record decoding for the Even R1
 * ring's health-data channel. Does _not_ include code for actually sending
 * anything; for that, see GlassesSessionRing.kt (same split as BleProtocol).
 *
 * Platform-neutral and free of Android imports; the Java-facing surface
 * (static members, public fields) is kept so the JVM self-test in
 * tests/kotlin and the TypeScript health ingest read it unchanged.
 *
 * **This is a different protocol from BleProtocol's.** The glasses speak
 * an `aa21` envelope with a CRC-16/CCITT; the ring speaks a 15-byte
 * `64 .. 64` header with a CRC-32C. Nothing is shared between them, and
 * in particular [crc32] must never be pointed at a glasses frame.
 *
 * Wire format (offsets from the start of the ATT value):
 * ```
 *  off size field
 *   0   1   FLAG      0x00 normally; 0x01 = fragmented, a continuation follows
 *   1   4   CRC32     little-endian, over bytes [5:] of the *reassembled* frame
 *   5   1   0x64      constant magic
 *   6   1   CHAN      0x01 device/system, 0x02 health data
 *   7   1   0x64      constant magic
 *   8   1   SEQ       phone-side: one counter shared by both channels
 *   9   1   0x00      constant
 *  10   1   KIND      0x00 REQ, 0x01 ACK, 0x02 DATA, 0x03 RSP
 *  11   1   CMD_HI
 *  12   1   CMD_LO
 *  13   2   PLEN      little-endian; equals (total frame length - 5)
 *  15  ..   PAYLOAD   PLEN - 10 bytes; PAYLOAD[0:2] is a free per-message nonce
 * ```
 *
 * Protocol spec and its evidence:
 * knowledge/staging/faceclaw-ring-protocol-decode-return.md in the TLC
 * knowledge base. Everything below is implemented from that document; the
 * places where it is explicitly *not* solved are marked UNSOLVED and are
 * surfaced raw rather than guessed at.
 */
class RingProtocol private constructor() {
    companion object {
        /** CRC-32C polynomial, MSB-first / non-reflected form. Not CRC-32 (0x04C11DB7). */
        private const val CRC32C_POLY: Int = 0x1EDC6F41

        const val MAGIC: Int = 0x64
        const val HEADER_LEN: Int = 15
        /** A continuation frame is FLAG(1) + CRC32(4) and then raw remainder bytes. */
        const val CONTINUATION_PREFIX_LEN: Int = 5

        const val FLAG_PLAIN: Int = 0x00
        const val FLAG_FRAGMENTED: Int = 0x01

        const val CHAN_DEVICE: Int = 0x01
        const val CHAN_HEALTH: Int = 0x02

        const val KIND_REQ: Int = 0x00
        const val KIND_ACK: Int = 0x01
        const val KIND_DATA: Int = 0x02
        const val KIND_RSP: Int = 0x03

        /** Every health record type uses CMD_LO = 0x01; the type lives in CMD_HI. */
        const val CMD_LO_HEALTH: Int = 0x01
        const val CMD_HI_HEART_RATE: Int = 0x01
        const val CMD_HI_SPO2: Int = 0x02
        const val CMD_HI_HRV: Int = 0x04
        const val CMD_HI_STEPS: Int = 0x05
        const val CMD_HI_SLEEP: Int = 0x06

        /** Device/system channel commands all have CMD_HI = 0x00. */
        const val CMD_HI_DEVICE: Int = 0x00
        const val CMD_LO_PAGE_ACK: Int = 0x7E

        /**
         * The five health pulls, in the order Even's own app issues them:
         * heart rate, HRV, SpO2, sleep, steps. That order is identical in all four
         * sync bursts of the reference capture. (It is NOT the order the spec
         * document happens to list them in — that is just its presentation order.)
         * Whether the order matters to the ring is untested; matching the app is
         * the cheapest way not to find out the hard way.
         */
        @JvmField val HEALTH_COMMANDS: IntArray = intArrayOf(
            CMD_HI_HEART_RATE,
            CMD_HI_HRV,
            CMD_HI_SPO2,
            CMD_HI_SLEEP,
            CMD_HI_STEPS,
        )

        /** Returned by anchor/timestamp accessors when the value is not known. */
        const val UNKNOWN_TIME: Long = -1L

        private val EMPTY = ByteArray(0)

        // ------------------------------------------------------------------
        // CRC
        // ------------------------------------------------------------------

        /**
         * CRC-32C over `data[from, to)`: polynomial 0x1EDC6F41, MSB-first,
         * init 0, no reflection, no final xor. Verified against 188/188 frames in
         * the reference capture.
         */
        @JvmStatic
        fun crc32(data: ByteArray, from: Int, to: Int): Int {
            var crc = 0
            for (i in from until to) {
                crc = crc xor ((data[i].toInt() and 0xff) shl 24)
                for (bit in 0 until 8) {
                    crc = if ((crc and 0x80000000.toInt()) != 0) {
                        (crc shl 1) xor CRC32C_POLY
                    } else {
                        crc shl 1
                    }
                }
            }
            return crc
        }

        @JvmStatic
        fun crc32(data: ByteArray?): Int = if (data == null) 0 else crc32(data, 0, data.size)

        // ------------------------------------------------------------------
        // Frame building
        // ------------------------------------------------------------------

        /**
         * Build one complete, CRC-correct frame. Fragmentation is a receive-side
         * concern only: nothing we send approaches the 244-byte ATT ceiling.
         */
        @JvmStatic
        fun buildFrame(chan: Int, kind: Int, cmdHi: Int, cmdLo: Int, seq: Int, payload: ByteArray?): ByteArray {
            val body = payload ?: EMPTY
            val total = HEADER_LEN + body.size
            val frame = ByteArray(total)
            frame[0] = FLAG_PLAIN.toByte()
            frame[5] = MAGIC.toByte()
            frame[6] = (chan and 0xff).toByte()
            frame[7] = MAGIC.toByte()
            frame[8] = (seq and 0xff).toByte()
            frame[9] = 0x00
            frame[10] = (kind and 0xff).toByte()
            frame[11] = (cmdHi and 0xff).toByte()
            frame[12] = (cmdLo and 0xff).toByte()
            val plen = total - 5
            frame[13] = (plen and 0xff).toByte()
            frame[14] = ((plen ushr 8) and 0xff).toByte()
            body.copyInto(frame, HEADER_LEN)
            writeIntLe(frame, 1, crc32(frame, 5, total))
            return frame
        }

        /**
         * A request frame. Health requests carry no arguments at all: the payload
         * is the 2-byte nonce and nothing else.
         *
         * The nonce is a free per-message id — it is covered by the frame CRC but
         * is not content-derived, so any value works. It is encoded little-endian.
         */
        @JvmStatic
        fun buildRequest(chan: Int, cmdHi: Int, cmdLo: Int, seq: Int, nonce: Int): ByteArray {
            return buildFrame(chan, KIND_REQ, cmdHi, cmdLo, seq, nonceBytes(nonce))
        }

        /** One of the five health pulls; see [HEALTH_COMMANDS]. */
        @JvmStatic
        fun buildHealthRequest(cmdHi: Int, seq: Int, nonce: Int): ByteArray {
            return buildRequest(CHAN_HEALTH, cmdHi, CMD_LO_HEALTH, seq, nonce)
        }

        /**
         * The per-page acknowledgement: command 00:7E on the DEVICE channel,
         * echoing the sequence number of the DATA page being acknowledged.
         *
         * Payload is 12 bytes: the usual 2-byte nonce, then
         * `02 <cmd_hi> <cmd_lo> 00 <page_seq>`, then five zero bytes. (Note
         * the echoed page seq is at payload offset 6, after the nonce — a spec doc
         * that describes the payload as starting at `02` is off by the nonce.)
         *
         * The frame's own SEQ is the phone's shared counter, NOT the echoed page
         * seq: across 20 ACKs in the reference capture the two are always different,
         * and the header SEQ continues the same +1 sequence used by every other
         * phone-to-ring write on both channels.
         *
         * Whether the ring actually *requires* this is untested — Even's app
         * sends one for every page without exception (20/20), but no page has ever
         * been deliberately left unacknowledged to see what happens.
         */
        @JvmStatic
        fun buildPageAck(seq: Int, nonce: Int, ackedCmdHi: Int, ackedCmdLo: Int, pageSeq: Int): ByteArray {
            val payload = ByteArray(12)
            payload[0] = (nonce and 0xff).toByte()
            payload[1] = ((nonce ushr 8) and 0xff).toByte()
            payload[2] = 0x02
            payload[3] = (ackedCmdHi and 0xff).toByte()
            payload[4] = (ackedCmdLo and 0xff).toByte()
            payload[5] = 0x00
            payload[6] = (pageSeq and 0xff).toByte()
            // payload[7..11] stay zero.
            return buildFrame(CHAN_DEVICE, KIND_ACK, CMD_HI_DEVICE, CMD_LO_PAGE_ACK, seq, payload)
        }

        private fun nonceBytes(nonce: Int): ByteArray {
            return byteArrayOf((nonce and 0xff).toByte(), ((nonce ushr 8) and 0xff).toByte())
        }

        // ------------------------------------------------------------------
        // Frame parsing
        // ------------------------------------------------------------------

        /** True when a value could be the start of a frame (magic bytes in place). */
        @JvmStatic
        fun looksLikeHeader(value: ByteArray?): Boolean {
            return value != null
                && value.size >= HEADER_LEN
                && (value[5].toInt() and 0xff) == MAGIC
                && (value[7].toInt() and 0xff) == MAGIC
        }

        /** Total frame length declared by PLEN, or -1 when this is not a header. */
        @JvmStatic
        fun declaredLength(value: ByteArray?): Int {
            if (value == null || !looksLikeHeader(value)) {
                return -1
            }
            val plen = (value[13].toInt() and 0xff) or ((value[14].toInt() and 0xff) shl 8)
            val total = plen + 5
            return if (total < HEADER_LEN) -1 else total
        }

        /** Parse a complete (already reassembled) frame. Returns null if malformed. */
        @JvmStatic
        fun parse(frame: ByteArray?): Frame? {
            if (frame == null || frame.size < HEADER_LEN) {
                return null
            }
            if ((frame[5].toInt() and 0xff) != MAGIC || (frame[7].toInt() and 0xff) != MAGIC) {
                return null
            }
            val plen = (frame[13].toInt() and 0xff) or ((frame[14].toInt() and 0xff) shl 8)
            if (plen + 5 != frame.size) {
                return null
            }
            val storedCrc = readIntLe(frame, 1)
            val actualCrc = crc32(frame, 5, frame.size)
            val payload = frame.copyOfRange(HEADER_LEN, frame.size)
            return Frame(
                frame[0].toInt() and 0xff,
                frame[6].toInt() and 0xff,
                frame[8].toInt() and 0xff,
                frame[10].toInt() and 0xff,
                frame[11].toInt() and 0xff,
                frame[12].toInt() and 0xff,
                payload,
                frame,
                storedCrc == actualCrc,
            )
        }

        // ------------------------------------------------------------------
        // Record decoding
        // ------------------------------------------------------------------

        /**
         * Decode a health DATA page. Returns null when the frame is not a health
         * DATA page or its body does not match the layout for its type.
         */
        @JvmStatic
        fun decode(frame: Frame?, receivedAtMs: Long): HealthRecord? {
            if (frame == null || !frame.crcOk || !frame.isHealth() || frame.kind != KIND_DATA) {
                return null
            }
            if (frame.cmdLo != CMD_LO_HEALTH) {
                return null
            }
            return when (frame.cmdHi) {
                CMD_HI_HEART_RATE, CMD_HI_SPO2, CMD_HI_HRV -> decodeHourly(frame, receivedAtMs)
                CMD_HI_STEPS -> decodeSteps(frame, receivedAtMs)
                CMD_HI_SLEEP -> decodeSleep(frame, receivedAtMs)
                else -> null
            }
        }

        /**
         * Heart rate / SpO2 / HRV: an hourly `[index][avg][max][min]` series.
         *
         * Layout follows openR1 r1_health_encode_daily_u8/u16 in r1_health.c:
         * count, signed timezone minutes, day start, optional latest timestamp/value,
         * then count groups. There is no footer. HR/SpO2 values are one byte; HRV
         * values are two. Subtracting a supposed four-byte footer misdecoded a
         * one-group HRV page as one-byte values and rejected real HR/SpO2 pages.
         */
        @JvmStatic
        fun decodeHourly(frame: Frame, receivedAtMs: Long): HourlyRecord? {
            val pay = frame.payload
            if (pay.size < 9) {
                return null
            }
            val count = pay[2].toInt() and 0xff
            val anchor = anchorUnixSeconds(pay)
            val width = if (frame.cmdHi == CMD_HI_HRV) 2 else 1
            val groupBytes = count * (1 + 3 * width)
            val prefixLength = pay.size - groupBytes
            val hasLatest = prefixLength == 13 + width
            if (count > 24 || (!hasLatest && prefixLength != 9)) return null
            val tag = if (hasLatest) readUInt32Le(pay, 9) else UNKNOWN_TIME
            val current = if (hasLatest) readUIntLe(pay, 13, width) else -1
            var offset = prefixLength
            val groups = arrayOfNulls<HourlyGroup>(count)
            for (i in 0 until count) {
                val hourIndex = pay[offset].toInt() and 0xff
                if (hourIndex >= 24) return null
                offset++
                val avg = readUIntLe(pay, offset, width)
                offset += width
                val max = readUIntLe(pay, offset, width)
                offset += width
                val min = readUIntLe(pay, offset, width)
                offset += width
                val unix = if (anchor == UNKNOWN_TIME) UNKNOWN_TIME else anchor + hourIndex * 3600L
                groups[i] = HourlyGroup(hourIndex, avg, max, min, unix)
            }
            @Suppress("UNCHECKED_CAST")
            return HourlyRecord(frame.cmdHi, receivedAtMs, anchor, tag, current, width, groups as Array<HourlyGroup>)
        }

        /**
         * Steps / activity buckets: `[index][v1][v2][v3]` after the record
         * prefix. v1 (steps) is proven against a full-day total; v2 and v3 are
         * calorie-shaped but unconfirmed, and the bucket index does NOT map to a
         * known wall-clock time (see [StepsBucket]).
         */
        @JvmStatic
        fun decodeSteps(frame: Frame, receivedAtMs: Long): StepsRecord? {
            val pay = frame.payload
            if (pay.size < 9) {
                return null
            }
            val count = pay[2].toInt() and 0xff
            if (count > 144 || pay.size != 9 + count * 7) {
                return null
            }
            val anchor = anchorUnixSeconds(pay)
            var offset = 9
            val buckets = arrayOfNulls<StepsBucket>(count)
            for (i in 0 until count) {
                val index = pay[offset].toInt() and 0xff
                if (index >= 144) return null
                val steps = readUInt16Le(pay, offset + 1)
                val v2 = readUInt16Le(pay, offset + 3)
                val v3 = readUInt16Le(pay, offset + 5)
                offset += 7
                buckets[i] = StepsBucket(index, steps, v2, v3)
            }
            @Suppress("UNCHECKED_CAST")
            return StepsRecord(receivedAtMs, anchor, buckets as Array<StepsBucket>)
        }

        /**
         * A sleep session. The ring transmits pre-classified stages, per-stage
         * totals and the session boundaries; nothing is computed phone-side.
         *
         * `startTs`/`endTs` are ring-relative seconds, NOT Unix
         * timestamps — see [SleepRecord].
         */
        @JvmStatic
        fun decodeSleep(frame: Frame, receivedAtMs: Long): SleepRecord? {
            val pay = frame.payload
            if (pay.size < 3) {
                return null
            }
            val recordState = pay[2].toInt() and 0xff
            val unknownA = safeRange(pay, 3, 9)
            val unknownTag = if (pay.size >= 13) readUInt32Le(pay, 9) else UNKNOWN_TIME
            if (recordState != 1) {
                // RECSTATE 2 is the empty / end-of-list marker.
                return SleepRecord(
                    receivedAtMs, recordState, unknownA, unknownTag,
                    0, 0, 0, 0, 0, 0, 0, arrayOf())
            }
            if (pay.size < 34) return null

            val startTs = readUInt32Le(pay, 14)
            val endTs = readUInt32Le(pay, 18)
            val totalTime = readUInt16Le(pay, 22)
            val wakeTime = readUInt16Le(pay, 24)
            val remTime = readUInt16Le(pay, 26)
            val lightTime = readUInt16Le(pay, 28)
            val deepTime = readUInt16Le(pay, 30)
            val segmentCount = readUInt16Le(pay, 32)
            if (pay.size != 34 + segmentCount * 3) {
                return null
            }
            var offset = 34
            val segments = Array(segmentCount) {
                val stage = pay[offset].toInt() and 0xff
                val halfMinutes = readUInt16Le(pay, offset + 1)
                offset += 3
                SleepSegment(stage, halfMinutes)
            }
            return SleepRecord(
                receivedAtMs, recordState, unknownA, unknownTag,
                startTs, endTs, totalTime, wakeTime, remTime, lightTime, deepTime, segments)
        }

        /**
         * The record's day anchor as Unix epoch seconds, or [UNKNOWN_TIME]
         * when the day timestamp is zero or the timezone offset is invalid.
         *
         * **UNSOLVED:** a backlog page's true base is not understood as a
         * general rule. One capture's backlog base landed at 2026-09-08 23:48:49
         * local, which is the moment that sync ran plus a per-type offset — it is
         * not a fixed offset from midnight and must not be hardcoded. Callers get
         * [UNKNOWN_TIME] and the raw hour index instead of an invented
         * absolute time.
         */
        @JvmStatic
        fun anchorUnixSeconds(payload: ByteArray?): Long {
            if (payload == null || payload.size < 9) {
                return UNKNOWN_TIME
            }
            // These two bytes are an int16 timezone offset, not magic. 10 ff is
            // -240 minutes (EDT); Pacific time, UTC and eastern zones differ.
            val timezoneMinutes = readUInt16Le(payload, 3).toShort().toInt()
            val anchor = readUInt32Le(payload, 5)
            return if (timezoneMinutes >= -840 && timezoneMinutes <= 840 && anchor != 0L) anchor else UNKNOWN_TIME
        }

        /** Device-channel 00:01 response, matching openR1 get_device_status(). */
        @JvmStatic
        fun decodeDeviceStatus(frame: Frame?): DeviceStatus? {
            if (frame == null || !frame.crcOk || frame.chan != CHAN_DEVICE
                    || frame.kind != KIND_RSP || frame.cmdHi != 0 || frame.cmdLo != 1
                    || frame.payload.size != 9) return null
            val battery = frame.payload[2].toInt() and 0xff
            val charge = frame.payload[3].toInt() and 0xff
            if (battery > 100 || charge > 3) return null
            return DeviceStatus(battery, if (charge == 0) -1 else if (charge == 2) 0 else 1)
        }

        /** Hex, for logs. Mirrors GlassesSessionCore.hex(). */
        @JvmStatic
        fun hex(data: ByteArray?): String {
            if (data == null || data.isEmpty()) {
                return ""
            }
            val out = CharArray(data.size * 2)
            for (i in data.indices) {
                val value = data[i].toInt() and 0xff
                out[i * 2] = HEX_DIGITS[value ushr 4]
                out[i * 2 + 1] = HEX_DIGITS[value and 0x0f]
            }
            return out.concatToString()
        }

        /** The five health requests, ready to write, sharing one ascending seq run. */
        @JvmStatic
        fun buildHealthRequestBurst(firstSeq: Int, firstNonce: Int): List<ByteArray> {
            val frames = ArrayList<ByteArray>(HEALTH_COMMANDS.size)
            var seq = firstSeq
            var nonce = firstNonce
            for (cmdHi in HEALTH_COMMANDS) {
                frames.add(buildHealthRequest(cmdHi, seq, nonce))
                seq = (seq + 1) and 0xff
                nonce = (nonce + 1) and 0xffff
            }
            return frames
        }

        // ------------------------------------------------------------------
        // Little-endian and formatting helpers
        // ------------------------------------------------------------------

        private const val HEX_DIGITS = "0123456789abcdef"

        /** Two lowercase hex digits, like `%02x` for a byte-sized value. */
        internal fun hex2(value: Int): String {
            val v = value and 0xff
            return "" + HEX_DIGITS[v ushr 4] + HEX_DIGITS[v and 0x0f]
        }

        private fun writeIntLe(out: ByteArray, offset: Int, value: Int) {
            out[offset] = (value and 0xff).toByte()
            out[offset + 1] = ((value ushr 8) and 0xff).toByte()
            out[offset + 2] = ((value ushr 16) and 0xff).toByte()
            out[offset + 3] = ((value ushr 24) and 0xff).toByte()
        }

        private fun readIntLe(data: ByteArray, offset: Int): Int {
            return (data[offset].toInt() and 0xff) or
                ((data[offset + 1].toInt() and 0xff) shl 8) or
                ((data[offset + 2].toInt() and 0xff) shl 16) or
                ((data[offset + 3].toInt() and 0xff) shl 24)
        }

        private fun readUInt32Le(data: ByteArray, offset: Int): Long {
            return readIntLe(data, offset).toLong() and 0xffffffffL
        }

        private fun readUInt16Le(data: ByteArray, offset: Int): Int {
            return (data[offset].toInt() and 0xff) or ((data[offset + 1].toInt() and 0xff) shl 8)
        }

        private fun readUIntLe(data: ByteArray, offset: Int, width: Int): Int {
            var value = 0
            for (i in 0 until width) {
                value = value or ((data[offset + i].toInt() and 0xff) shl (8 * i))
            }
            return value
        }

        private fun safeRange(data: ByteArray?, from: Int, to: Int): ByteArray {
            if (data == null || from >= data.size) {
                return EMPTY
            }
            return data.copyOfRange(from, minOf(to, data.size))
        }
    }

    // ------------------------------------------------------------------
    // Fragment reassembly
    // ------------------------------------------------------------------

    /**
     * Feeds raw ATT notification values in and produces complete frames,
     * rejoining fragmented ones.
     *
     * Fragmentation (spec §2.3): when a frame exceeds the 244-byte ATT
     * ceiling the ring sets FLAG=0x01, sends the first 244 bytes, and later
     * sends a continuation frame in a different, headerless shape — FLAG(1),
     * CRC32(4), then the remaining bytes verbatim.
     *
     * Two things the spec document does not say, both measured from the
     * reference capture and both load-bearing here:
     *  - **The continuation is not adjacent.** In one of the six captured
     *    fragmentations three unrelated complete frames arrive between the
     *    first fragment and its continuation, so a "next value is the rest"
     *    rule mis-joins. Complete frames are therefore still parsed normally
     *    while a fragment is outstanding.
     *  - **The continuation's own CRC field is not reliably the reassembled
     *    CRC.** It matched in five of six cases and differed in the sixth
     *    (whose join is nonetheless byte-exact and CRC-valid), so the
     *    continuation must not be matched by comparing CRC fields.
     *
     * What is reliable, in all six cases, is length: a continuation carries
     * exactly `CONTINUATION_PREFIX_LEN + bytesStillNeeded` bytes and does
     * not itself look like a header. The reassembled frame's CRC is the real
     * validator and is always checked.
     */
    class Reassembler {
        private companion object {
            /**
             * Give up on an outstanding fragment after this many intervening
             * complete frames. The observed worst case is 3; this is slack, not a
             * measured bound.
             */
            const val MAX_INTERLEAVED_FRAMES = 16
        }

        private var pending: ByteArray? = null
        private var pendingTotal = 0
        private var interleaved = 0

        fun hasPending(): Boolean = pending != null

        fun reset() {
            pending = null
            pendingTotal = 0
            interleaved = 0
        }

        /**
         * Offer one ATT notification value. The result says whether the value
         * belonged to this protocol at all (so the caller can fall through to
         * the gesture decoder) and carries a frame once one is complete.
         */
        fun accept(value: ByteArray?): Intake {
            if (value == null || value.isEmpty()) {
                return Intake.ignored()
            }

            val held = pending
            if (held != null) {
                val needed = pendingTotal - held.size
                if (value.size == CONTINUATION_PREFIX_LEN + needed && !looksLikeHeader(value)) {
                    val joined = ByteArray(pendingTotal)
                    held.copyInto(joined, 0)
                    value.copyInto(joined, held.size, CONTINUATION_PREFIX_LEN, CONTINUATION_PREFIX_LEN + needed)
                    reset()
                    return complete(joined)
                }
                if (!looksLikeHeader(value)) {
                    val dropped = pendingTotal
                    reset()
                    return Intake.consumed(
                        "dropped $dropped-byte fragment: continuation was ${value.size} bytes, expected ${CONTINUATION_PREFIX_LEN + needed}")
                }
                if (++interleaved > MAX_INTERLEAVED_FRAMES) {
                    val dropped = pendingTotal
                    reset()
                    // Fall through and parse this value as a fresh frame.
                    val result = acceptFresh(value)
                    return result.withNote("dropped $dropped-byte fragment: continuation never arrived")
                }
            }

            return acceptFresh(value)
        }

        private fun acceptFresh(value: ByteArray): Intake {
            val total = declaredLength(value)
            if (total < 0) {
                return Intake.ignored()
            }
            if (value.size >= total) {
                return complete(value.copyOf(total))
            }
            // Only one fragment is ever outstanding in the reference capture,
            // but never silently clobber one if that assumption breaks.
            val clobbered = if (pending == null) null else "dropped $pendingTotal-byte fragment: a new fragment started"
            pending = value.copyOf()
            pendingTotal = total
            interleaved = 0
            return Intake.consumed("fragment start, ${value.size} of $total bytes").withNote(clobbered)
        }

        private fun complete(raw: ByteArray): Intake {
            val frame = parse(raw) ?: return Intake.consumed("malformed frame, " + raw.size + " bytes")
            return Intake.frame(frame)
        }
    }

    /** The outcome of offering one ATT value to a [Reassembler]. */
    class Intake private constructor(
        /** True when the value belonged to this protocol and must not be re-handled. */
        @JvmField val consumed: Boolean,
        /** Non-null once a complete frame is available. Check [Frame.crcOk]. */
        @JvmField val frame: Frame?,
        /** Human-readable detail for logging, or null. */
        @JvmField val note: String?,
    ) {
        internal companion object {
            fun ignored(): Intake = Intake(false, null, null)

            fun consumed(note: String?): Intake = Intake(true, null, note)

            fun frame(frame: Frame): Intake = Intake(true, frame, null)
        }

        internal fun withNote(extra: String?): Intake {
            if (extra == null) {
                return this
            }
            return Intake(consumed, frame, if (note == null) extra else "$note; $extra")
        }
    }

    /** One complete frame. */
    class Frame internal constructor(
        @JvmField val flag: Int,
        @JvmField val chan: Int,
        @JvmField val seq: Int,
        @JvmField val kind: Int,
        @JvmField val cmdHi: Int,
        @JvmField val cmdLo: Int,
        /** PLEN - 10 bytes. payload[0:2] is the sender's nonce. */
        @JvmField val payload: ByteArray,
        @JvmField val raw: ByteArray,
        @JvmField val crcOk: Boolean,
    ) {
        fun isHealth(): Boolean = chan == CHAN_HEALTH

        fun commandLabel(): String = hex2(cmdHi) + ":" + hex2(cmdLo)

        fun describe(): String =
            "chan=" + hex2(chan) + " kind=" + hex2(kind) + " cmd=" + commandLabel() + " seq=" + hex2(seq) + " len=" + raw.size
    }

    class DeviceStatus internal constructor(
        @JvmField val battery: Int,
        @JvmField val charging: Int,
    )

    // ------------------------------------------------------------------
    // Decoded record types
    // ------------------------------------------------------------------

    /** Common supertype so one store can hold every decoded page. */
    abstract class HealthRecord internal constructor(
        @JvmField val cmdHi: Int,
        @JvmField val receivedAtMs: Long,
    ) {
        /** The metric name, for logs. */
        fun metric(): String = when (cmdHi) {
            CMD_HI_HEART_RATE -> "heart_rate"
            CMD_HI_SPO2 -> "spo2"
            CMD_HI_HRV -> "hrv"
            CMD_HI_STEPS -> "steps"
            CMD_HI_SLEEP -> "sleep"
            else -> "cmd" + hex2(cmdHi)
        }

        /** A one-line summary safe to put in a log. */
        abstract fun summary(): String
    }

    /** Heart rate, SpO2 or HRV: one page of hourly buckets. */
    class HourlyRecord internal constructor(
        cmdHi: Int,
        receivedAtMs: Long,
        /** Day anchor in Unix seconds, or [UNKNOWN_TIME] on a backlog page. */
        @JvmField val anchorUnixSeconds: Long,
        /** Per-metric "last measured at". See the 4-hour skew note in the spec. */
        @JvmField val tagRaw: Long,
        /** The metric's latest value. */
        @JvmField val current: Int,
        /** 1 byte for HR/SpO2, 2 for HRV, as defined by the metric serializer. */
        @JvmField val valueWidth: Int,
        @JvmField val groups: Array<HourlyGroup>,
    ) : HealthRecord(cmdHi, receivedAtMs) {
        /** True when this page has no anchor, i.e. it is a backlog page. */
        fun isBacklog(): Boolean = anchorUnixSeconds == UNKNOWN_TIME

        override fun summary(): String =
            metric() + " groups=" + groups.size + " width=" + valueWidth + " current=" + current +
                " anchor=" + (if (isBacklog()) "backlog(unanchored)" else anchorUnixSeconds.toString()) +
                " tag=" + tagRaw
    }

    /** One hourly bucket. */
    class HourlyGroup internal constructor(
        /** Raw index as sent. On an anchored page this is hours since the anchor. */
        @JvmField val hourIndex: Int,
        @JvmField val avg: Int,
        @JvmField val max: Int,
        @JvmField val min: Int,
        /**
         * Absolute Unix seconds for this bucket, or [UNKNOWN_TIME] on a
         * backlog page — where the base is UNSOLVED and deliberately not guessed.
         */
        @JvmField val unixSeconds: Long,
    )

    /** One page of activity buckets. */
    class StepsRecord internal constructor(
        receivedAtMs: Long,
        @JvmField val anchorUnixSeconds: Long,
        @JvmField val buckets: Array<StepsBucket>,
    ) : HealthRecord(CMD_HI_STEPS, receivedAtMs) {
        fun totalSteps(): Int = buckets.sumOf { it.steps }

        override fun summary(): String =
            "steps buckets=" + buckets.size + " total=" + totalSteps() +
                " anchor=" + (if (anchorUnixSeconds == UNKNOWN_TIME) "none" else anchorUnixSeconds.toString())
    }

    /**
     * One activity bucket.
     *
     * **UNSOLVED:** [index] does not map to a known wall-clock
     * time. It runs 0-7, 10, 11, 13-34 and then jumps to 130+, and no bucket
     * width at any base reproduces the app's own per-bucket distribution — even
     * though the steps total across all buckets is exactly right. The raw index
     * is stored as sent; no time-of-day mapping is invented.
     */
    class StepsBucket internal constructor(
        @JvmField val index: Int,
        /** Confirmed: summed over a page this equals the app's daily step total. */
        @JvmField val steps: Int,
        /** UNCONFIRMED: calorie-shaped (v3 - v2 tracks per-bucket resting kcal). */
        @JvmField val calorieLike2: Int,
        /** UNCONFIRMED: calorie-shaped. */
        @JvmField val calorieLike3: Int,
    )

    /**
     * One sleep session.
     *
     * **[startTs] and [endTs] are ring-relative seconds, not Unix time.**
     * Even's own app gets this wrong and stamps live-pushed sessions with
     * timestamps in 1979. Do not feed them to a date formatter.
     *
     * **UNSOLVED:** [unknownPrefix] (6 bytes) and [unknownTag] (u32) are not
     * decoded; one of them probably carries the session date, which would
     * remove the anchoring problem. They are stored raw rather than interpreted.
     */
    class SleepRecord internal constructor(
        receivedAtMs: Long,
        /** 1 = a real record, 2 = the empty / end-of-list marker. */
        @JvmField val recordState: Int,
        /** UNSOLVED per-record 6-byte field (payload[3:9]). Stored raw. */
        @JvmField val unknownPrefix: ByteArray,
        /** UNSOLVED u32 tag (payload[9:13]). Stored raw. */
        @JvmField val unknownTag: Long,
        /** Ring-relative seconds, NOT Unix. */
        @JvmField val startTs: Long,
        /** Ring-relative seconds, NOT Unix. */
        @JvmField val endTs: Long,
        @JvmField val totalTime: Int,
        @JvmField val wakeTime: Int,
        @JvmField val remTime: Int,
        @JvmField val lightTime: Int,
        @JvmField val deepTime: Int,
        /**
         * The stage series. Stage ids are the same 0-3 encoding the app's own
         * export uses, but which id means wake/rem/light/deep is NOT stated by
         * the spec and is deliberately not guessed here — see
         * [halfMinutesForStage].
         */
        @JvmField val segments: Array<SleepSegment>,
    ) : HealthRecord(CMD_HI_SLEEP, receivedAtMs) {
        fun isRealRecord(): Boolean = recordState == 1

        fun totalHalfMinutes(): Int = segments.sumOf { it.halfMinutes }

        fun halfMinutesForStage(stage: Int): Int = segments.filter { it.stage == stage }.sumOf { it.halfMinutes }

        /**
         * The two whole-record arithmetic identities from the spec, which held
         * exactly for all ten real records in the reference capture. A false
         * result means the body was mis-parsed.
         */
        fun identitiesHold(): Boolean {
            if (!isRealRecord()) {
                return true
            }
            val seconds = totalHalfMinutes() * 30
            return seconds == totalTime + wakeTime && seconds == (endTs - startTs).toInt()
        }

        override fun summary(): String {
            if (!isRealRecord()) {
                return "sleep marker state=$recordState"
            }
            return "sleep segments=" + segments.size + " total=" + totalTime + "s wake=" + wakeTime +
                " rem=" + remTime + " light=" + lightTime + " deep=" + deepTime +
                " relStart=" + startTs + " relEnd=" + endTs + " identities=" + identitiesHold()
        }
    }

    /** One stage run: a stage id and a duration in half-minutes (30 s units). */
    class SleepSegment internal constructor(
        @JvmField val stage: Int,
        @JvmField val halfMinutes: Int,
    )
}
