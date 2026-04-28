package com.faceclaw.app;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;

/**
 * BleProtocol: Functions for generating and parsing messages when speaking to
 * the Even Realities G2. Does _not_ include code for actually sending anything;
 * for that, see FaceclawBleCommunicator.
 *
 * Most message formats are protobufs. For schemas, check g2-kit-unofficial.
 */
public class BleProtocol {
    public static final String WRITE_CHAR_UUID = "00002760-08c2-11e1-9073-0e8ac72e5401";
    public static final String NOTIFY_CHAR_UUID = "00002760-08c2-11e1-9073-0e8ac72e5402";
    public static final String RENDER_NOTIFY_UUID = "00002760-08c2-11e1-9073-0e8ac72e6402";

    public static final byte[] PRELUDE_F5872 = new byte[] {
        (byte) 0xaa, 0x21, (byte) 0x92, 0x13, 0x01, 0x01, 0x01, 0x20,
        0x08, 0x02, 0x10, (byte) 0x9c, 0x01, 0x22, 0x0a, 0x1a,
        0x08, 0x12, 0x06, 0x12, 0x04, 0x08, 0x00, 0x10, 0x00,
        (byte) 0xa1, 0x42
    };

    public static final int PRELUDE_ACK_SID = 0x01;
    public static final int PRELUDE_ACK_MAGIC = 156;
    public static final int SID_EVENHUB = 0xe0;
    public static final int SID_UI_SETTING = 0x09;
    public static final int FLAG_REQUEST = 0x20;
    public static final int FLAG_NOTIFY = 0x01;
    public static final int FLAG_NOTIFY_ALT = 0x06;

    public static final int EVENT_CLICK = 0;
    public static final int EVENT_SCROLL_TOP = 1;
    public static final int EVENT_SCROLL_BOTTOM = 2;
    public static final int EVENT_DOUBLE_CLICK = 3;
    public static final int EVENT_FOREGROUND_ENTER = 4;
    public static final int EVENT_FOREGROUND_EXIT = 5;
    public static final int EVENT_ABNORMAL_EXIT = 6;
    public static final int EVENT_SYSTEM_EXIT = 7;

    public static final UUID CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    
    public static List<byte[]> framePb(byte[] pb, int sid, int flag, int seq) {
        int chunkSize = 232;
        byte[] crc = crcBytesLe(pb);
        int totalWithCrc = pb.length + 2;
        int totalFrags = Math.max(1, (int) Math.ceil(totalWithCrc / (double) chunkSize));
        List<byte[]> frames = new ArrayList<>(totalFrags);
        int offset = 0;
        for (int i = 0; i < totalFrags; i++) {
            boolean isLast = i == totalFrags - 1;
            byte[] chunk;
            if (isLast) {
                int remaining = pb.length - offset;
                chunk = new byte[remaining + 2];
                System.arraycopy(pb, offset, chunk, 0, remaining);
                System.arraycopy(crc, 0, chunk, remaining, 2);
            } else {
                chunk = Arrays.copyOfRange(pb, offset, offset + chunkSize);
                offset += chunkSize;
            }
            if (isLast) {
                offset = pb.length;
            }
            byte[] frame = new byte[8 + chunk.length];
            frame[0] = (byte) 0xaa;
            frame[1] = 0x21;
            frame[2] = (byte) (seq & 0xff);
            frame[3] = (byte) (chunk.length & 0xff);
            frame[4] = (byte) (totalFrags & 0xff);
            frame[5] = (byte) ((i + 1) & 0xff);
            frame[6] = (byte) (sid & 0xff);
            frame[7] = (byte) (flag & 0xff);
            System.arraycopy(chunk, 0, frame, 8, chunk.length);
            frames.add(frame);
        }
        return frames;
    }


