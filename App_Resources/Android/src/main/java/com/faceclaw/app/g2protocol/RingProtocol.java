package com.faceclaw.app;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

/**
 * RingProtocol: frame build/parse plus per-record decoding for the Even R1
 * ring's health-data channel. Does _not_ include code for actually sending
 * anything; for that, see FaceclawBleCommunicator (same split as BleProtocol).
 *
 * <p>Deliberately free of Android imports so the whole thing can be exercised
 * with plain javac/java — see notes/ring-protocol-selftest/.
 *
 * <p><b>This is a different protocol from BleProtocol's.</b> The glasses speak
 * an {@code aa21} envelope with a CRC-16/CCITT; the ring speaks a 15-byte
 * {@code 64 .. 64} header with a CRC-32C. Nothing is shared between them, and
 * in particular {@link #crc32} must never be pointed at a glasses frame.
 *
 * <p>Wire format (offsets from the start of the ATT value):
 * <pre>
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
 * </pre>
 *
 * <p>Protocol spec and its evidence:
 * knowledge/staging/faceclaw-ring-protocol-decode-return.md in the TLC
 * knowledge base. Everything below is implemented from that document; the
 * places where it is explicitly *not* solved are marked UNSOLVED and are
 * surfaced raw rather than guessed at.
 */
public final class RingProtocol {
    private RingProtocol() {
    }

    /** CRC-32C polynomial, MSB-first / non-reflected form. Not CRC-32 (0x04C11DB7). */
    private static final int CRC32C_POLY = 0x1EDC6F41;

    public static final int MAGIC = 0x64;
    public static final int HEADER_LEN = 15;
    /** A continuation frame is FLAG(1) + CRC32(4) and then raw remainder bytes. */
    public static final int CONTINUATION_PREFIX_LEN = 5;

    public static final int FLAG_PLAIN = 0x00;
    public static final int FLAG_FRAGMENTED = 0x01;

    public static final int CHAN_DEVICE = 0x01;
    public static final int CHAN_HEALTH = 0x02;

    public static final int KIND_REQ = 0x00;
    public static final int KIND_ACK = 0x01;
    public static final int KIND_DATA = 0x02;
    public static final int KIND_RSP = 0x03;

    /** Every health record type uses CMD_LO = 0x01; the type lives in CMD_HI. */
    public static final int CMD_LO_HEALTH = 0x01;
    public static final int CMD_HI_HEART_RATE = 0x01;
    public static final int CMD_HI_SPO2 = 0x02;
    public static final int CMD_HI_HRV = 0x04;
    public static final int CMD_HI_STEPS = 0x05;
    public static final int CMD_HI_SLEEP = 0x06;

    /** Device/system channel commands all have CMD_HI = 0x00. */
    public static final int CMD_HI_DEVICE = 0x00;
    public static final int CMD_LO_PAGE_ACK = 0x7E;

    /**
     * The five health pulls, in the order Even's own app issues them:
     * heart rate, HRV, SpO2, sleep, steps. That order is identical in all four
     * sync bursts of the reference capture. (It is NOT the order the spec
     * document happens to list them in — that is just its presentation order.)
     * Whether the order matters to the ring is untested; matching the app is
     * the cheapest way not to find out the hard way.
     */
    public static final int[] HEALTH_COMMANDS = {
        CMD_HI_HEART_RATE,
        CMD_HI_HRV,
        CMD_HI_SPO2,
        CMD_HI_SLEEP,
        CMD_HI_STEPS,
    };

    /** Constant terminator on every record body of every type. Meaning unknown. */
    private static final byte[] RECORD_FOOTER = {(byte) 0x94, 0x33, 0x01, 0x00};

    /** ANCHOR field marker: 0x10 0xFF then a u32 LE Unix timestamp. */
    private static final int ANCHOR_MARK_HI = 0x10;
    private static final int ANCHOR_MARK_LO = 0xFF;

    /** Returned by anchor/timestamp accessors when the value is not known. */
    public static final long UNKNOWN_TIME = -1L;

    private static final byte[] EMPTY = new byte[0];

    // ------------------------------------------------------------------
    // CRC
    // ------------------------------------------------------------------

