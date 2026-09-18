package com.faceclaw.app;

import java.io.ByteArrayOutputStream;
import java.util.zip.Deflater;
import java.util.ArrayList;
import java.util.List;

/** Faceclaw/10 records: clear flags, wire length and decoded CRC; persistent zlib body. */
public final class CfwTransport {
    public static final int SID = 0xf0;
    public static final int BOTH = 3;
    public static final int MAX_MESSAGE = 65535;
    public static final int COMPRESSED = 4, RESET_CONTEXT = 8;
    private final Deflater deflater = new Deflater();
    private boolean resetPending = true;
    private int previousLenses;

    public CfwTransport() {}

    public synchronized void reset() {
        deflater.reset();
        resetPending = true;
        previousLenses = 0;
    }

    /** Compress only when writing, in exactly the order seen by the receiver. */
    public synchronized List<byte[]> encode(byte[] message, int streamId, int lenses, int mtu) {
        validate(message, streamId, lenses, mtu);
        if (previousLenses != lenses) reset();
        boolean reset = resetPending;
        deflater.setInput(message);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        int count;
        do {
            count = deflater.deflate(chunk, 0, chunk.length, Deflater.SYNC_FLUSH);
            out.write(chunk, 0, count);
        } while (count == chunk.length);
        byte[] body = out.toByteArray();
        int flags = lenses | COMPRESSED | (reset ? RESET_CONTEXT : 0);
        if (body.length == 0) flags &= ~COMPRESSED; // repeated empty sync flush
        if (body.length > MAX_MESSAGE) {
            // Incompressible maximum-size records still fit as raw records.
            // The attempted deflate advanced history: reset both ends before reuse.
            reset();
            body = message;
            flags = lenses | RESET_CONTEXT;
        } else {
            resetPending = false;
            previousLenses = lenses;
        }
        return frameRecord(body, crc(message), streamId, flags, mtu);
    }

    private static void validate(byte[] message, int streamId, int lenses, int mtu) {
        if (message == null || message.length > MAX_MESSAGE || streamId < 0 || streamId > 255
                || lenses < 1 || lenses > BOTH || mtu < 23 || mtu > 517)
            throw new IllegalArgumentException("invalid CFW stream parameters");
    }

    /** One logical command per stream for now. Packets are bounded by actual ATT MTU. */
    public static List<byte[]> frame(byte[] message, int streamId, int lenses, int mtu) {
        validate(message, streamId, lenses, mtu);
        return frameRecord(message, crc(message), streamId, lenses | RESET_CONTEXT, mtu);
    }

    private static List<byte[]> frameRecord(byte[] body, int checksum, int streamId, int flags, int mtu) {
        int lenses = flags & BOTH;
        int capacity = Math.min(252, mtu - 14);
        byte[] stream = new byte[body.length + 5];
        stream[0] = (byte) flags;
        stream[1] = (byte) body.length;
        stream[2] = (byte) (body.length >>> 8);
        stream[3] = (byte) checksum;
        stream[4] = (byte) (checksum >>> 8);
        System.arraycopy(body, 0, stream, 5, body.length);
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
        Ack[] acks = parseAcks(packet);
        return acks == null ? null : acks[0];
    }
    /** Primary ACK followed by up to three explicit preceding successes from
     * the same processing lens. Validate the entire packet before applying any. */
    public static Ack[] parseAcks(byte[] packet) {
        if (packet == null || packet.length < 19 || packet.length > 40
                || (packet.length - 19) % 7 != 0 || (packet[0] & 255) != 0xaa
                || packet[1] != 0x12 || (packet[3] & 255) != packet.length - 8 || packet[4] != 1 || packet[5] != 1
                || (packet[6] & 255) != SID || packet[7] != 0 || (packet[8] != 1 && packet[8] != 3)
                || (packet[12] != 1 && packet[12] != 2)
                || (packet[8] == 3 && packet.length != 19)
                || crc(packet, 8, packet.length - 10) != u16(packet, packet.length - 2)) return null;
        Ack[] acks = new Ack[1 + (packet.length - 19) / 7];
        acks[0] = new Ack(packet[8] == 3, packet[9] & 255, u16(packet, 10), packet[12], u16(packet, 13), u16(packet, 15));
        for (int i = 1, offset = 17; i < acks.length; i++, offset += 7)
            acks[i] = new Ack(false, packet[offset] & 255, u16(packet, offset + 1),
                    packet[12], u16(packet, offset + 3), u16(packet, offset + 5));
        return acks;
    }
    public static final class Ack {
        public final boolean nack;
        public final int streamId, messageId, lens, size, checksum;
        Ack(boolean nack, int streamId, int messageId, int lens, int size, int checksum) {
            this.nack = nack;
            this.streamId = streamId; this.messageId = messageId; this.lens = lens;
            this.size = size; this.checksum = checksum;
        }
    }
}
