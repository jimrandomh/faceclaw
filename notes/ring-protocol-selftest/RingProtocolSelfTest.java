package com.faceclaw.app;

import java.util.Arrays;
import java.util.List;

/**
 * Standalone self-test for {@link RingProtocol}. No Android APIs and no
 * hardware: every byte-manipulation path is exercised against either frames
 * copied from the reference capture or synthetic bodies built from the spec's
 * field layout.
 *
 * <pre>
 *   javac -d /tmp/rpt App_Resources/Android/src/main/java/com/faceclaw/app/g2protocol/RingProtocol.java \
 *                     notes/ring-protocol-selftest/RingProtocolSelfTest.java
 *   java -cp /tmp/rpt com.faceclaw.app.RingProtocolSelfTest
 * </pre>
 *
 * <p>The captured frames reproduced below are requests and page-ACKs only.
 * Those carry a nonce, a command id and a sequence number — no biometric
 * values. No captured DATA page appears here, deliberately.
 */
public final class RingProtocolSelfTest {
    private static int checks;
    private static int failures;

    public static void main(String[] args) {
        testCrcAndRequestRoundTrip();
        testFiveHealthRequests();
        testPageAckAgainstCapture();
        testParseRejectsGarbage();
        testFragmentReassembly();
        testHourlyDecode();
        testStepsDecode();
        testSleepDecodeAndIdentities();

        System.out.println();
        System.out.println(failures == 0
            ? "PASS: all " + checks + " checks"
            : "FAIL: " + failures + " of " + checks + " checks");
        if (failures != 0) {
            System.exit(1);
        }
    }

    // ------------------------------------------------------------------

    /**
     * Rebuild captured request pkt 9166 from its decoded fields alone. If the
     * CRC-32C parameters or the header layout are wrong by even one bit this
     * cannot reproduce the captured bytes.
     */
    private static void testCrcAndRequestRoundTrip() {
        section("CRC + request round-trip (captured pkt 9166)");
        byte[] built = RingProtocol.buildRequest(
            RingProtocol.CHAN_HEALTH,
            RingProtocol.CMD_HI_HEART_RATE,
            RingProtocol.CMD_LO_HEALTH,
            0x06,
            0x08ca);
        expectHex("pkt 9166", "00db64265a64026406000001010c00ca08", built);

        RingProtocol.Frame frame = RingProtocol.parse(built);
        expect("parses back", frame != null && frame.crcOk);
        expect("chan", frame.chan == RingProtocol.CHAN_HEALTH);
        expect("kind REQ", frame.kind == RingProtocol.KIND_REQ);
        expect("seq", frame.seq == 0x06);
        expect("cmd 01:01", frame.cmdHi == 0x01 && frame.cmdLo == 0x01);
        expect("payload is the 2-byte nonce", frame.payload.length == 2);

        // A single flipped payload bit must invalidate the CRC.
        byte[] tampered = built.clone();
        tampered[15] ^= 0x01;
        RingProtocol.Frame bad = RingProtocol.parse(tampered);
        expect("tampered frame fails CRC", bad != null && !bad.crcOk);
    }