    /**
     * CRC-32C over {@code data[from, to)}: polynomial 0x1EDC6F41, MSB-first,
     * init 0, no reflection, no final xor. Verified against 188/188 frames in
     * the reference capture.
     */
    public static int crc32(byte[] data, int from, int to) {
        int crc = 0;
        for (int i = from; i < to; i++) {
            crc ^= (data[i] & 0xff) << 24;
            for (int bit = 0; bit < 8; bit++) {
                if ((crc & 0x80000000) != 0) {
                    crc = (crc << 1) ^ CRC32C_POLY;
                } else {
                    crc = crc << 1;
                }
            }
        }
        return crc;
    }

    public static int crc32(byte[] data) {
        return crc32(data, 0, data == null ? 0 : data.length);
    }

    // ------------------------------------------------------------------
    // Frame building
    // ------------------------------------------------------------------

    /**
     * Build one complete, CRC-correct frame. Fragmentation is a receive-side
     * concern only: nothing we send approaches the 244-byte ATT ceiling.
     */
    public static byte[] buildFrame(int chan, int kind, int cmdHi, int cmdLo, int seq, byte[] payload) {
        byte[] body = payload == null ? EMPTY : payload;
        int total = HEADER_LEN + body.length;
        byte[] frame = new byte[total];
        frame[0] = (byte) FLAG_PLAIN;
        frame[5] = (byte) MAGIC;
        frame[6] = (byte) (chan & 0xff);
        frame[7] = (byte) MAGIC;
        frame[8] = (byte) (seq & 0xff);
        frame[9] = 0x00;
        frame[10] = (byte) (kind & 0xff);
        frame[11] = (byte) (cmdHi & 0xff);
        frame[12] = (byte) (cmdLo & 0xff);
        int plen = total - 5;
        frame[13] = (byte) (plen & 0xff);
        frame[14] = (byte) ((plen >>> 8) & 0xff);
        System.arraycopy(body, 0, frame, HEADER_LEN, body.length);
        writeIntLe(frame, 1, crc32(frame, 5, total));
        return frame;
    }

    /**
     * A request frame. Health requests carry no arguments at all: the payload
     * is the 2-byte nonce and nothing else.
     *
     * <p>The nonce is a free per-message id — it is covered by the frame CRC but
     * is not content-derived, so any value works. It is encoded little-endian.
     */
    public static byte[] buildRequest(int chan, int cmdHi, int cmdLo, int seq, int nonce) {
        return buildFrame(chan, KIND_REQ, cmdHi, cmdLo, seq, nonceBytes(nonce));
    }

    /** One of the five health pulls; see {@link #HEALTH_COMMANDS}. */
    public static byte[] buildHealthRequest(int cmdHi, int seq, int nonce) {
        return buildRequest(CHAN_HEALTH, cmdHi, CMD_LO_HEALTH, seq, nonce);
    }

    /**
     * The per-page acknowledgement: command 00:7E on the DEVICE channel,
     * echoing the sequence number of the DATA page being acknowledged.
     *
     * <p>Payload is 12 bytes: the usual 2-byte nonce, then
     * {@code 02 <cmd_hi> <cmd_lo> 00 <page_seq>}, then five zero bytes. (Note
     * the echoed page seq is at payload offset 6, after the nonce — a spec doc
     * that describes the payload as starting at {@code 02} is off by the nonce.)
     *
     * <p>The frame's own SEQ is the phone's shared counter, NOT the echoed page
     * seq: across 20 ACKs in the reference capture the two are always different,
     * and the header SEQ continues the same +1 sequence used by every other
     * phone-to-ring write on both channels.
     *
     * <p>Whether the ring actually *requires* this is untested — Even's app
     * sends one for every page without exception (20/20), but no page has ever
     * been deliberately left unacknowledged to see what happens.
     */
    public static byte[] buildPageAck(int seq, int nonce, int ackedCmdHi, int ackedCmdLo, int pageSeq) {
        byte[] payload = new byte[12];
        payload[0] = (byte) (nonce & 0xff);
        payload[1] = (byte) ((nonce >>> 8) & 0xff);
        payload[2] = 0x02;
        payload[3] = (byte) (ackedCmdHi & 0xff);
        payload[4] = (byte) (ackedCmdLo & 0xff);
        payload[5] = 0x00;
        payload[6] = (byte) (pageSeq & 0xff);
        // payload[7..11] stay zero.
        return buildFrame(CHAN_DEVICE, KIND_ACK, CMD_HI_DEVICE, CMD_LO_PAGE_ACK, seq, payload);
    }

    private static byte[] nonceBytes(int nonce) {
        return new byte[] {(byte) (nonce & 0xff), (byte) ((nonce >>> 8) & 0xff)};
    }