    public static byte[] buildCreateMixedImagePage(int magic, ImageTileOptions[] tiles) {
        List<byte[]> innerParts = new ArrayList<>();
        innerParts.add(encodeVarintField(1, 1 + tiles.length));
        innerParts.add(encodeMessageField(3, encodeTextObject("dashboard", 1, 0, 0, 576, 288, " ", true)));
        for (ImageTileOptions tile : tiles) {
            innerParts.add(encodeMessageField(4, encodeImageObject(tile)));
        }
        innerParts.add(encodeVarintField(5, 10000));
        byte[] inner = concat(innerParts);
        return wrapEvenHub(0, magic, 3, inner);
    }

    public static byte[] buildDashboardTextUpgrade(int magic) {
        List<byte[]> inner = new ArrayList<>();
        inner.add(encodeVarintField(1, 1));
        inner.add(encodeStringField(2, "dashboard"));
        inner.add(encodeVarintField(3, 0));
        inner.add(encodeVarintField(4, 1));
        inner.add(encodeStringField(5, " "));
        return wrapEvenHub(5, magic, 9, concat(inner));
    }

    public static byte[] buildImageRawData(ImageTileOptions tile, int sessionId, int totalSize, ImageFragment fragment, int magic) {
        List<byte[]> inner = new ArrayList<>();
        inner.add(encodeVarintField(1, tile.containerId));
        //inner.add(encodeStringField(2, tile.name));
        inner.add(encodeVarintField(3, sessionId));
        inner.add(encodeVarintField(4, totalSize));
        //inner.add(encodeVarintField(5, 0)); //compression
        inner.add(encodeVarintField(6, fragment.index));
        inner.add(encodeVarintField(7, fragment.size));
        inner.add(encodeBytesField(8, fragment.data));
        return wrapEvenHub(3, magic, 5, concat(inner));
    }

    public static byte[] buildHeartbeat(int magic) {
        return wrapEvenHub(12, magic, 14, encodeVarintField(1, 0));
    }

    public static byte[] buildShutdown(int magic, int exitMode) {
        return wrapEvenHub(9, magic, 11, encodeVarintField(1, exitMode));
    }

    public static byte[] buildSettingsQuery(int magic) {
        byte[] request = encodeVarintField(1, 1);
        return concat(CollectionUtils.listOf(
            encodeVarintField(1, 2),
            encodeVarintField(2, magic),
            encodeMessageField(4, request)
        ));
    }

    public static BatterySnapshot parseSettingsBattery(byte[] pb) {
        byte[] root = stripTrailingCrc(pb);
        byte[] request = readFieldBytes(root, 4);
        if (request == null) {
            return null;
        }
        int battery = readVarintFieldValue(request, 12, -1);
        int charging = readVarintFieldValue(request, 13, -1);
        if (battery < 0) {
            return null;
        }
        return new BatterySnapshot(battery, charging);
    }

    public static byte[] wrapEvenHub(int cmd, int magic, int innerFieldNumber, byte[] inner) {
        List<byte[]> parts = new ArrayList<>();
        parts.add(encodeVarintField(1, cmd));
        parts.add(encodeVarintField(2, magic));
        parts.add(encodeMessageField(innerFieldNumber, inner));
        return concat(parts);
    }

    public static byte[] encodeTextObject(String name, int containerId, int x, int y, int width, int height, String text, boolean captureEvents) {
        List<byte[]> parts = new ArrayList<>();
        parts.add(encodeVarintField(1, x));
        parts.add(encodeVarintField(2, y));
        parts.add(encodeVarintField(3, width));
        parts.add(encodeVarintField(4, height));
        parts.add(encodeVarintField(9, containerId));
        parts.add(encodeStringField(10, name));
        if (captureEvents) {
            parts.add(encodeVarintField(11, 1));
        }
        parts.add(encodeStringField(12, text));
        return concat(parts);
    }

    public static byte[] encodeImageObject(ImageTileOptions tile) {
        List<byte[]> parts = new ArrayList<>();
        parts.add(encodeVarintField(1, tile.x));
        parts.add(encodeVarintField(2, tile.y));
        parts.add(encodeVarintField(3, tile.width));
        parts.add(encodeVarintField(4, tile.height));
        parts.add(encodeVarintField(5, tile.containerId));
        parts.add(encodeStringField(6, tile.name));
        return concat(parts);
    }