    /** The five ready-to-send health requests, seq=1, nonce=0. */
    private static void testFiveHealthRequests() {
        section("five health requests (spec section 9)");
        String[][] expected = {
            {"heart rate", "00450fe48f64026401000001010c000000"},
            {"SpO2",       "000d3fd33364026401000002010c000000"},
            {"HRV",        "00dc30615564026401000004010c000000"},
            {"steps",      "00e4208c3e64026401000005010c000000"},
            {"sleep",      "00ac10bb8264026401000006010c000000"},
        };
        int[] commands = {
            RingProtocol.CMD_HI_HEART_RATE,
            RingProtocol.CMD_HI_SPO2,
            RingProtocol.CMD_HI_HRV,
            RingProtocol.CMD_HI_STEPS,
            RingProtocol.CMD_HI_SLEEP,
        };
        for (int i = 0; i < commands.length; i++) {
            byte[] built = RingProtocol.buildHealthRequest(commands[i], 0x01, 0x0000);
            expectHex(expected[i][0], expected[i][1], built);
        }

        // The convenience burst builder must produce the same first frame and
        // then advance the shared sequence counter by one per frame.
        List<byte[]> burst = RingProtocol.buildHealthRequestBurst(0x01, 0x0000);
        expect("burst has five frames", burst.size() == 5);
        expectHex("burst[0] == heart rate", expected[0][1], burst.get(0));
        boolean seqRuns = true;
        for (int i = 0; i < burst.size(); i++) {
            RingProtocol.Frame f = RingProtocol.parse(burst.get(i));
            if (f == null || !f.crcOk || f.seq != 0x01 + i) {
                seqRuns = false;
            }
        }
        expect("burst sequence numbers run 1..5 and all CRCs are valid", seqRuns);
    }

    /**
     * Rebuild real captured page-ACKs. This is what pins down the two things
     * the prose spec got wrong: the payload begins with the usual nonce (so the
     * echoed page seq is at offset 6, not 4), and the frame's own SEQ is the
     * phone's shared counter rather than the echoed page seq.
     */
    private static void testPageAckAgainstCapture() {
        section("page ACK 00:7E rebuilt from captured frames");
        // seq, nonce, ackedCmdHi, ackedCmdLo, pageSeq, expected hex
        Object[][] cases = {
            {0x0d, 0x5f49, 0x01, 0x01, 0x03, "005e55d80b6401640d0001007e1600495f02010100030000000000"},
            {0x13, 0xdc10, 0x04, 0x01, 0x07, "00a2bae3c4640164130001007e160010dc02040100070000000000"},
            {0x17, 0x86e9, 0x02, 0x01, 0x09, "002c006c61640164170001007e1600e98602020100090000000000"},
            {0x23, 0x634c, 0x06, 0x01, 0x13, "00b96c8823640164230001007e16004c6302060100130000000000"},
            {0x25, 0x46f2, 0x05, 0x01, 0x14, "00474ee8b8640164250001007e1600f24602050100140000000000"},
            {0x14, 0x7bc3, 0x05, 0x01, 0x3b, "00f3a5a917640164140001007e1600c37b020501003b0000000000"},
        };
        for (Object[] c : cases) {
            byte[] built = RingProtocol.buildPageAck(
                (Integer) c[0], (Integer) c[1], (Integer) c[2], (Integer) c[3], (Integer) c[4]);
            expectHex("ack for cmd " + hex2((Integer) c[2]) + ":" + hex2((Integer) c[3])
                + " page seq " + hex2((Integer) c[4]), (String) c[5], built);
        }

        RingProtocol.Frame f = RingProtocol.parse(RingProtocol.buildPageAck(0x0d, 0x5f49, 0x01, 0x01, 0x03));
        expect("ack rides the DEVICE channel", f.chan == RingProtocol.CHAN_DEVICE);
        expect("ack kind is ACK", f.kind == RingProtocol.KIND_ACK);
        expect("ack command is 00:7e", f.cmdHi == 0x00 && f.cmdLo == 0x7e);
        expect("ack header seq differs from echoed page seq", f.seq != (f.payload[6] & 0xff));
        expect("echoed page seq is at payload[6]", (f.payload[6] & 0xff) == 0x03);
    }

    private static void testParseRejectsGarbage() {
        section("parser rejects non-frames");
        expect("null", RingProtocol.parse(null) == null);
        expect("too short", RingProtocol.parse(new byte[8]) == null);
        expect("no magic", RingProtocol.parse(new byte[20]) == null);
        // A 3-byte ring gesture frame must not look like a header.
        expect("gesture frame is not a header",
            !RingProtocol.looksLikeHeader(new byte[] {(byte) 0xff, 0x04, 0x01}));
        // A frame whose PLEN disagrees with its actual length is rejected.
        byte[] frame = RingProtocol.buildHealthRequest(RingProtocol.CMD_HI_HRV, 1, 0);
        byte[] truncated = Arrays.copyOf(frame, frame.length - 1);
        expect("length/PLEN mismatch rejected", RingProtocol.parse(truncated) == null);
    }