    // ------------------------------------------------------------------
    // Frame parsing and fragment reassembly
    // ------------------------------------------------------------------

    /** True when a value could be the start of a frame (magic bytes in place). */
    public static boolean looksLikeHeader(byte[] value) {
        return value != null
            && value.length >= HEADER_LEN
            && (value[5] & 0xff) == MAGIC
            && (value[7] & 0xff) == MAGIC;
    }

    /** Total frame length declared by PLEN, or -1 when this is not a header. */
    public static int declaredLength(byte[] value) {
        if (!looksLikeHeader(value)) {
            return -1;
        }
        int plen = (value[13] & 0xff) | ((value[14] & 0xff) << 8);
        int total = plen + 5;
        return total < HEADER_LEN ? -1 : total;
    }

    /** Parse a complete (already reassembled) frame. Returns null if malformed. */
    public static Frame parse(byte[] frame) {
        if (frame == null || frame.length < HEADER_LEN) {
            return null;
        }
        if ((frame[5] & 0xff) != MAGIC || (frame[7] & 0xff) != MAGIC) {
            return null;
        }
        int plen = (frame[13] & 0xff) | ((frame[14] & 0xff) << 8);
        if (plen + 5 != frame.length) {
            return null;
        }
        int storedCrc = readIntLe(frame, 1);
        int actualCrc = crc32(frame, 5, frame.length);
        byte[] payload = Arrays.copyOfRange(frame, HEADER_LEN, frame.length);
        return new Frame(
            frame[0] & 0xff,
            frame[6] & 0xff,
            frame[8] & 0xff,
            frame[10] & 0xff,
            frame[11] & 0xff,
            frame[12] & 0xff,
            payload,
            frame,
            storedCrc == actualCrc
        );
    }

    /**
     * Feeds raw ATT notification values in and produces complete frames,
     * rejoining fragmented ones.
     *
     * <p>Fragmentation (spec §2.3): when a frame exceeds the 244-byte ATT
     * ceiling the ring sets FLAG=0x01, sends the first 244 bytes, and later
     * sends a continuation frame in a different, headerless shape — FLAG(1),
     * CRC32(4), then the remaining bytes verbatim.
     *
     * <p>Two things the spec document does not say, both measured from the
     * reference capture and both load-bearing here:
     * <ul>
     *   <li><b>The continuation is not adjacent.</b> In one of the six captured
     *       fragmentations three unrelated complete frames arrive between the
     *       first fragment and its continuation, so a "next value is the rest"
     *       rule mis-joins. Complete frames are therefore still parsed normally
     *       while a fragment is outstanding.</li>
     *   <li><b>The continuation's own CRC field is not reliably the reassembled
     *       CRC.</b> It matched in five of six cases and differed in the sixth
     *       (whose join is nonetheless byte-exact and CRC-valid), so the
     *       continuation must not be matched by comparing CRC fields.</li>
     * </ul>
     *
     * <p>What is reliable, in all six cases, is length: a continuation carries
     * exactly {@code CONTINUATION_PREFIX_LEN + bytesStillNeeded} bytes and does
     * not itself look like a header. The reassembled frame's CRC is the real
     * validator and is always checked.
     */
    public static final class Reassembler {
        /**
         * Give up on an outstanding fragment after this many intervening
         * complete frames. The observed worst case is 3; this is slack, not a
         * measured bound.
         */
        private static final int MAX_INTERLEAVED_FRAMES = 16;

        private byte[] pending;
        private int pendingTotal;
        private int interleaved;

        public boolean hasPending() {
            return pending != null;
        }

        public void reset() {
            pending = null;
            pendingTotal = 0;
            interleaved = 0;
        }

        /**
         * Offer one ATT notification value. The result says whether the value
         * belonged to this protocol at all (so the caller can fall through to
         * the gesture decoder) and carries a frame once one is complete.
         */
        public Intake accept(byte[] value) {
            if (value == null || value.length == 0) {
                return Intake.ignored();
            }

            if (pending != null) {
                int needed = pendingTotal - pending.length;
                if (value.length == CONTINUATION_PREFIX_LEN + needed && !looksLikeHeader(value)) {
                    byte[] joined = new byte[pendingTotal];
                    System.arraycopy(pending, 0, joined, 0, pending.length);
                    System.arraycopy(value, CONTINUATION_PREFIX_LEN, joined, pending.length, needed);
                    reset();
                    return complete(joined);
                }
                if (!looksLikeHeader(value)) {
                    int dropped = pendingTotal;
                    reset();
                    return Intake.consumed(String.format(
                        Locale.US,
                        "dropped %d-byte fragment: continuation was %d bytes, expected %d",
                        dropped, value.length, CONTINUATION_PREFIX_LEN + needed));
                }
                if (++interleaved > MAX_INTERLEAVED_FRAMES) {
                    int dropped = pendingTotal;
                    reset();
                    // Fall through and parse this value as a fresh frame.
                    Intake result = acceptFresh(value);
                    return result.withNote(String.format(
                        Locale.US, "dropped %d-byte fragment: continuation never arrived", dropped));
                }
            }

            return acceptFresh(value);
        }

