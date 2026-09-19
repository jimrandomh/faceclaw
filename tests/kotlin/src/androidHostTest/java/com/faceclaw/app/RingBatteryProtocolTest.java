package com.faceclaw.app;
import java.util.Arrays;

public class RingBatteryProtocolTest {
    private static byte[] hex(String value) {
        byte[] result = new byte[value.length() / 2];
        for (int i = 0; i < result.length; ++i)
            result[i] = (byte)Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
        return result;
    }
    private static BleProtocol.RingBatterySnapshot parse(byte[] payload) {
        byte[] frame = BleProtocol.framePb(payload, 9, BleProtocol.FLAG_NOTIFY, 15).get(0);
        return BleProtocol.parseRingBattery(BleProtocol.parseFrame(frame).pb);
    }
    public static void main(String[] args) {
        // Same golden payload as g2flash/tests/ring_battery_test.c.
        byte[] packet = hex("08031000d206055242010752");
        BleProtocol.RingBatterySnapshot result = parse(packet);
        assert result.battery == 82 && result.charging == 1;
        packet[10] = 3;
        for (int level = 0; level <= 100; ++level) {
            packet[11] = (byte)level;
            result = parse(packet);
            assert result.battery == level && result.charging == 0;
        }
        for (int flags : new int[] {0, 1}) {
            packet[10] = (byte)flags; packet[11] = (byte)255;
            result = parse(packet);
            assert result.battery == -1 && result.charging == -1;
        }
        packet = hex("08031000d206055242010752");
        for (int n = 0; n < packet.length; ++n)
            assert parse(Arrays.copyOf(packet, n)) == null;
        for (int offset : new int[] {7, 8, 9, 10, 11}) {
            byte previous = packet[offset]; packet[offset] = (byte)255;
            assert parse(packet) == null;
            packet[offset] = previous;
        }
        assert parse(hex("08031000")) == null; // older firmware
        assert parse(hex("d206055242010252")) == null; // valid without connected
        assert parse(hex("d206055242010352")).battery == 82;
        assert parse(hex("d2060552420100ff")).battery == -1;
        // Invalid unknown value and charging-without-valid must be rejected.
        assert parse(hex("d206055242010052")) == null;
        assert parse(hex("d2060552420105ff")) == null;
        assert parse(hex("d206055242010364")).battery == 100;
        assert parse(hex("d206055242010365")) == null;
        assert BleProtocol.parseRingBattery(null) == null;
    }
}