    /**
     * Fragmentation, reproducing the shape the capture actually shows: an
     * oversized frame split into a 244-byte FLAG=0x01 head and a headerless
     * continuation, with an unrelated complete frame arriving in between.
     */
    private static void testFragmentReassembly() {
        section("fragment reassembly");
        // Build a 252-byte steps-shaped frame: 15 header + 237 payload.
        byte[] payload = new byte[237];
        for (int i = 0; i < payload.length; i++) {
            payload[i] = (byte) (i * 7 + 3);
        }
        byte[] whole = RingProtocol.buildFrame(
            RingProtocol.CHAN_HEALTH, RingProtocol.KIND_DATA,
            RingProtocol.CMD_HI_STEPS, RingProtocol.CMD_LO_HEALTH, 0x15, payload);
        expect("test frame is 252 bytes", whole.length == 252);

        byte[] head = Arrays.copyOf(whole, 244);
        head[0] = (byte) RingProtocol.FLAG_FRAGMENTED;
        byte[] continuation = new byte[RingProtocol.CONTINUATION_PREFIX_LEN + (whole.length - 244)];
        System.arraycopy(whole, 244, continuation, RingProtocol.CONTINUATION_PREFIX_LEN, whole.length - 244);
        expect("continuation is 5 + remaining bytes", continuation.length == 13);

        byte[] interleaved = RingProtocol.buildFrame(
            RingProtocol.CHAN_DEVICE, RingProtocol.KIND_DATA, 0x00, 0x01, 0x16, new byte[9]);

        RingProtocol.Reassembler reassembler = new RingProtocol.Reassembler();

        RingProtocol.Intake first = reassembler.accept(head);
        expect("head consumed", first.consumed && first.frame == null);
        expect("fragment outstanding", reassembler.hasPending());

        RingProtocol.Intake middle = reassembler.accept(interleaved);
        expect("interleaved frame still parses while a fragment is pending",
            middle.consumed && middle.frame != null && middle.frame.crcOk);
        expect("fragment survives the interleaved frame", reassembler.hasPending());

        RingProtocol.Intake done = reassembler.accept(continuation);
        expect("continuation completes the frame", done.consumed && done.frame != null);
        expect("reassembled frame passes CRC", done.frame.crcOk);
        expect("reassembled bytes are exact",
            Arrays.equals(done.frame.raw, headJoined(head, whole)));
        expect("no fragment left outstanding", !reassembler.hasPending());
        expect("reassembled payload is intact", Arrays.equals(done.frame.payload, payload));

        // Non-protocol traffic must pass straight through untouched.
        RingProtocol.Intake gesture = reassembler.accept(new byte[] {(byte) 0xff, 0x04, 0x01});
        expect("gesture frame is not consumed", !gesture.consumed);
    }

    private static byte[] headJoined(byte[] head, byte[] whole) {
        byte[] expected = whole.clone();
        expected[0] = head[0];
        return expected;
    }

    // ------------------------------------------------------------------
    // Synthetic record bodies, built directly from the spec's field layout.
    // ------------------------------------------------------------------

