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
    // Firmware-data service (svc ...e1001): the OTA transfer channel, distinct
    // from the EvenHub write/notify chars above (which the flasher reuses only
    // for the keepalive heartbeat).
    public static final String OTA_DATA_WRITE_UUID = "00002760-08c2-11e1-9073-0e8ac72e0001";
    public static final String OTA_DATA_NOTIFY_UUID = "00002760-08c2-11e1-9073-0e8ac72e0002";
    public static final String RENDER_NOTIFY_UUID = "00002760-08c2-11e1-9073-0e8ac72e6402";
    public static final String R1_PHONE_NOTIFY_CHAR_UUID = "bae80011-4f05-4503-8e65-3af1f7329d1f";
    public static final String R1_NOTIFY_CHAR_UUID = "bae80013-4f05-4503-8e65-3af1f7329d1f";

    public static final int PRELUDE_ACK_SID = 0x01;
    public static final int PRELUDE_ACK_MAGIC = 156;
    /**
     * DEVICE_SETTINGS security-auth channel. Firmware 2.2.9 enforces completing
     * this exchange shortly after a GATT connection opens (a ~30 s deadline
     * closes unauthenticated links) and gates query responses on it; the
     * message itself exists back to the 2.2.4 era, so sending it is safe on all
     * stock versions. See ../notes/ble-connections-2.2.9.md.
     */
    public static final int SID_SECURITY_AUTH = 0x80;
    public static final int FLAG_SECURITY_AUTH = 0x00;
    private static final int SECURITY_AUTH_CMD = 4;
    public static final int SID_APP_LAUNCH = 0x01;
    public static final int SID_EVENHUB = 0xe0;
    public static final int SID_UI_SETTING = 0x09;
    public static final int SID_STATE_CHANGE = 0x0d;
    public static final int SID_ONBOARDING = 0x10;
    /** G2SettingPackage.commandId for device-initiated pushes (vs. 2 = app read). */
    public static final int SETTINGS_CMD_DEVICE_SEND_TO_APP = 3;
    // Private Faceclaw/CFW wake-takeover protocol. Both payloads are unknown
    // protobuf fields to stock implementations, so they are safely ignored.
    public static final int FACECLAW_WAKE_CONTROL_FIELD = 101;
    public static final int FACECLAW_WAKE_EVENT_FIELD = 102;
    /**
     * CFW mic_control (EVENCFW/16, caps tokens micctl/micmc/micraw): host
     * writes an ['M','C',ver,op,...] record as settings field 103; each temple
     * reports a 21-byte ['M','C',ver,...] status as field 104, both appended
     * to settings read responses and as standalone commandId=3 pushes.
     */
    public static final int FACECLAW_MIC_CONTROL_FIELD = 103;
    public static final int FACECLAW_MIC_STATUS_FIELD = 104;
    public static final int FACECLAW_WAKE_OP_ACQUIRE = 1;
    public static final int FACECLAW_WAKE_OP_RELEASE = 2;
    public static final int FACECLAW_WAKE_OP_CLAIM = 3;
    public static final int FACECLAW_WAKE_OP_READY = 4;
    public static final int FACECLAW_FB_OP_ACQUIRE = 5;
    public static final int FACECLAW_FB_OP_RELEASE = 6;
    public static final int FACECLAW_WEAR_OP_QUERY = 7;
    public static final int CFW_IMAGE_MODE_CLEANUP = 11;
    private static final int FACECLAW_WAKE_EVENT = 1;
    private static final int FACECLAW_WAKE_PROTOCOL_VERSION = 1;
    // UI_FOREGROUND_EVEN_AI_ID: the stock "Even AI" assistant app. It is a
    // FOREGROUND app, whereas EvenHub (and therefore faceclaw) is the
    // BACKGROUND app -- which is why an Even AI launch draws over us.
    // Payload is g2.even_ai.EvenAIDataPackage (see
    // g2-kit-unofficial/ble/gen/even_ai_pb.ts).
    public static final int SID_EVEN_AI = 0x07;
    public static final int SID_NAVIGATION = 0x08;
    public static final int NAV_CMD_COMPASS_CHANGED = 15;
    public static final int NAV_CMD_COMPASS_CALIBRATION_STARTED = 16;
    public static final int NAV_CMD_COMPASS_CALIBRATION_COMPLETE = 17;
    // eEvenAICommandId
    public static final int EVEN_AI_CMD_CTRL = 1;
    // eEvenAIStatus, carried in EvenAIDataPackage.ctrl.status (field 3, sub 1).
    // WAKE_UP is the on-glasses "Hey Even" wakeword firing; ENTER is a manual
    // entry (touch/double-tap), so the two are distinguishable.
    public static final int EVEN_AI_STATUS_WAKE_UP = 1;
    public static final int EVEN_AI_STATUS_ENTER = 2;
    public static final int EVEN_AI_STATUS_EXIT = 3;
    public static final int FLAG_REQUEST = 0x20;
    public static final int FLAG_NOTIFY = 0x01;
    public static final int FLAG_NOTIFY_ALT = 0x06;
    public static final int CMD_AUDIO_CONTROL = 15;
    // EvenHub_Cmd_List.APP_REQUEST_OPEN_IMU_PACKET; the accelerometer stream is
    // gated behind this control message (ImuCtrl, field 22 of the main ctx).
    public static final int CMD_OPEN_IMU = 19;

    public static final int EVENT_CLICK = 0;
    public static final int EVENT_SCROLL_TOP = 1;
    public static final int EVENT_SCROLL_BOTTOM = 2;
    public static final int EVENT_DOUBLE_CLICK = 3;
    public static final int EVENT_FOREGROUND_ENTER = 4;
    public static final int EVENT_FOREGROUND_EXIT = 5;
    public static final int EVENT_ABNORMAL_EXIT = 6;
    public static final int EVENT_SYSTEM_EXIT = 7;
    public static final int EVENT_IMU_DATA_REPORT = 8;
    public static final int EVENT_RING_LONG_PRESS = 9;
    public static final int EVENT_RING_LONG_PRESS_RELEASE = 10;

    public static final int EVENT_SOURCE_GLASSES_R = 1;
    public static final int EVENT_SOURCE_RING = 2;
    public static final int EVENT_SOURCE_GLASSES_L = 3;

    public static final UUID CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    
    // App-launch message. Protobuf contents come from a capture (done in g2-kit-unofficial)
    // so the actual meaning of most fields isn't known. The standard protobuf
    // wire format still lets us identify field numbers, wire types, and lengths.
    public static final byte[] PRELUDE_F5872_PAYLOAD = buildPreludeF5872Payload();
    public static final byte[] PRELUDE_F5872 =
        framePb(PRELUDE_F5872_PAYLOAD, SID_APP_LAUNCH, FLAG_REQUEST, 0x92).getFirst();

    private static byte[] buildPreludeF5872Payload() {
        byte[] field4 = encodeMessageField(3,
            encodeMessageField(2,
                encodeMessageField(2, concat(CollectionUtils.listOf(
                    encodeVarintField(1, 0),
                    encodeVarintField(2, 0)
                )))
            )
        );
        return concat(CollectionUtils.listOf(
            encodeVarintField(1, 2), // known app-launch type/Cmd
            encodeVarintField(2, PRELUDE_ACK_MAGIC),
            encodeMessageField(4, field4)
        ));
    }

    public static List<byte[]> framePb(byte[] pb, int sid, int flag, int seq) {
        int chunkSize = 232;
        byte[] crc = crcBytesLe(pb);
        int totalWithCrc = pb.length + 2;
        int totalFrags = Math.max(1, (int) Math.ceil(totalWithCrc / (double) chunkSize));
        List<byte[]> frames = new ArrayList<>(totalFrags);
        byte[] payload = Arrays.copyOf(pb, totalWithCrc);
        payload[pb.length] = crc[0];
        payload[pb.length + 1] = crc[1];
        for (int i = 0; i < totalFrags; i++) {
            int offset = i * chunkSize;
            byte[] chunk = Arrays.copyOfRange(payload, offset, Math.min(offset + chunkSize, payload.length));
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
        inner.add(encodeStringField(2, tile.name));
        //inner.add(encodeVarintField(3, sessionId));
        inner.add(encodeVarintField(3, tile.containerId));
        inner.add(encodeVarintField(4, totalSize));
        // CompressMode stays 0: the CFW's zlib path is detected from the buffer's
        // zlib header at BMP-load time, and frag_write must copy our deflated bytes
        // VERBATIM (CompressMode!=0 would route them through the 1bpp expander).
        inner.add(encodeVarintField(5, 0)); //compression
        inner.add(encodeVarintField(6, fragment.index));
        inner.add(encodeVarintField(7, fragment.size));
        inner.add(encodeBytesField(8, fragment.data));
        return wrapEvenHub(3, magic, 5, concat(inner));
    }

    public static byte[] buildHeartbeat(int magic) {
        return wrapEvenHub(12, magic, 14, encodeVarintField(1, 0));
    }

    /**
     * Cmd=0 CreateStartUpPage carrying a text container (the message) plus a
     * list container (the selectable rows) in one page. Uses stock-firmware-safe
     * geometry (each container within the stock ~280x130 container-size cap; the
     * CFW is what lifts that to 576x288), so this works before flashing. The
     * selected row comes back as an async list event — see parseListSelection.
     */
    public static byte[] buildCreatePromptPage(
        int magic,
        String textName,
        int textContainerId,
        String warningText,
        String listName,
        int listContainerId,
        String[] items
    ) {
        List<byte[]> inner = new ArrayList<>();
        inner.add(encodeVarintField(1, 2)); // ContainerTotalNum: 1 text + 1 list
        inner.add(encodeMessageField(2, encodeListObject(listName, listContainerId, 0, 150, 280, 120, items, true)));
        inner.add(encodeMessageField(3, encodeTextObject(textName, textContainerId, 0, 0, 280, 130, warningText, false)));
        inner.add(encodeVarintField(5, 10000)); // widgetId
        return wrapEvenHub(0, magic, 3, concat(inner));
    }

    public static byte[] encodeListObject(
        String name,
        int containerId,
        int x,
        int y,
        int width,
        int height,
        String[] items,
        boolean captureEvents
    ) {
        List<byte[]> parts = new ArrayList<>();
        parts.add(encodeVarintField(1, x));
        parts.add(encodeVarintField(2, y));
        parts.add(encodeVarintField(3, width));
        parts.add(encodeVarintField(4, height));
        parts.add(encodeVarintField(9, containerId));
        parts.add(encodeStringField(10, name));
        parts.add(encodeMessageField(11, encodeListItemContainer(items)));
        if (captureEvents) {
            parts.add(encodeVarintField(12, 1));
        }
        return concat(parts);
    }

    private static byte[] encodeListItemContainer(String[] items) {
        List<byte[]> parts = new ArrayList<>();
        parts.add(encodeVarintField(1, items.length)); // ItemCount
        parts.add(encodeVarintField(3, 1));            // IsItemSelectBorderEn
        for (String item : items) {
            parts.add(encodeStringField(4, item));     // repeated ItemName
        }
        return concat(parts);
    }

    /**
     * Decode a list-selection async event (sid=0xe0, flag=0x01/0x06). Returns
     * null if the frame is not a list event. `itemIndex` is 0-based into the
     * ItemName array the list was built with; `eventType` is EVENT_CLICK for a
     * confirmed selection (scroll/highlight changes arrive with other types).
     */
    public static ListSelection parseListSelection(ParsedFrame frame) {
        byte[] pb = stripTrailingCrc(frame.pb);
        byte[] deviceEvent = readFieldBytes(pb, 13);
        if (deviceEvent == null) {
            return null;
        }
        byte[] listEvent = readFieldBytes(deviceEvent, 1);
        if (listEvent == null) {
            return null;
        }
        return new ListSelection(
            readStringFieldValue(listEvent, 2),
            readStringFieldValue(listEvent, 3),
            readVarintFieldValue(listEvent, 4, -1),
            readVarintFieldValue(listEvent, 5, EVENT_CLICK)
        );
    }

    public static byte[] buildAudioControl(int magic, boolean enable) {
        return wrapEvenHub(CMD_AUDIO_CONTROL, magic, 18, encodeVarintField(1, enable ? 1 : 0));
    }

    public static byte[] buildShutdown(int magic, int exitMode) {
        return wrapEvenHub(9, magic, 11, encodeVarintField(1, exitMode));
    }

    /**
     * IMU control (ImuCtrl = field 22 of the main ctx). IMU_CtrlCmd carries
     * IMUReportEn (field 1) and reportFrq (field 2). reportFrq is only
     * meaningful when enabling; on disable we send just the enable flag.
     */
    public static byte[] buildImuControl(int magic, boolean enable, int reportFrq) {
        List<byte[]> inner = new ArrayList<>();
        inner.add(encodeVarintField(1, enable ? 1 : 0));
        if (enable && reportFrq > 0) {
            inner.add(encodeVarintField(2, reportFrq));
        }
        return wrapEvenHub(CMD_OPEN_IMU, magic, 22, concat(inner));
    }

    /**
     * Set the lens brightness: G2SettingPackage{commandId=1 (DeviceReceiveInfo),
     * deviceReceiveInfoFromApp(3){deviceReceiveBrightness(1){autoAdjust(1),
     * brightnessLevel(2)}}} on sid 0x09. brightnessLevel is 0-100 (nonlinear;
     * 0 is dim-but-visible, not off). When autoAdjust is set the ambient-light
     * sensor drives brightness, so the level field is omitted; otherwise the
     * level is always encoded (explicit zero included) so brightnessLevel=0
     * reaches the wire.
     */
    public static byte[] buildSetBrightness(int magic, boolean autoAdjust, int brightnessLevel) {
        List<byte[]> brightness = new ArrayList<>();
        brightness.add(encodeVarintField(1, autoAdjust ? 1 : 0));
        if (!autoAdjust) {
            brightness.add(encodeVarintField(2, brightnessLevel));
        }
        return concat(CollectionUtils.listOf(
            encodeVarintField(1, 1),
            encodeVarintField(2, magic),
            encodeMessageField(3, encodeMessageField(1, concat(brightness)))
        ));
    }

    /** Enable the firmware's wear detector (DeviceReceiveInfoFromAPP field 5). */
    public static byte[] buildSetWearDetection(int magic, boolean enabled) {
        byte[] wear = encodeVarintField(1, enabled ? 1 : 0);
        return concat(CollectionUtils.listOf(
            encodeVarintField(1, 1),
            encodeVarintField(2, magic),
            encodeMessageField(3, encodeMessageField(5, wear))
        ));
    }

    /**
     * The application authentication request: DEVICE_SETTINGS/AUTHENTICATION(4)
     * on sid 0x80, flag 0x00. Carries no key material — it arms the firmware's
     * "security auth" flag; the firmware sends the success notification once
     * the flag is set AND the BLE link is encrypted (SMP pairing/bond
     * restoration, handled by the OS below GATT, possibly after a pairing
     * prompt). Protobuf: f1=4 (command), f2=magic, f3={f1=1, f2=4}.
     */
    public static byte[] buildAuthenticationRequest(int magic) {
        byte[] auth = concat(CollectionUtils.listOf(
            encodeVarintField(1, 1),
            encodeVarintField(2, SECURITY_AUTH_CMD)
        ));
        return concat(CollectionUtils.listOf(
            encodeVarintField(1, SECURITY_AUTH_CMD),
            encodeVarintField(2, magic),
            encodeMessageField(3, auth)
        ));
    }

    /**
     * True when `pb` (trailing CRC still attached) is the success notification
     * for the authentication request sent with `magic`: command 4, the same
     * magic, and an EMPTY field-3 result message (`1a 00` — the omitted result
     * code defaults to zero). A GATT write completing is NOT success; only this
     * notification is.
     */
    public static boolean isAuthenticationSuccess(byte[] pb, int magic) {
        if (pb == null) {
            return false;
        }
        byte[] root = stripTrailingCrc(pb);
        if (readVarintFieldValue(root, 1, -1) != SECURITY_AUTH_CMD) {
            return false;
        }
        if (readVarintFieldValue(root, 2, -1) != magic) {
            return false;
        }
        byte[] result = readFieldBytes(root, 3);
        return result != null && result.length == 0;
    }

    public static byte[] buildSettingsQuery(int magic) {
        byte[] request = encodeVarintField(1, 1);
        return concat(CollectionUtils.listOf(
            encodeVarintField(1, 2),
            encodeVarintField(2, magic),
            encodeMessageField(4, request)
        ));
    }

    /**
     * Build the CFW-only wake lease control package. Magic zero deliberately
     * makes this fire-and-forget: the firmware consumes field 101 before its
     * stock nanopb decoder discards the unknown field.
     */
    public static byte[] buildFaceclawWakeControl(int operation, int nonce) {
        byte[] control = new byte[] {
            'F',
            'C',
            (byte) FACECLAW_WAKE_PROTOCOL_VERSION,
            (byte) operation,
            (byte) (nonce & 0xff),
            (byte) ((nonce >>> 8) & 0xff)
        };
        return concat(CollectionUtils.listOf(
            encodeVarintField(1, 1),
            encodeVarintField(2, 0),
            encodeBytesField(FACECLAW_WAKE_CONTROL_FIELD, control)
        ));
    }

    /**
     * Wrap an already-encoded ['M','C',ver,op,...] mic-control record as a
     * settings write carrying CFW field 103. Magic zero makes it
     * fire-and-forget like the wake lease: the firmware consumes the field
     * before its stock nanopb decoder discards the unknown tag, and the
     * "ack" is the field-104 status notify that follows.
     */
    public static byte[] buildFaceclawMicControl(byte[] record) {
        return concat(CollectionUtils.listOf(
            encodeVarintField(1, 1),
            encodeVarintField(2, 0),
            encodeBytesField(FACECLAW_MIC_CONTROL_FIELD, record)
        ));
    }

    /**
     * Extract the CFW mic status record (field 104) from a settings frame, or
     * null when absent. The 21-byte body layout is decoded on the TS side;
     * here we only validate the 'M','C',version prelude.
     */
    public static byte[] parseFaceclawMicStatus(byte[] pb) {
        if (pb == null) {
            return null;
        }
        byte[] body = readFieldBytes(stripTrailingCrc(pb), FACECLAW_MIC_STATUS_FIELD);
        if (body == null
                || body.length < 3
                || body[0] != 'M'
                || body[1] != 'C') {
            return null;
        }
        return body;
    }

    /**
     * Return the uint16 wake nonce from a CFW field-102 notification, or -1
     * when this is an ordinary settings frame.
     */
    public static int parseFaceclawWakeEvent(byte[] pb) {
        if (pb == null) {
            return -1;
        }
        byte[] event = readFieldBytes(stripTrailingCrc(pb), FACECLAW_WAKE_EVENT_FIELD);
        if (event == null
                || event.length != 6
                || event[0] != 'F'
                || event[1] != 'C'
                || (event[2] & 0xff) != FACECLAW_WAKE_PROTOCOL_VERSION
                || (event[3] & 0xff) != FACECLAW_WAKE_EVENT) {
            return -1;
        }
        return (event[4] & 0xff) | ((event[5] & 0xff) << 8);
    }

    /**
     * Decode OnboardingDataPackage EVENT/GLS_WEAR_STATUS. Unlike most async
     * G2 traffic, stock firmware sends this event with flag 0x00, so callers
     * must recognize it by sid and protobuf shape rather than notify flag.
     * Returns 0/1, or -1 when the frame is not a wear event.
     */
    public static int parseWearState(ParsedFrame frame) {
        if (frame == null || !frame.ok || frame.sid != SID_ONBOARDING) {
            return -1;
        }
        byte[] root = stripTrailingCrc(frame.pb);
        if (readVarintFieldValue(root, 1, -1) != 3) {
            return -1;
        }
        byte[] event = readFieldBytes(root, 5);
        if (event == null || readVarintFieldValue(event, 1, -1) != 1) {
            return -1;
        }
        int wearStatus = readVarintFieldValue(event, 2, -1);
        return wearStatus == 0 || wearStatus == 1 ? wearStatus : -1;
    }

    public static BatterySnapshot parseSettingsBattery(byte[] pb) {
        byte[] root = stripTrailingCrc(pb);
        byte[] request = readFieldBytes(root, 4);
        if (request == null) {
            return null;
        }
        int battery = readVarintFieldValue(request, 12, -1);
        int charging = readVarintFieldValue(request, 13, -1);
        int silentMode = readVarintFieldValue(request, 14, -1);
        if (battery < 0) {
            return null;
        }
        return new BatterySnapshot(battery, charging, silentMode);
    }

    /**
     * Silent mode from an unsolicited settings push. The wearer toggles silent
     * mode by long-pressing both touchpads at once; the firmware then sends
     * G2SettingPackage{commandId=3 (DeviceSendToAPP), deviceSendInfoToApp(5){
     * silentModeSwitch(2)}} on sid 0x09, with a magic it picked itself, so this
     * arrives outside the request/ack flow.
     *
     * Returns -1 when the frame is not such a push. Ordinary settings-read acks
     * (the battery poll) carry commandId=2 and deviceReceiveRequestFromApp in
     * field 4, so they never match and stay on the normal ack path.
     */
    public static int parseSilentModePush(byte[] pb) {
        if (pb == null) {
            return -1;
        }
        byte[] root = stripTrailingCrc(pb);
        if (readVarintFieldValue(root, 1, -1) != SETTINGS_CMD_DEVICE_SEND_TO_APP) {
            return -1;
        }
        byte[] info = readFieldBytes(root, 5);
        if (info == null) {
            return -1;
        }
        return readVarintFieldValue(info, 2, -1);
    }

    /**
     * Firmware versions and the CFW capability advertisement from a settings
     * READ ack. Versions are fields 5/6 of the deviceReceiveRequestFromApp
     * submessage (field 4); the custom firmware additionally appends top-level
     * field 100, a string like "EVENCFW/6 img576 img640 ... directfb fbguard", which
     * stock firmware never sends. Returns null when the ack carries none of it.
     */
    public static FirmwareInfo parseSettingsFirmwareInfo(byte[] pb) {
        byte[] root = stripTrailingCrc(pb);
        byte[] request = readFieldBytes(root, 4);
        if (request == null) {
            return null;
        }
        String leftVersion = readStringFieldValue(request, 5);
        String rightVersion = readStringFieldValue(request, 6);
        String capabilities = readStringFieldValue(root, 100);
        if (leftVersion.isEmpty() && rightVersion.isEmpty() && capabilities.isEmpty()) {
            return null;
        }
        return new FirmwareInfo(leftVersion, rightVersion, capabilities);
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


    /**
     * Split one notification value into individual `aa21`/`aa12` envelope
     * frames. A value normally holds exactly one frame, but the firmware can
     * pack several (each self-describing via the length byte at offset 3), and
     * a frame that only reads the first would silently drop the rest. A value
     * that does not start with an envelope, or a trailing partial frame
     * (truncated by the stack — observed on a Samsung tablet for values over
     * 64 bytes), is returned as-is so the caller can log it.
     */
    public static List<byte[]> splitFrames(byte[] value) {
        List<byte[]> out = new ArrayList<>();
        if (value == null || value.length == 0) {
            return out;
        }
        int offset = 0;
        while (offset + 8 <= value.length
                && value[offset] == (byte) 0xaa
                && (value[offset + 1] == 0x21 || value[offset + 1] == 0x12)) {
            int len = value[offset + 3] & 0xff;
            int end = Math.min(value.length, offset + 8 + len);
            out.add(Arrays.copyOfRange(value, offset, end));
            offset = end;
        }
        if (offset < value.length) {
            out.add(Arrays.copyOfRange(value, offset, value.length));
        }
        return out;
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

    /** Decode the stock firmware's compass navigation notifications (sid 0x08). */
    public static CompassEvent parseCompassEvent(ParsedFrame frame) {
        if (frame == null
                || !frame.ok
                || frame.sid != SID_NAVIGATION
                || (frame.flag != FLAG_NOTIFY && frame.flag != FLAG_NOTIFY_ALT)) {
            return null;
        }
        byte[] root = stripTrailingCrc(frame.pb);
        int command = readVarintFieldValue(root, 1, -1);
        if (command == NAV_CMD_COMPASS_CHANGED) {
            byte[] compass = readFieldBytes(root, 10);
            if (compass == null) return null;
            int heading = readVarintFieldValue(compass, 1, -1);
            return heading >= 0 ? new CompassEvent(command, heading) : null;
        }
        if (command == NAV_CMD_COMPASS_CALIBRATION_STARTED
                || command == NAV_CMD_COMPASS_CALIBRATION_COMPLETE) {
            return new CompassEvent(command, -1);
        }
        return null;
    }

    /**
     * Display wake notification observed after a ring or right-arm double tap
     * while no EvenHub page is running:
     *
     *   sid=0x0d, flag=notify, payload f1=1, f3={f1=1}
     *
     * Other state-change shapes (wear, charging, head-up, etc.) are deliberately
     * excluded. The caller additionally gates this on an intentional EvenHub
     * suspension, so normal state traffic cannot become application input.
     */
    public static boolean isDisplayWakeStateChange(ParsedFrame frame) {
        if (frame == null
                || !frame.ok
                || frame.sid != SID_STATE_CHANGE
                || (frame.flag != FLAG_NOTIFY && frame.flag != FLAG_NOTIFY_ALT)) {
            return false;
        }
        byte[] root = stripTrailingCrc(frame.pb);
        if (readVarintFieldValue(root, 1, -1) != 1) {
            return false;
        }
        byte[] state = readFieldBytes(root, 3);
        return state != null
                && state.length == 2
                && readVarintFieldValue(state, 1, -1) == 1;
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

    /**
     * Read a `float` (protobuf wire type 5, little-endian fixed32) field. The
     * g2-kit proto declares IMU_Report_Data's x/y/z as `double`, but the
     * firmware actually sends them as fixed32 floats (confirmed from captures).
     * Returns defaultValue if absent.
     */
    public static float readFloatFieldValue(byte[] pb, int fieldNumber, float defaultValue) {
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
            } else if (wire == 1) {
                offset += 8;
            } else if (wire == 5) {
                if (offset + 4 > pb.length) {
                    return defaultValue;
                }
                if (field == fieldNumber) {
                    int bits = 0;
                    for (int i = 0; i < 4; i++) {
                        bits |= (pb[offset + i] & 0xff) << (8 * i);
                    }
                    return Float.intBitsToFloat(bits);
                }
                offset += 4;
            } else if (wire == 2) {
                VarintResult length = readVarint(pb, offset);
                if (length == null) {
                    return defaultValue;
                }
                offset = length.next + length.value;
            } else {
                return defaultValue;
            }
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

    public static final class ListSelection {
        public final String containerName;
        public final String itemName;
        public final int itemIndex;
        public final int eventType;

        ListSelection(String containerName, String itemName, int itemIndex, int eventType) {
            this.containerName = containerName == null ? "" : containerName;
            this.itemName = itemName == null ? "" : itemName;
            this.itemIndex = itemIndex;
            this.eventType = eventType;
        }
    }

    public static final class CompassEvent {
        public final int command;
        public final int headingDegrees;

        CompassEvent(int command, int headingDegrees) {
            this.command = command;
            this.headingDegrees = headingDegrees;
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
        /** 1 = silent mode on, 0 = off, -1 = the ack didn't carry the field. */
        final int silentMode;

        BatterySnapshot(int battery, int charging, int silentMode) {
            this.battery = battery;
            this.charging = charging;
            this.silentMode = silentMode;
        }
    }

    public static final class FirmwareInfo {
        final String leftVersion;
        final String rightVersion;
        final String capabilities;

        FirmwareInfo(String leftVersion, String rightVersion, String capabilities) {
            this.leftVersion = leftVersion;
            this.rightVersion = rightVersion;
            this.capabilities = capabilities;
        }
    }
}