        private Intake acceptFresh(byte[] value) {
            int total = declaredLength(value);
            if (total < 0) {
                return Intake.ignored();
            }
            if (value.length >= total) {
                return complete(Arrays.copyOf(value, total));
            }
            // Only one fragment is ever outstanding in the reference capture,
            // but never silently clobber one if that assumption breaks.
            String clobbered = pending == null ? null : String.format(
                Locale.US, "dropped %d-byte fragment: a new fragment started", pendingTotal);
            pending = Arrays.copyOf(value, value.length);
            pendingTotal = total;
            interleaved = 0;
            return Intake.consumed(String.format(
                Locale.US, "fragment start, %d of %d bytes", value.length, total)).withNote(clobbered);
        }

        private Intake complete(byte[] raw) {
            Frame frame = parse(raw);
            if (frame == null) {
                return Intake.consumed("malformed frame, " + raw.length + " bytes");
            }
            return Intake.frame(frame);
        }
    }

    /** The outcome of offering one ATT value to a {@link Reassembler}. */
    public static final class Intake {
        /** True when the value belonged to this protocol and must not be re-handled. */
        public final boolean consumed;
        /** Non-null once a complete frame is available. Check {@link Frame#crcOk}. */
        public final Frame frame;
        /** Human-readable detail for logging, or null. */
        public final String note;

        private Intake(boolean consumed, Frame frame, String note) {
            this.consumed = consumed;
            this.frame = frame;
            this.note = note;
        }

        static Intake ignored() {
            return new Intake(false, null, null);
        }

        static Intake consumed(String note) {
            return new Intake(true, null, note);
        }

        static Intake frame(Frame frame) {
            return new Intake(true, frame, null);
        }

        Intake withNote(String extra) {
            if (extra == null) {
                return this;
            }
            return new Intake(consumed, frame, note == null ? extra : note + "; " + extra);
        }
    }

    /** One complete frame. */
    public static final class Frame {
        public final int flag;
        public final int chan;
        public final int seq;
        public final int kind;
        public final int cmdHi;
        public final int cmdLo;
        /** PLEN - 10 bytes. payload[0:2] is the sender's nonce. */
        public final byte[] payload;
        public final byte[] raw;
        public final boolean crcOk;

        Frame(int flag, int chan, int seq, int kind, int cmdHi, int cmdLo,
              byte[] payload, byte[] raw, boolean crcOk) {
            this.flag = flag;
            this.chan = chan;
            this.seq = seq;
            this.kind = kind;
            this.cmdHi = cmdHi;
            this.cmdLo = cmdLo;
            this.payload = payload;
            this.raw = raw;
            this.crcOk = crcOk;
        }

        public boolean isHealth() {
            return chan == CHAN_HEALTH;
        }

        public String commandLabel() {
            return String.format(Locale.US, "%02x:%02x", cmdHi, cmdLo);
        }

        public String describe() {
            return String.format(
                Locale.US,
                "chan=%02x kind=%02x cmd=%s seq=%02x len=%d",
                chan, kind, commandLabel(), seq, raw.length);
        }
    }

    // ------------------------------------------------------------------
    // Record decoding
    // ------------------------------------------------------------------

    /**
     * Decode a health DATA page. Returns null when the frame is not a health
     * DATA page or its body does not match the layout for its type.
     */
    public static HealthRecord decode(Frame frame, long receivedAtMs) {
        if (frame == null || !frame.crcOk || !frame.isHealth() || frame.kind != KIND_DATA) {
            return null;
        }
        if (frame.cmdLo != CMD_LO_HEALTH) {
            return null;
        }
        switch (frame.cmdHi) {
            case CMD_HI_HEART_RATE:
            case CMD_HI_SPO2:
            case CMD_HI_HRV:
                return decodeHourly(frame, receivedAtMs);
            case CMD_HI_STEPS:
                return decodeSteps(frame, receivedAtMs);
            case CMD_HI_SLEEP:
                return decodeSleep(frame, receivedAtMs);
            default:
                return null;
        }
    }