    private static void testHourlyDecode() {
        section("hourly decode (heart rate W=1, HRV W=2, backlog page)");

        // Anchored heart-rate page, W=1, three groups.
        long anchor = 1788926400L; // 2026-09-09 00:00 local, the capture's anchor
        int[][] groups = {{0, 61, 88, 55}, {1, 58, 71, 52}, {2, 63, 90, 57}};
        byte[] body = hourlyBody(3, anchor, 12345L, 64, 1, groups);
        RingProtocol.Frame frame = dataFrame(RingProtocol.CMD_HI_HEART_RATE, body);
        RingProtocol.HourlyRecord hr = RingProtocol.decodeHourly(frame, 0L);
        expect("HR decodes", hr != null);
        expect("HR width resolved to 1", hr.valueWidth == 1);
        expect("HR group count", hr.groups.length == 3);
        expect("HR anchor", hr.anchorUnixSeconds == anchor);
        expect("HR not backlog", !hr.isBacklog());
        expect("HR current", hr.current == 64);
        boolean values = true;
        for (int i = 0; i < groups.length; i++) {
            RingProtocol.HourlyGroup g = hr.groups[i];
            values &= g.hourIndex == groups[i][0] && g.avg == groups[i][1]
                && g.max == groups[i][2] && g.min == groups[i][3]
                && g.unixSeconds == anchor + groups[i][0] * 3600L;
        }
        expect("HR values and hour timestamps round-trip", values);

        // HRV uses two-byte values; the width must be resolved, not assumed.
        int[][] hrvGroups = {{8, 300, 420, 210}, {9, 275, 380, 190}, {10, 512, 640, 400}};
        byte[] hrvBody = hourlyBody(3, anchor, 22222L, 333, 2, hrvGroups);
        RingProtocol.HourlyRecord hrv =
            RingProtocol.decodeHourly(dataFrame(RingProtocol.CMD_HI_HRV, hrvBody), 0L);
        expect("HRV decodes", hrv != null);
        expect("HRV width resolved to 2", hrv.valueWidth == 2);
        expect("HRV current", hrv.current == 333);
        expect("HRV holds values above 255", hrv.groups[2].max == 640);

        // Backlog page: anchor absent. The hour index must survive; the absolute
        // time must NOT be invented.
        byte[] backlogBody = hourlyBody(3, RingProtocol.UNKNOWN_TIME, 77777L, 60, 1, groups);
        RingProtocol.HourlyRecord backlog =
            RingProtocol.decodeHourly(dataFrame(RingProtocol.CMD_HI_HEART_RATE, backlogBody), 0L);
        expect("backlog decodes", backlog != null);
        expect("backlog flagged", backlog.isBacklog());
        expect("backlog anchor unknown", backlog.anchorUnixSeconds == RingProtocol.UNKNOWN_TIME);
        boolean noInventedTime = true;
        for (RingProtocol.HourlyGroup g : backlog.groups) {
            noInventedTime &= g.unixSeconds == RingProtocol.UNKNOWN_TIME;
        }
        expect("backlog groups carry no invented absolute time", noInventedTime);
        expect("backlog keeps raw hour indices",
            backlog.groups[0].hourIndex == 0 && backlog.groups[2].hourIndex == 2);
        expect("backlog still decodes values", backlog.groups[1].avg == 58);
    }

    private static void testStepsDecode() {
        section("steps decode");
        long anchor = 1788926400L;
        int[][] buckets = {{0, 120, 4, 16}, {3, 0, 0, 12}, {130, 45, 2, 14}};
        byte[] body = stepsBody(anchor, buckets);
        RingProtocol.StepsRecord steps =
            RingProtocol.decodeSteps(dataFrame(RingProtocol.CMD_HI_STEPS, body), 0L);
        expect("steps decode", steps != null);
        expect("bucket count", steps.buckets.length == 3);
        expect("total steps", steps.totalSteps() == 165);
        expect("raw index preserved, including the 130+ jump",
            steps.buckets[2].index == 130);
        expect("v2/v3 kept as unconfirmed calorie-shaped fields",
            steps.buckets[0].calorieLike2 == 4 && steps.buckets[0].calorieLike3 == 16);
        expect("steps anchor", steps.anchorUnixSeconds == anchor);
        // Length must be exact: a truncated body is a decode failure, not a guess.
        byte[] shortBody = Arrays.copyOf(body, body.length - 1);
        expect("truncated steps body rejected",
            RingProtocol.decodeSteps(dataFrame(RingProtocol.CMD_HI_STEPS, shortBody), 0L) == null);
    }