    private static byte[] concat(List<byte[]> parts) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] part : parts) {
            if (part != null && part.length > 0) {
                out.write(part, 0, part.length);
            }
        }
        return out.toByteArray();
    }

    private static byte[] encodeVarintField(int fieldNumber, int value) {
        return concat(CollectionUtils.listOf(encodeKey(fieldNumber, 0), encodeVarint(value)));
    }

    private static byte[] encodeStringField(int fieldNumber, String value) {
        byte[] bytes = value == null ? new byte[0] : value.getBytes(StandardCharsets.UTF_8);
        return concat(CollectionUtils.listOf(encodeKey(fieldNumber, 2), encodeVarint(bytes.length), bytes));
    }

    private static byte[] encodeBytesField(int fieldNumber, byte[] value) {
        byte[] bytes = value == null ? new byte[0] : value;
        return concat(CollectionUtils.listOf(encodeKey(fieldNumber, 2), encodeVarint(bytes.length), bytes));
    }

    private static byte[] encodeMessageField(int fieldNumber, byte[] value) {
        byte[] bytes = value == null ? new byte[0] : value;
        return concat(CollectionUtils.listOf(encodeKey(fieldNumber, 2), encodeVarint(bytes.length), bytes));
    }

    private static byte[] encodeKey(int fieldNumber, int wireType) {
        return encodeVarint((fieldNumber << 3) | wireType);
    }

    private static byte[] encodeVarint(int value) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int v = value >>> 0;
        while (v >= 0x80) {
            out.write((v & 0x7f) | 0x80);
            v >>>= 7;
        }
        out.write(v);
        return out.toByteArray();
    }

    private static byte[] crcBytesLe(byte[] data) {
        int crc = 0xffff;
        for (byte b : data) {
            crc ^= (b & 0xff) << 8;
            for (int i = 0; i < 8; i++) {
                if ((crc & 0x8000) != 0) {
                    crc = ((crc << 1) ^ 0x1021) & 0xffff;
                } else {
                    crc = (crc << 1) & 0xffff;
                }
            }
        }
        return new byte[] {(byte) (crc & 0xff), (byte) ((crc >>> 8) & 0xff)};
    }


    public static ParsedFrame parseFrame(byte[] buf) {
        if (buf == null || buf.length < 10 || buf[0] != (byte) 0xaa || (buf[1] != 0x21 && buf[1] != 0x12)) {
            return new ParsedFrame(false, 0, 0, new byte[0], -1, -1);
        }
        int sid = buf[6] & 0xff;
        int flag = buf[7] & 0xff;
        int len = buf[3] & 0xff;
        int end = Math.min(buf.length, 8 + len);
        byte[] pb = Arrays.copyOfRange(buf, 8, end);

        int msgType = -1;
        int msgSeq = -1;
        int offset = 0;
        for (int i = 0; i < 8 && offset < pb.length; i++) {
            VarintResult key = readVarint(pb, offset);
            if (key == null) {
                break;
            }
            offset = key.next;
            int tag = key.value >> 3;
            int wire = key.value & 7;
            if (wire == 0) {
                VarintResult value = readVarint(pb, offset);
                if (value == null) {
                    break;
                }
                if (tag == 1) {
                    msgType = value.value;
                } else if (tag == 2) {
                    msgSeq = value.value;
                }
                offset = value.next;
            } else if (wire == 2) {
                VarintResult length = readVarint(pb, offset);
                if (length == null) {
                    break;
                }
                offset = length.next + length.value;
            } else {
                break;
            }
            if (msgType >= 0 && msgSeq >= 0) {
                break;
            }
        }
        return new ParsedFrame(true, sid, flag, pb, msgType, msgSeq);
    }

    public static byte[] stripTrailingCrc(byte[] pb) {
        if (pb == null || pb.length < 2) {
            return pb == null ? new byte[0] : pb;
        }
        return Arrays.copyOf(pb, pb.length - 2);
    }

    public static byte[] readFieldBytes(byte[] pb, int fieldNumber) {
        int offset = 0;
        while (offset < pb.length) {
            VarintResult key = readVarint(pb, offset);
            if (key == null) {
                return null;
            }
            offset = key.next;
            int field = key.value >> 3;
            int wire = key.value & 0x07;
            if (wire == 0) {
                VarintResult value = readVarint(pb, offset);
                if (value == null) {
                    return null;
                }
                offset = value.next;
                continue;
            }
            if (wire == 1) {
                offset += 8;
                continue;
            }
            if (wire == 5) {
                offset += 4;
                continue;
            }
            if (wire != 2) {
                return null;
            }
            VarintResult length = readVarint(pb, offset);
            if (length == null) {
                return null;
            }
            offset = length.next;
            int end = offset + length.value;
            if (end > pb.length) {
                return null;
            }
            byte[] bytes = Arrays.copyOfRange(pb, offset, end);
            offset = end;
            if (field == fieldNumber) {
                return bytes;
            }
        }
        return null;
    }

    public static int readVarintFieldValue(byte[] pb, int fieldNumber, int defaultValue) {
        int offset = 0;
        while (offset < pb.length) {
            VarintResult key = readVarint(pb, offset);
            if (key == null) {
                return defaultValue;
            }
            offset = key.next;
            int field = key.value >> 3;
            int wire = key.value & 0x07;
            if (wire == 0) {
                VarintResult value = readVarint(pb, offset);
                if (value == null) {
                    return defaultValue;
                }
                offset = value.next;
                if (field == fieldNumber) {
                    return value.value;
                }
                continue;
            }
            if (wire == 1) {
                offset += 8;
                continue;
            }
            if (wire == 5) {
                offset += 4;
                continue;
            }
            if (wire != 2) {
                return defaultValue;
            }
            VarintResult length = readVarint(pb, offset);
            if (length == null) {
                return defaultValue;
            }
            offset = length.next + length.value;
        }
        return defaultValue;
    }

    public static String readStringFieldValue(byte[] pb, int fieldNumber) {
        byte[] bytes = readFieldBytes(pb, fieldNumber);
        if (bytes == null) {
            return "";
        }
        return new String(bytes, StandardCharsets.UTF_8);
    }

    public static VarintResult readVarint(byte[] pb, int offset) {
        int value = 0;
        int shift = 0;
        int cursor = offset;
        while (cursor < pb.length) {
            int b = pb[cursor++] & 0xff;
            value |= (b & 0x7f) << shift;
            if ((b & 0x80) == 0) {
                return new VarintResult(value, cursor);
            }
            shift += 7;
        }
        return null;
    }


    public static final class ParsedFrame {
        final boolean ok;
        final int sid;
        final int flag;
        final byte[] pb;
        final int msgType;
        final int msgSeq;

        ParsedFrame(boolean ok, int sid, int flag, byte[] pb, int msgType, int msgSeq) {
            this.ok = ok;
            this.sid = sid;
            this.flag = flag;
            this.pb = pb;
            this.msgType = msgType;
            this.msgSeq = msgSeq;
        }
    }

    private static final class VarintResult {
        final int value;
        final int next;

        VarintResult(int value, int next) {
            this.value = value;
            this.next = next;
        }
    }

    public static final class ImageTileOptions {
        final String name;
        final int containerId;
        final int x;
        final int y;
        final int width;
        final int height;

        ImageTileOptions(String name, int containerId, int x, int y, int width, int height) {
            this.name = name;
            this.containerId = containerId;
            this.x = x;
            this.y = y;
            this.width = width;
            this.height = height;
        }
    }

    public static final class ImageFragment {
        final int index;
        final byte[] data;
        final int size;

        ImageFragment(int index, byte[] data, int size) {
            this.index = index;
            this.data = data;
            this.size = size;
        }
    }

    public static final class BatterySnapshot {
        final int battery;
        final int charging;

        BatterySnapshot(int battery, int charging) {
            this.battery = battery;
            this.charging = charging;
        }
    }
}