    /**
     * Heart rate / SpO2 / HRV: an hourly {@code [index][avg][max][min]} series.
     *
     * <p>The value width W is not guessed — it is resolved from the body length
     * by {@code len == W + COUNT * (1 + 3W)}, which has a unique solution for
     * every frame in the reference capture (W=1 for HR and SpO2, W=2 for HRV).
     */
    public static HourlyRecord decodeHourly(Frame frame, long receivedAtMs) {
        byte[] pay = frame.payload;
        if (pay.length < 13 + RECORD_FOOTER.length) {
            return null;
        }
        int count = pay[2] & 0xff;
        long anchor = anchorUnixSeconds(pay);
        long tag = readUInt32Le(pay, 9);

        int bodyLen = pay.length - 13 - RECORD_FOOTER.length;
        int width;
        if (bodyLen == 1 + count * 4) {
            width = 1;
        } else if (bodyLen == 2 + count * 7) {
            width = 2;
        } else {
            return null;
        }

        int current = readUIntLe(pay, 13, width);
        int offset = 13 + width;
        HourlyGroup[] groups = new HourlyGroup[count];
        for (int i = 0; i < count; i++) {
            int hourIndex = pay[offset] & 0xff;
            offset++;
            int avg = readUIntLe(pay, offset, width);
            offset += width;
            int max = readUIntLe(pay, offset, width);
            offset += width;
            int min = readUIntLe(pay, offset, width);
            offset += width;
            long unix = anchor == UNKNOWN_TIME ? UNKNOWN_TIME : anchor + hourIndex * 3600L;
            groups[i] = new HourlyGroup(hourIndex, avg, max, min, unix);
        }
        return new HourlyRecord(frame.cmdHi, receivedAtMs, anchor, tag, current, width, groups);
    }

    /**
     * Steps / activity buckets: {@code [index][v1][v2][v3]} after the record
     * prefix. v1 (steps) is proven against a full-day total; v2 and v3 are
     * calorie-shaped but unconfirmed, and the bucket index does NOT map to a
     * known wall-clock time (see {@link StepsBucket}).
     */
    public static StepsRecord decodeSteps(Frame frame, long receivedAtMs) {
        byte[] pay = frame.payload;
        if (pay.length < 9 + RECORD_FOOTER.length) {
            return null;
        }
        int count = pay[2] & 0xff;
        if (pay.length != 9 + count * 7 + RECORD_FOOTER.length) {
            return null;
        }
        long anchor = anchorUnixSeconds(pay);
        int offset = 9;
        StepsBucket[] buckets = new StepsBucket[count];
        for (int i = 0; i < count; i++) {
            int index = pay[offset] & 0xff;
            int steps = readUInt16Le(pay, offset + 1);
            int v2 = readUInt16Le(pay, offset + 3);
            int v3 = readUInt16Le(pay, offset + 5);
            offset += 7;
            buckets[i] = new StepsBucket(index, steps, v2, v3);
        }
        return new StepsRecord(receivedAtMs, anchor, buckets);
    }

    /**
     * A sleep session. The ring transmits pre-classified stages, per-stage
     * totals and the session boundaries; nothing is computed phone-side.
     *
     * <p>{@code startTs}/{@code endTs} are ring-relative seconds, NOT Unix
     * timestamps — see {@link SleepRecord}.
     */
    public static SleepRecord decodeSleep(Frame frame, long receivedAtMs) {
        byte[] pay = frame.payload;
        if (pay.length < 3) {
            return null;
        }
        int recordState = pay[2] & 0xff;
        byte[] unknownA = safeRange(pay, 3, 9);
        long unknownTag = pay.length >= 13 ? readUInt32Le(pay, 9) : UNKNOWN_TIME;
        if (recordState != 1 || pay.length < 34 + RECORD_FOOTER.length) {
            // RECSTATE 2 is the empty / end-of-list marker.
            return new SleepRecord(
                receivedAtMs, recordState, unknownA, unknownTag,
                0, 0, 0, 0, 0, 0, 0, new SleepSegment[0]);
        }

        long startTs = readUInt32Le(pay, 14);
        long endTs = readUInt32Le(pay, 18);
        int totalTime = readUInt16Le(pay, 22);
        int wakeTime = readUInt16Le(pay, 24);
        int remTime = readUInt16Le(pay, 26);
        int lightTime = readUInt16Le(pay, 28);
        int deepTime = readUInt16Le(pay, 30);
        int segmentCount = pay[32] & 0xff;
        if (pay.length != 34 + segmentCount * 3 + RECORD_FOOTER.length) {
            return null;
        }
        SleepSegment[] segments = new SleepSegment[segmentCount];
        int offset = 34;
        for (int i = 0; i < segmentCount; i++) {
            int stage = pay[offset] & 0xff;
            int halfMinutes = readUInt16Le(pay, offset + 1);
            offset += 3;
            segments[i] = new SleepSegment(stage, halfMinutes);
        }
        return new SleepRecord(
            receivedAtMs, recordState, unknownA, unknownTag,
            startTs, endTs, totalTime, wakeTime, remTime, lightTime, deepTime, segments);
    }