    private static void testSleepDecodeAndIdentities() {
        section("sleep decode + the spec's arithmetic identities");
        // segments: (stage, halfMinutes). Stage sums: 0->10, 1->20, 2->70, 3->25.
        int[][] segments = {{0, 4}, {1, 20}, {2, 40}, {0, 6}, {2, 30}, {3, 25}};
        int totalHalfMinutes = 125;
        int seconds = totalHalfMinutes * 30;   // 3750
        int wake = 10 * 30;                    // 300, stage 0
        int rem = 20 * 30;                     // 600, stage 1
        int light = 70 * 30;                   // 2100, stage 2
        int deep = 25 * 30;                    // 750, stage 3
        int total = seconds - wake;            // 3450
        long start = 100000L;
        long end = start + seconds;

        byte[] body = sleepBody(1, start, end, total, wake, rem, light, deep, segments);
        RingProtocol.SleepRecord sleep =
            RingProtocol.decodeSleep(dataFrame(RingProtocol.CMD_HI_SLEEP, body), 0L);
        expect("sleep decodes", sleep != null);
        expect("real record", sleep.isRealRecord());
        expect("segment count", sleep.segments.length == segments.length);
        expect("segment stages and durations round-trip",
            sleep.segments[2].stage == 2 && sleep.segments[2].halfMinutes == 40);

        expect("identity: sum(half_minutes) x 30 == total_time + wake_time",
            sleep.totalHalfMinutes() * 30 == sleep.totalTime + sleep.wakeTime);
        expect("identity: sum(half_minutes) x 30 == end_ts - start_ts",
            sleep.totalHalfMinutes() * 30 == (int) (sleep.endTs - sleep.startTs));
        expect("identity: per-stage sums match the four stage totals",
            sleep.halfMinutesForStage(0) * 30 == wake
                && sleep.halfMinutesForStage(1) * 30 == rem
                && sleep.halfMinutesForStage(2) * 30 == light
                && sleep.halfMinutesForStage(3) * 30 == deep);
        expect("identitiesHold() agrees", sleep.identitiesHold());

        expect("uncracked 6-byte field stored raw, not interpreted",
            sleep.unknownPrefix.length == 6);
        expect("relative timestamps kept as sent",
            sleep.startTs == start && sleep.endTs == end);

        // The empty end-of-list marker must decode without inventing a session.
        byte[] marker = new byte[] {0x11, 0x22, 0x02};
        RingProtocol.SleepRecord empty =
            RingProtocol.decodeSleep(dataFrame(RingProtocol.CMD_HI_SLEEP, marker), 0L);
        expect("RECSTATE=2 marker decodes", empty != null && !empty.isRealRecord());
        expect("marker has no segments", empty.segments.length == 0);

        // A declared segment count that does not fill the body is a parse failure.
        byte[] broken = body.clone();
        broken[32] = (byte) (segments.length + 1);
        expect("segment-count mismatch rejected",
            RingProtocol.decodeSleep(dataFrame(RingProtocol.CMD_HI_SLEEP, broken), 0L) == null);
    }

    // ------------------------------------------------------------------
    // Synthetic body builders (mirror the spec layout, used only by the tests)
    // ------------------------------------------------------------------

    private static byte[] hourlyBody(int count, long anchor, long tag, int current,
                                     int width, int[][] groups) {
        byte[] body = new byte[13 + width + count * (1 + 3 * width) + 4];
        body[0] = 0x11;
        body[1] = 0x22;
        body[2] = (byte) count;
        writeAnchor(body, anchor);
        putLe(body, 9, tag, 4);
        putLe(body, 13, current, width);
        int offset = 13 + width;
        for (int[] g : groups) {
            body[offset++] = (byte) g[0];
            putLe(body, offset, g[1], width);
            offset += width;
            putLe(body, offset, g[2], width);
            offset += width;
            putLe(body, offset, g[3], width);
            offset += width;
        }
        putFooter(body);
        return body;
    }

