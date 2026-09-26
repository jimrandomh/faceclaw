package com.faceclaw.app;
import java.util.Arrays;

public class CompassProtocolTest {
    private static byte[] hex(String value) {
        byte[] bytes = new byte[value.length() / 2];
        for (int i = 0; i < bytes.length; i++) bytes[i] = (byte)Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
        return bytes;
    }
    private static BleProtocol.CompassEvent parse(byte[] payload) {
        return parse(payload, BleProtocol.FLAG_NOTIFY);
    }
    private static BleProtocol.CompassEvent parse(byte[] payload, int flag) {
        byte[] frame = BleProtocol.framePb(payload, 8, flag, 15).get(0);
        return BleProtocol.parseCompassEvent(BleProtocol.parseFrame(frame));
    }
    public static void main(String[] args) {
        // Golden packet also checked against the real C encoder in g2flash's host test.
        byte[] packet = hex("080f1000520308e702a2060c434d010302038c0098badcfe");
        BleProtocol.CompassEvent event = parse(packet);
        assert event.headingDegrees == 359 && event.command == 15;
        assert event.magneticAccuracy == 3 && event.magneticAnomalies == 2;
        assert event.orientationSource == 3 && event.diagnosticFlags == 0x8c;
        assert event.sampleTimeMs == 0xfedcba98L; // unsigned 32-bit timestamp through Java long
        assert parse(packet, BleProtocol.FLAG_NOTIFY_ALT).headingDegrees == 359;
        assert parse(packet, BleProtocol.FLAG_REQUEST) == null;
        assert parse(packet, 0) == null;
        byte[] legacy = Arrays.copyOf(packet, 9);
        event = parse(legacy);
        assert event.headingDegrees == 359 && event.diagnosticFlags == -1;
        for (int n = 9; n < packet.length; ++n) {
            event = parse(Arrays.copyOf(packet, n));
            assert event.headingDegrees == 359 && event.diagnosticFlags == -1;
        }
        for (int offset : new int[] {12, 13, 14, 15, 16, 17, 19}) {
            byte[] invalid = packet.clone(); invalid[offset] = 99;
            event = parse(invalid);
            assert event.headingDegrees == 359 && event.diagnosticFlags == -1;
        }
        packet[15] = packet[16] = (byte)255; packet[17] = 0; packet[18] = 0;
        event = parse(packet);
        assert event.magneticAccuracy == -1 && event.magneticAnomalies == -1;
        assert event.orientationSource == 0 && event.diagnosticFlags == 0;
        event = parse(hex("08101000"));
        assert event.command == 16 && event.headingDegrees == -1 && event.diagnosticFlags == -1;
        event = parse(hex("08111000"));
        assert event.command == 17 && event.diagnosticFlags == -1;
        assert parse(hex("080f1000520308e802")) == null; // 360 isn't a heading
        assert BleProtocol.parseCompassEvent(null) == null;
        System.out.println("Compass protocol checks passed");
    }
}