    /**
     * The record's day anchor as Unix epoch seconds, or {@link #UNKNOWN_TIME}
     * when the anchor field is the six-zero-byte "backlog page" form.
     *
     * <p><b>UNSOLVED:</b> a backlog page's true base is not understood as a
     * general rule. One capture's backlog base landed at 2026-09-08 23:48:49
     * local, which is the moment that sync ran plus a per-type offset — it is
     * not a fixed offset from midnight and must not be hardcoded. Callers get
     * {@link #UNKNOWN_TIME} and the raw hour index instead of an invented
     * absolute time.
     */
    public static long anchorUnixSeconds(byte[] payload) {
        if (payload == null || payload.length < 9) {
            return UNKNOWN_TIME;
        }
        if ((payload[3] & 0xff) == ANCHOR_MARK_HI && (payload[4] & 0xff) == ANCHOR_MARK_LO) {
            return readUInt32Le(payload, 5);
        }
        return UNKNOWN_TIME;
    }

    // ------------------------------------------------------------------
    // Decoded record types
    // ------------------------------------------------------------------

    /** Common supertype so one store can hold every decoded page. */
    public abstract static class HealthRecord {
        public final int cmdHi;
        public final long receivedAtMs;

        HealthRecord(int cmdHi, long receivedAtMs) {
            this.cmdHi = cmdHi;
            this.receivedAtMs = receivedAtMs;
        }

        /** The metric name, for logs. */
        public String metric() {
            switch (cmdHi) {
                case CMD_HI_HEART_RATE: return "heart_rate";
                case CMD_HI_SPO2: return "spo2";
                case CMD_HI_HRV: return "hrv";
                case CMD_HI_STEPS: return "steps";
                case CMD_HI_SLEEP: return "sleep";
                default: return String.format(Locale.US, "cmd%02x", cmdHi);
            }
        }

        /** A one-line summary safe to put in a log. */
        public abstract String summary();
    }

    /** Heart rate, SpO2 or HRV: one page of hourly buckets. */
    public static final class HourlyRecord extends HealthRecord {
        /** Day anchor in Unix seconds, or {@link #UNKNOWN_TIME} on a backlog page. */
        public final long anchorUnixSeconds;
        /** Per-metric "last measured at". See the 4-hour skew note in the spec. */
        public final long tagRaw;
        /** The metric's latest value. */
        public final int current;
        /** 1 byte for HR/SpO2, 2 for HRV; resolved from the body length. */
        public final int valueWidth;
        public final HourlyGroup[] groups;

        HourlyRecord(int cmdHi, long receivedAtMs, long anchorUnixSeconds, long tagRaw,
                     int current, int valueWidth, HourlyGroup[] groups) {
            super(cmdHi, receivedAtMs);
            this.anchorUnixSeconds = anchorUnixSeconds;
            this.tagRaw = tagRaw;
            this.current = current;
            this.valueWidth = valueWidth;
            this.groups = groups;
        }

        /** True when this page has no anchor, i.e. it is a backlog page. */
        public boolean isBacklog() {
            return anchorUnixSeconds == UNKNOWN_TIME;
        }

        @Override public String summary() {
            return String.format(
                Locale.US,
                "%s groups=%d width=%d current=%d anchor=%s tag=%d",
                metric(), groups.length, valueWidth, current,
                isBacklog() ? "backlog(unanchored)" : Long.toString(anchorUnixSeconds),
                tagRaw);
        }
    }