    private static byte[] stepsBody(long anchor, int[][] buckets) {
        byte[] body = new byte[9 + buckets.length * 7 + 4];
        body[0] = 0x33;
        body[1] = 0x44;
        body[2] = (byte) buckets.length;
        writeAnchor(body, anchor);
        int offset = 9;
        for (int[] b : buckets) {
            body[offset] = (byte) b[0];
            putLe(body, offset + 1, b[1], 2);
            putLe(body, offset + 3, b[2], 2);
            putLe(body, offset + 5, b[3], 2);
            offset += 7;
        }
        putFooter(body);
        return body;
    }

    private static byte[] sleepBody(int recordState, long start, long end, int total, int wake,
                                    int rem, int light, int deep, int[][] segments) {
        byte[] body = new byte[34 + segments.length * 3 + 4];
        body[0] = 0x55;
        body[1] = 0x66;
        body[2] = (byte) recordState;
        for (int i = 3; i < 9; i++) {
            body[i] = (byte) (0xA0 + i);       // the uncracked 6-byte field
        }
        putLe(body, 9, 90210L, 4);             // the uncracked u32 tag
        body[13] = 0x00;
        putLe(body, 14, start, 4);
        putLe(body, 18, end, 4);
        putLe(body, 22, total, 2);
        putLe(body, 24, wake, 2);
        putLe(body, 26, rem, 2);
        putLe(body, 28, light, 2);
        putLe(body, 30, deep, 2);
        body[32] = (byte) segments.length;
        body[33] = 0x00;
        int offset = 34;
        for (int[] s : segments) {
            body[offset] = (byte) s[0];
            putLe(body, offset + 1, s[1], 2);
            offset += 3;
        }
        putFooter(body);
        return body;
    }

    private static void writeAnchor(byte[] body, long anchor) {
        if (anchor == RingProtocol.UNKNOWN_TIME) {
            return;                             // six zero bytes = backlog page
        }
        body[3] = 0x10;
        body[4] = (byte) 0xFF;
        putLe(body, 5, anchor, 4);
    }

    private static void putFooter(byte[] body) {
        int offset = body.length - 4;
        body[offset] = (byte) 0x94;
        body[offset + 1] = 0x33;
        body[offset + 2] = 0x01;
        body[offset + 3] = 0x00;
    }

    private static void putLe(byte[] out, int offset, long value, int width) {
        for (int i = 0; i < width; i++) {
            out[offset + i] = (byte) ((value >>> (8 * i)) & 0xff);
        }
    }

    private static RingProtocol.Frame dataFrame(int cmdHi, byte[] body) {
        byte[] frame = RingProtocol.buildFrame(
            RingProtocol.CHAN_HEALTH, RingProtocol.KIND_DATA, cmdHi,
            RingProtocol.CMD_LO_HEALTH, 0x20, body);
        return RingProtocol.parse(frame);
    }

    // ------------------------------------------------------------------

    private static void section(String name) {
        System.out.println();
        System.out.println("-- " + name);
    }

    private static void expect(String what, boolean ok) {
        checks++;
        if (!ok) {
            failures++;
        }
        System.out.println("   " + (ok ? "ok  " : "FAIL") + "  " + what);
    }

    private static void expectHex(String what, String expectedHex, byte[] actual) {
        String actualHex = RingProtocol.hex(actual);
        boolean ok = expectedHex.equals(actualHex);
        checks++;
        if (!ok) {
            failures++;
            System.out.println("   FAIL  " + what);
            System.out.println("         expected " + expectedHex);
            System.out.println("         actual   " + actualHex);
            return;
        }
        System.out.println("   ok    " + what + "  " + actualHex);
    }

    private static String hex2(int value) {
        return String.format(java.util.Locale.US, "%02x", value & 0xff);
    }
}
