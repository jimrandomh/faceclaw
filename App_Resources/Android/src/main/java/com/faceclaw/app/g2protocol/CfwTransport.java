package com.faceclaw.app;

import java.util.ArrayList;
import java.util.List;

/** Faceclaw/7 private length-prefixed stream, independent of EvenHub image framing. */
public final class CfwTransport {
    public static final int SID = 0xf0;
    public static final int BOTH = 3;
    public static final int MAX_MESSAGE = 65535;
    private CfwTransport() {}

    /** One logical command per stream for now. Packets are bounded by actual ATT MTU. */
    public static List<byte[]> frame(byte[] message, int streamId, int lenses, int mtu) {
        if (message == null || message.length > MAX_MESSAGE || streamId < 0 || streamId > 255
                || lenses < 1 || lenses > BOTH || mtu < 23 || mtu > 517) {
            throw new IllegalArgumentException("invalid CFW stream parameters");
        }
        int capacity = Math.min(252, mtu - 14);
        byte[] stream = new byte[message.length + 2];
        stream[0] = (byte) message.length;
        stream[1] = (byte) (message.length >>> 8);
        System.arraycopy(message, 0, stream, 2, message.length);
        List<byte[]> packets = new ArrayList<>();
        for (int offset = 0, index = 0; offset < stream.length; offset += capacity, index++) {
            int count = Math.min(capacity, stream.length - offset);
            byte[] packet = new byte[count + 11];
            packet[0] = (byte) 0xaa;
            packet[1] = 0x21;
            packet[2] = (byte) (streamId + index);
            packet[3] = (byte) (count + 3);
            packet[4] = packet[5] = 1;
            packet[6] = (byte) SID;
            packet[8] = (byte) (lenses | (offset == 0 ? 0x80 : 0)
                    | (offset + count == stream.length ? 0x40 : 0));
            System.arraycopy(stream, offset, packet, 9, count);
            int crc = crc(packet, 8, count + 1);
            packet[packet.length - 2] = (byte) crc;
            packet[packet.length - 1] = (byte) (crc >>> 8);
            packets.add(packet);
        }
        return packets;
    }

    public static int crc(byte[] data) { return crc(data, 0, data.length); }
    private static int crc(byte[] data, int offset, int count) {
        int crc = 0xffff;
        for (int i = offset; i < offset + count; i++) {
            crc ^= (data[i] & 255) << 8;
            for (int bit = 0; bit < 8; bit++)
                crc = ((crc << 1) ^ ((crc & 0x8000) != 0 ? 0x1021 : 0)) & 65535;
        }
        return crc;
    }
    private static int u16(byte[] data, int offset) {
        return (data[offset] & 255) | ((data[offset + 1] & 255) << 8);
    }
    public static Ack parseAck(byte[] packet) {
        if (packet == null || packet.length != 19 || (packet[0] & 255) != 0xaa
                || packet[1] != 0x12 || packet[3] != 11 || packet[4] != 1 || packet[5] != 1
                || (packet[6] & 255) != SID || packet[7] != 0 || packet[8] != 1
                || (packet[12] != 1 && packet[12] != 2)
                || crc(packet, 8, 9) != u16(packet, 17)) return null;
        return new Ack(packet[9] & 255, u16(packet, 10), packet[12], u16(packet, 13), u16(packet, 15));
    }
    public static final class Ack {
        public final int streamId, messageId, lens, size, checksum;
        Ack(int streamId, int messageId, int lens, int size, int checksum) {
            this.streamId = streamId; this.messageId = messageId; this.lens = lens;
            this.size = size; this.checksum = checksum;
        }
    }
}