    /** One hourly bucket. */
    public static final class HourlyGroup {
        /** Raw index as sent. On an anchored page this is hours since the anchor. */
        public final int hourIndex;
        public final int avg;
        public final int max;
        public final int min;
        /**
         * Absolute Unix seconds for this bucket, or {@link #UNKNOWN_TIME} on a
         * backlog page — where the base is UNSOLVED and deliberately not guessed.
         */
        public final long unixSeconds;

        HourlyGroup(int hourIndex, int avg, int max, int min, long unixSeconds) {
            this.hourIndex = hourIndex;
            this.avg = avg;
            this.max = max;
            this.min = min;
            this.unixSeconds = unixSeconds;
        }
    }

    /** One page of activity buckets. */
    public static final class StepsRecord extends HealthRecord {
        public final long anchorUnixSeconds;
        public final StepsBucket[] buckets;

        StepsRecord(long receivedAtMs, long anchorUnixSeconds, StepsBucket[] buckets) {
            super(CMD_HI_STEPS, receivedAtMs);
            this.anchorUnixSeconds = anchorUnixSeconds;
            this.buckets = buckets;
        }

        public int totalSteps() {
            int total = 0;
            for (StepsBucket bucket : buckets) {
                total += bucket.steps;
            }
            return total;
        }

        @Override public String summary() {
            return String.format(
                Locale.US,
                "steps buckets=%d total=%d anchor=%s",
                buckets.length, totalSteps(),
                anchorUnixSeconds == UNKNOWN_TIME ? "none" : Long.toString(anchorUnixSeconds));
        }
    }

    /**
     * One activity bucket.
     *
     * <p><b>UNSOLVED:</b> {@link #index} does not map to a known wall-clock
     * time. It runs 0-7, 10, 11, 13-34 and then jumps to 130+, and no bucket
     * width at any base reproduces the app's own per-bucket distribution — even
     * though the steps total across all buckets is exactly right. The raw index
     * is stored as sent; no time-of-day mapping is invented.
     */
    public static final class StepsBucket {
        public final int index;
        /** Confirmed: summed over a page this equals the app's daily step total. */
        public final int steps;
        /** UNCONFIRMED: calorie-shaped (v3 - v2 tracks per-bucket resting kcal). */
        public final int calorieLike2;
        /** UNCONFIRMED: calorie-shaped. */
        public final int calorieLike3;

        StepsBucket(int index, int steps, int calorieLike2, int calorieLike3) {
            this.index = index;
            this.steps = steps;
            this.calorieLike2 = calorieLike2;
            this.calorieLike3 = calorieLike3;
        }
    }

    /**
     * One sleep session.
     *
     * <p><b>{@link #startTs} and {@link #endTs} are ring-relative seconds, not
     * Unix time.</b> Even's own app gets this wrong and stamps live-pushed
     * sessions with timestamps in 1979. Do not feed them to a date formatter.
     *
     * <p><b>UNSOLVED:</b> {@link #unknownPrefix} (6 bytes) and
     * {@link #unknownTag} (u32) are not decoded; one of them probably carries
     * the session date, which would remove the anchoring problem. They are
     * stored raw rather than interpreted.
     */
    public static final class SleepRecord extends HealthRecord {
        /** 1 = a real record, 2 = the empty / end-of-list marker. */
        public final int recordState;
        /** UNSOLVED per-record 6-byte field (payload[3:9]). Stored raw. */
        public final byte[] unknownPrefix;
        /** UNSOLVED u32 tag (payload[9:13]). Stored raw. */
        public final long unknownTag;
        /** Ring-relative seconds, NOT Unix. */
        public final long startTs;
        /** Ring-relative seconds, NOT Unix. */
        public final long endTs;
        public final int totalTime;
        public final int wakeTime;
        public final int remTime;
        public final int lightTime;
        public final int deepTime;
        /**
         * The stage series. Stage ids are the same 0-3 encoding the app's own
         * export uses, but which id means wake/rem/light/deep is NOT stated by
         * the spec and is deliberately not guessed here — see
         * {@link #halfMinutesForStage}.
         */
        public final SleepSegment[] segments;

        SleepRecord(long receivedAtMs, int recordState, byte[] unknownPrefix, long unknownTag,
                    long startTs, long endTs, int totalTime, int wakeTime, int remTime,
                    int lightTime, int deepTime, SleepSegment[] segments) {
            super(CMD_HI_SLEEP, receivedAtMs);
            this.recordState = recordState;
            this.unknownPrefix = unknownPrefix;
            this.unknownTag = unknownTag;
            this.startTs = startTs;
            this.endTs = endTs;
            this.totalTime = totalTime;
            this.wakeTime = wakeTime;
            this.remTime = remTime;
            this.lightTime = lightTime;
            this.deepTime = deepTime;
            this.segments = segments;
        }

        public boolean isRealRecord() {
            return recordState == 1;
        }

        public int totalHalfMinutes() {
            int total = 0;
            for (SleepSegment segment : segments) {
                total += segment.halfMinutes;
            }
            return total;
        }

        public int halfMinutesForStage(int stage) {
            int total = 0;
            for (SleepSegment segment : segments) {
                if (segment.stage == stage) {
                    total += segment.halfMinutes;
                }
            }
            return total;
        }

        /**
         * The two whole-record arithmetic identities from the spec, which held
         * exactly for all ten real records in the reference capture. A false
         * result means the body was mis-parsed.
         */
        public boolean identitiesHold() {
            if (!isRealRecord()) {
                return true;
            }
            int seconds = totalHalfMinutes() * 30;
            return seconds == totalTime + wakeTime && seconds == (int) (endTs - startTs);
        }

        @Override public String summary() {
            if (!isRealRecord()) {
                return String.format(Locale.US, "sleep marker state=%d", recordState);
            }
            return String.format(
                Locale.US,
                "sleep segments=%d total=%ds wake=%d rem=%d light=%d deep=%d relStart=%d relEnd=%d identities=%s",
                segments.length, totalTime, wakeTime, remTime, lightTime, deepTime,
                startTs, endTs, identitiesHold());
        }
    }

    /** One stage run: a stage id and a duration in half-minutes (30 s units). */
    public static final class SleepSegment {
        public final int stage;
        public final int halfMinutes;

        SleepSegment(int stage, int halfMinutes) {
            this.stage = stage;
            this.halfMinutes = halfMinutes;
        }
    }

    // ------------------------------------------------------------------
    // Little-endian helpers
    // ------------------------------------------------------------------

    private static void writeIntLe(byte[] out, int offset, int value) {
        out[offset] = (byte) (value & 0xff);
        out[offset + 1] = (byte) ((value >>> 8) & 0xff);
        out[offset + 2] = (byte) ((value >>> 16) & 0xff);
        out[offset + 3] = (byte) ((value >>> 24) & 0xff);
    }

    private static int readIntLe(byte[] data, int offset) {
        return (data[offset] & 0xff)
            | ((data[offset + 1] & 0xff) << 8)
            | ((data[offset + 2] & 0xff) << 16)
            | ((data[offset + 3] & 0xff) << 24);
    }

    private static long readUInt32Le(byte[] data, int offset) {
        return readIntLe(data, offset) & 0xffffffffL;
    }

    private static int readUInt16Le(byte[] data, int offset) {
        return (data[offset] & 0xff) | ((data[offset + 1] & 0xff) << 8);
    }

    private static int readUIntLe(byte[] data, int offset, int width) {
        int value = 0;
        for (int i = 0; i < width; i++) {
            value |= (data[offset + i] & 0xff) << (8 * i);
        }
        return value;
    }

    private static byte[] safeRange(byte[] data, int from, int to) {
        if (data == null || from >= data.length) {
            return EMPTY;
        }
        return Arrays.copyOfRange(data, from, Math.min(to, data.length));
    }

    /** Hex, for logs. Mirrors FaceclawBleCommunicator.hex(). */
    public static String hex(byte[] data) {
        if (data == null || data.length == 0) {
            return "";
        }
        char[] digits = "0123456789abcdef".toCharArray();
        char[] out = new char[data.length * 2];
        for (int i = 0; i < data.length; i++) {
            int value = data[i] & 0xff;
            out[i * 2] = digits[value >>> 4];
            out[i * 2 + 1] = digits[value & 0x0f];
        }
        return new String(out);
    }

    /** The five health requests, ready to write, sharing one ascending seq run. */
    public static List<byte[]> buildHealthRequestBurst(int firstSeq, int firstNonce) {
        List<byte[]> frames = new ArrayList<>(HEALTH_COMMANDS.length);
        int seq = firstSeq;
        int nonce = firstNonce;
        for (int cmdHi : HEALTH_COMMANDS) {
            frames.add(buildHealthRequest(cmdHi, seq, nonce));
            seq = (seq + 1) & 0xff;
            nonce = (nonce + 1) & 0xffff;
        }
        return frames;
    }
}
