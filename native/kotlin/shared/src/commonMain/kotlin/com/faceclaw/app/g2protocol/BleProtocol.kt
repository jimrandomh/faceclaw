package com.faceclaw.app

import kotlin.jvm.JvmField
import kotlin.jvm.JvmOverloads
import kotlin.jvm.JvmStatic

/**
 * BleProtocol: Functions for generating and parsing messages when speaking to the Even Realities
 * G2. Does _not_ include code for actually sending anything; for that, see FaceclawBleCommunicator.
 *
 * Most message formats are protobufs. For schemas, check g2-kit-unofficial.
 */
class BleProtocol {
    companion object {
        const val WRITE_CHAR_UUID: String = "00002760-08c2-11e1-9073-0e8ac72e5401"

        const val NOTIFY_CHAR_UUID: String = "00002760-08c2-11e1-9073-0e8ac72e5402"

        const val OTA_DATA_WRITE_UUID: String = "00002760-08c2-11e1-9073-0e8ac72e0001"

        const val OTA_DATA_NOTIFY_UUID: String = "00002760-08c2-11e1-9073-0e8ac72e0002"

        const val RENDER_NOTIFY_UUID: String = "00002760-08c2-11e1-9073-0e8ac72e6402"

        const val R1_PHONE_NOTIFY_CHAR_UUID: String = "bae80011-4f05-4503-8e65-3af1f7329d1f"

        const val R1_NOTIFY_CHAR_UUID: String = "bae80013-4f05-4503-8e65-3af1f7329d1f"

        const val PRELUDE_ACK_SID: Int = 0x01

        const val PRELUDE_ACK_MAGIC: Int = 156

        /**
         * DEVICE_SETTINGS security-auth channel. Firmware 2.2.9 enforces completing this exchange
         * shortly after a GATT connection opens (a ~30 s deadline closes unauthenticated links) and
         * gates query responses on it; the message itself exists back to the 2.2.4 era, so sending
         * it is safe on all stock versions. See ../notes/ble-connections-2.2.9.md.
         */
        const val SID_SECURITY_AUTH: Int = 0x80

        const val FLAG_SECURITY_AUTH: Int = 0x00

        private const val SECURITY_AUTH_CMD: Int = 4

        const val SID_APP_LAUNCH: Int = 0x01

        const val SID_EVENHUB: Int = 0xe0

        const val SID_UI_SETTING: Int = 0x09

        const val SID_STATE_CHANGE: Int = 0x0

        const val SID_ONBOARDING: Int = 0x10

        /** G2SettingPackage.commandId for device-initiated pushes (vs. 2 = app read). */
        const val SETTINGS_CMD_DEVICE_SEND_TO_APP: Int = 3

        const val FACECLAW_WAKE_CONTROL_FIELD: Int = 101

        const val FACECLAW_WAKE_EVENT_FIELD: Int = 102

        /**
         * CFW mic_control: host writes an [77.toByte(),67.toByte(),ver,op,...] record as settings
         * field 103; each temple reports a 21-byte [77.toByte(),67.toByte(),ver,...] status as
         * field 104, both appended to settings read responses and as standalone commandId=3 pushes.
         */
        const val FACECLAW_MIC_CONTROL_FIELD: Int = 103

        const val FACECLAW_MIC_STATUS_FIELD: Int = 104

        /**
         * CFW als_sensor: ambient-light reports on settings-channel field 105, 24-byte
         * [65.toByte(),76.toByte(),ver,reason,...] records from the master temple (decoded in
         * app/native/ambient-light.ts).
         */
        const val FACECLAW_ALS_REPORT_FIELD: Int = 105

        const val FACECLAW_WAKE_OP_ACQUIRE: Int = 1

        const val FACECLAW_WAKE_OP_RELEASE: Int = 2

        const val FACECLAW_WAKE_OP_CLAIM: Int = 3

        const val FACECLAW_WAKE_OP_READY: Int = 4

        const val FACECLAW_FB_OP_ACQUIRE: Int = 5

        const val FACECLAW_FB_OP_RELEASE: Int = 6

        const val FACECLAW_WEAR_OP_QUERY: Int = 7

        const val CFW_IMAGE_MODE_CLEANUP: Int = 11

        private const val FACECLAW_WAKE_EVENT: Int = 1

        const val FACECLAW_WAKE_EVENT_HEAD_UP: Int = 5

        const val FACECLAW_GESTURE_EVENT_TAP: Int = 2

        const val FACECLAW_GESTURE_EVENT_LONG_PRESS: Int = 3

        const val FACECLAW_GESTURE_EVENT_LONG_PRESS_RELEASE: Int = 4

        private const val FACECLAW_RAW_SOURCE_LEFT_TEMPLE: Int = 0

        private const val FACECLAW_RAW_SOURCE_RIGHT_TEMPLE: Int = 1

        private const val FACECLAW_RAW_SOURCE_RING: Int = 4

        private const val FACECLAW_WAKE_PROTOCOL_VERSION: Int = 1

        const val SID_EVEN_AI: Int = 0x07

        const val SID_NAVIGATION: Int = 0x08

        const val NAV_CMD_COMPASS_CHANGED: Int = 15

        const val NAV_CMD_COMPASS_CALIBRATION_STARTED: Int = 16

        const val NAV_CMD_COMPASS_CALIBRATION_COMPLETE: Int = 17

        const val EVEN_AI_CMD_CTRL: Int = 1

        const val EVEN_AI_STATUS_WAKE_UP: Int = 1

        const val EVEN_AI_STATUS_ENTER: Int = 2

        const val EVEN_AI_STATUS_EXIT: Int = 3

        const val FLAG_REQUEST: Int = 0x20

        const val FLAG_NOTIFY: Int = 0x01

        const val FLAG_NOTIFY_ALT: Int = 0x06

        const val CMD_AUDIO_CONTROL: Int = 15

        const val CMD_OPEN_IMU: Int = 19

        const val EVENT_CLICK: Int = 0

        const val EVENT_SCROLL_TOP: Int = 1

        const val EVENT_SCROLL_BOTTOM: Int = 2

        const val EVENT_DOUBLE_CLICK: Int = 3

        const val EVENT_FOREGROUND_ENTER: Int = 4

        const val EVENT_FOREGROUND_EXIT: Int = 5

        const val EVENT_ABNORMAL_EXIT: Int = 6

        const val EVENT_SYSTEM_EXIT: Int = 7

        const val EVENT_IMU_DATA_REPORT: Int = 8

        const val EVENT_RING_LONG_PRESS: Int = 9

        const val EVENT_RING_LONG_PRESS_RELEASE: Int = 10

        const val EVENT_SHORT_THEN_LONG_PRESS: Int = 11

        const val EVENT_HEAD_UP: Int = 12

        const val EVENT_SOURCE_GLASSES_R: Int = 1

        const val EVENT_SOURCE_RING: Int = 2

        const val EVENT_SOURCE_GLASSES_L: Int = 3

        const val CCCD_UUID: String = "00002902-0000-1000-8000-00805f9b34fb"

        @JvmField val PRELUDE_F5872_PAYLOAD: ByteArray = buildPreludeF5872Payload()

        @JvmField
        val PRELUDE_F5872: ByteArray =
            framePb(PRELUDE_F5872_PAYLOAD, SID_APP_LAUNCH, FLAG_REQUEST, 0x92).first()

        private fun buildPreludeF5872Payload(): ByteArray {
            var field4: ByteArray =
                encodeMessageField(
                    3,
                    encodeMessageField(
                        2,
                        encodeMessageField(
                            2,
                            concat(
                                CollectionUtils.listOf(
                                    encodeVarintField(1, 0),
                                    encodeVarintField(2, 0),
                                )
                            ),
                        ),
                    ),
                )
            return concat(
                CollectionUtils.listOf(
                    encodeVarintField(1, 2),
                    encodeVarintField(2, PRELUDE_ACK_MAGIC),
                    encodeMessageField(4, field4),
                )
            )
        }

        @JvmStatic
        @JvmOverloads
        fun framePb(
            pb: ByteArray,
            sid: Int,
            flag: Int,
            seq: Int,
            maxWrite: Int = 240,
        ): MutableList<ByteArray> {
            val chunkSize = minOf(232, maxWrite - 8)
            require(chunkSize >= 12) { "Negotiated BLE write size is too small" }
            var crc: ByteArray = crcBytesLe(pb)
            var totalWithCrc: Int = (pb.size + 2)
            var totalFrags: Int =
                maxOf(1, (kotlin.math.ceil((totalWithCrc / (chunkSize).toDouble()))).toInt())
            require(totalFrags <= 255) { "Protocol message exceeds the fragment limit" }
            var frames: MutableList<ByteArray> = ArrayList(totalFrags)
            var payload: ByteArray = pb.copyOf(totalWithCrc)
            payload[pb.size] = crc[0]
            payload[(pb.size + 1)] = crc[1]
            run {
                var i: Int = 0
                while ((i < totalFrags)) {
                    var offset: Int = (i * chunkSize)
                    var chunk: ByteArray =
                        payload.copyOfRange(offset, minOf((offset + chunkSize), payload.size))
                    var frame: ByteArray = ByteArray((8 + chunk.size))
                    frame[0] = (0xaa).toByte()
                    frame[1] = 0x21
                    frame[2] = ((seq and 0xff)).toByte()
                    frame[3] = ((chunk.size and 0xff)).toByte()
                    frame[4] = ((totalFrags and 0xff)).toByte()
                    frame[5] = (((i + 1) and 0xff)).toByte()
                    frame[6] = ((sid and 0xff)).toByte()
                    frame[7] = ((flag and 0xff)).toByte()
                    chunk.copyInto(frame, 8, 0, 0 + chunk.size)
                    frames.add(frame)
                    i++
                }
            }
            return frames
        }

        /** Retain the text container for forwarded inputs, without an image container. */
        @JvmStatic
        fun buildCreateInputPage(magic: Int): ByteArray {
            var innerParts: MutableList<ByteArray> = ArrayList()
            innerParts.add(encodeVarintField(1, 1))
            innerParts.add(
                encodeMessageField(3, encodeTextObject("dashboard", 1, 0, 0, 576, 288, " ", true))
            )
            innerParts.add(encodeVarintField(5, 10000))
            var inner: ByteArray = concat(innerParts)
            return wrapEvenHub(0, magic, 3, inner)
        }

        @JvmStatic
        fun buildDashboardTextUpgrade(magic: Int): ByteArray {
            var inner: MutableList<ByteArray> = ArrayList()
            inner.add(encodeVarintField(1, 1))
            inner.add(encodeStringField(2, "dashboard"))
            inner.add(encodeVarintField(3, 0))
            inner.add(encodeVarintField(4, 1))
            inner.add(encodeStringField(5, " "))
            return wrapEvenHub(5, magic, 9, concat(inner))
        }

        @JvmStatic
        fun buildImageRawData(
            tile: ImageTileOptions,
            sessionId: Int,
            totalSize: Int,
            fragment: ImageFragment,
            magic: Int,
        ): ByteArray {
            var inner: MutableList<ByteArray> = ArrayList()
            inner.add(encodeVarintField(1, tile.containerId))
            inner.add(encodeStringField(2, tile.name))
            inner.add(encodeVarintField(3, tile.containerId))
            inner.add(encodeVarintField(4, totalSize))
            inner.add(encodeVarintField(5, 0))
            inner.add(encodeVarintField(6, fragment.index))
            inner.add(encodeVarintField(7, fragment.size))
            inner.add(encodeBytesField(8, fragment.data))
            return wrapEvenHub(3, magic, 5, concat(inner))
        }

        @JvmStatic
        fun buildHeartbeat(magic: Int): ByteArray {
            return wrapEvenHub(12, magic, 14, encodeVarintField(1, 0))
        }

        /**
         * Cmd=0 CreateStartUpPage carrying a text container (the message) plus a list container
         * (the selectable rows) in one page. Uses stock-firmware-safe geometry (each container
         * within the stock ~280x130 container-size cap; the CFW is what lifts that to 576x288), so
         * this works before flashing. The selected row comes back as an async list event — see
         * parseListSelection.
         */
        @JvmStatic
        fun buildCreatePromptPage(
            magic: Int,
            textName: String,
            textContainerId: Int,
            warningText: String,
            listName: String,
            listContainerId: Int,
            items: Array<String>,
        ): ByteArray {
            var inner: MutableList<ByteArray> = ArrayList()
            inner.add(encodeVarintField(1, 2))
            inner.add(
                encodeMessageField(
                    2,
                    encodeListObject(listName, listContainerId, 0, 150, 280, 120, items, true),
                )
            )
            inner.add(
                encodeMessageField(
                    3,
                    encodeTextObject(textName, textContainerId, 0, 0, 280, 130, warningText, false),
                )
            )
            inner.add(encodeVarintField(5, 10000))
            return wrapEvenHub(0, magic, 3, concat(inner))
        }

        @JvmStatic
        fun encodeListObject(
            name: String,
            containerId: Int,
            x: Int,
            y: Int,
            width: Int,
            height: Int,
            items: Array<String>,
            captureEvents: Boolean,
        ): ByteArray {
            var parts: MutableList<ByteArray> = ArrayList()
            parts.add(encodeVarintField(1, x))
            parts.add(encodeVarintField(2, y))
            parts.add(encodeVarintField(3, width))
            parts.add(encodeVarintField(4, height))
            parts.add(encodeVarintField(9, containerId))
            parts.add(encodeStringField(10, name))
            parts.add(encodeMessageField(11, encodeListItemContainer(items)))
            if (captureEvents) {
                parts.add(encodeVarintField(12, 1))
            }
            return concat(parts)
        }

        private fun encodeListItemContainer(items: Array<String>): ByteArray {
            var parts: MutableList<ByteArray> = ArrayList()
            parts.add(encodeVarintField(1, items.size))
            parts.add(encodeVarintField(3, 1))
            for (item in items) {
                parts.add(encodeStringField(4, item))
            }
            return concat(parts)
        }

        /**
         * Decode a list-selection async event (sid=0xe0, flag=0x01/0x06). Returns null if the frame
         * is not a list event. `itemIndex` is 0-based into the ItemName array the list was built
         * with; `eventType` is EVENT_CLICK for a confirmed selection (scroll/highlight changes
         * arrive with other types).
         */
        @JvmStatic
        fun parseListSelection(frame: ParsedFrame): ListSelection? {
            var pb: ByteArray = stripTrailingCrc(frame.pb)
            var deviceEvent: ByteArray? = readFieldBytes(pb, 13)
            if ((deviceEvent == null)) {
                return null
            }
            var listEvent: ByteArray? = readFieldBytes(deviceEvent, 1)
            if ((listEvent == null)) {
                return null
            }
            return ListSelection(
                readStringFieldValue(listEvent, 2),
                readStringFieldValue(listEvent, 3),
                readVarintFieldValue(listEvent, 4, -1),
                readVarintFieldValue(listEvent, 5, EVENT_CLICK),
            )
        }

        @JvmStatic
        fun buildAudioControl(magic: Int, enable: Boolean): ByteArray {
            return wrapEvenHub(
                CMD_AUDIO_CONTROL,
                magic,
                18,
                encodeVarintField(1, (if (enable) 1 else 0)),
            )
        }

        @JvmStatic
        fun buildShutdown(magic: Int, exitMode: Int): ByteArray {
            return wrapEvenHub(9, magic, 11, encodeVarintField(1, exitMode))
        }

        /**
         * IMU control (ImuCtrl = field 22 of the main ctx). IMU_CtrlCmd carries IMUReportEn
         * (field 1) and reportFrq (field 2). reportFrq is only meaningful when enabling; on disable
         * we send just the enable flag.
         */
        @JvmStatic
        fun buildImuControl(magic: Int, enable: Boolean, reportFrq: Int): ByteArray {
            var inner: MutableList<ByteArray> = ArrayList()
            inner.add(encodeVarintField(1, (if (enable) 1 else 0)))
            if ((enable && (reportFrq > 0))) {
                inner.add(encodeVarintField(2, reportFrq))
            }
            return wrapEvenHub(CMD_OPEN_IMU, magic, 22, concat(inner))
        }

        /**
         * Set the lens brightness: G2SettingPackage{commandId=1 (DeviceReceiveInfo),
         * deviceReceiveInfoFromApp(3){deviceReceiveBrightness(1){autoAdjust(1),
         * brightnessLevel(2)}}} on sid 0x09. brightnessLevel is 0-100 (nonlinear; 0 is
         * dim-but-visible, not off). When autoAdjust is set the ambient-light sensor drives
         * brightness, so the level field is omitted; otherwise the level is always encoded
         * (explicit zero included) so brightnessLevel=0 reaches the wire.
         */
        @JvmStatic
        fun buildSetBrightness(magic: Int, autoAdjust: Boolean, brightnessLevel: Int): ByteArray {
            var brightness: MutableList<ByteArray> = ArrayList()
            brightness.add(encodeVarintField(1, (if (autoAdjust) 1 else 0)))
            if (!autoAdjust) {
                brightness.add(encodeVarintField(2, brightnessLevel))
            }
            return concat(
                CollectionUtils.listOf(
                    encodeVarintField(1, 1),
                    encodeVarintField(2, magic),
                    encodeMessageField(3, encodeMessageField(1, concat(brightness))),
                )
            )
        }

        /** Enable the firmware's wear detector (DeviceReceiveInfoFromAPP field 5). */
        @JvmStatic
        fun buildSetWearDetection(magic: Int, enabled: Boolean): ByteArray {
            var wear: ByteArray = encodeVarintField(1, (if (enabled) 1 else 0))
            return concat(
                CollectionUtils.listOf(
                    encodeVarintField(1, 1),
                    encodeVarintField(2, magic),
                    encodeMessageField(3, encodeMessageField(5, wear)),
                )
            )
        }

        /**
         * The application authentication request: DEVICE_SETTINGS/AUTHENTICATION(4) on sid 0x80,
         * flag 0x00. Carries no key material — it arms the firmware's "security auth" flag; the
         * firmware sends the success notification once the flag is set AND the BLE link is
         * encrypted (SMP pairing/bond restoration, handled by the OS below GATT, possibly after a
         * pairing prompt). Protobuf: f1=4 (command), f2=magic, f3={f1=1, f2=4}.
         */
        @JvmStatic
        fun buildAuthenticationRequest(magic: Int): ByteArray {
            var auth: ByteArray =
                concat(
                    CollectionUtils.listOf(
                        encodeVarintField(1, 1),
                        encodeVarintField(2, SECURITY_AUTH_CMD),
                    )
                )
            return concat(
                CollectionUtils.listOf(
                    encodeVarintField(1, SECURITY_AUTH_CMD),
                    encodeVarintField(2, magic),
                    encodeMessageField(3, auth),
                )
            )
        }

        /**
         * True when `pb` (trailing CRC still attached) is the success notification for the
         * authentication request sent with `magic`: command 4, the same magic, and an EMPTY field-3
         * result message (`1a 00` — the omitted result code defaults to zero). A GATT write
         * completing is NOT success; only this notification is.
         */
        @JvmStatic
        fun isAuthenticationSuccess(pb: ByteArray?, magic: Int): Boolean {
            if ((pb == null)) {
                return false
            }
            var root: ByteArray = stripTrailingCrc(pb)
            if ((readVarintFieldValue(root, 1, -1) != SECURITY_AUTH_CMD)) {
                return false
            }
            if ((readVarintFieldValue(root, 2, -1) != magic)) {
                return false
            }
            var result: ByteArray? = readFieldBytes(root, 3)
            return ((result != null) && (result.size == 0))
        }

        @JvmStatic
        fun buildSettingsQuery(magic: Int): ByteArray {
            var request: ByteArray = encodeVarintField(1, 1)
            return concat(
                CollectionUtils.listOf(
                    encodeVarintField(1, 2),
                    encodeVarintField(2, magic),
                    encodeMessageField(4, request),
                )
            )
        }

        /**
         * Build the CFW-only wake lease control package. Magic zero deliberately makes this
         * fire-and-forget: the firmware consumes field 101 before its stock nanopb decoder discards
         * the unknown field.
         */
        @JvmStatic
        fun buildFaceclawWakeControl(operation: Int, nonce: Int): ByteArray {
            var control: ByteArray =
                byteArrayOf(
                    70.toByte(),
                    67.toByte(),
                    (FACECLAW_WAKE_PROTOCOL_VERSION).toByte(),
                    (operation).toByte(),
                    ((nonce and 0xff)).toByte(),
                    (((nonce ushr 8) and 0xff)).toByte(),
                )
            return concat(
                CollectionUtils.listOf(
                    encodeVarintField(1, 1),
                    encodeVarintField(2, 0),
                    encodeBytesField(FACECLAW_WAKE_CONTROL_FIELD, control),
                )
            )
        }

        /**
         * Wrap an already-encoded [77.toByte(),67.toByte(),ver,op,...] mic-control record as a
         * settings write carrying CFW field 103. Magic zero makes it fire-and-forget like the wake
         * lease: the firmware consumes the field before its stock nanopb decoder discards the
         * unknown tag, and the "ack" is the field-104 status notify that follows.
         */
        @JvmStatic
        fun buildFaceclawMicControl(record: ByteArray): ByteArray {
            return concat(
                CollectionUtils.listOf(
                    encodeVarintField(1, 1),
                    encodeVarintField(2, 0),
                    encodeBytesField(FACECLAW_MIC_CONTROL_FIELD, record),
                )
            )
        }

        /**
         * Extract the CFW mic status record (field 104) from a settings frame, or null when absent.
         * The 21-byte body layout is decoded on the TS side; here we only validate the
         * 77.toByte(),67.toByte(),version prelude.
         */
        @JvmStatic
        fun parseFaceclawMicStatus(pb: ByteArray?): ByteArray? {
            if ((pb == null)) {
                return null
            }
            var body: ByteArray? = readFieldBytes(stripTrailingCrc(pb), FACECLAW_MIC_STATUS_FIELD)
            if (
                ((((body == null) || (body.size < 3)) || (body[0].toInt() != 77)) ||
                    (body[1].toInt() != 67))
            ) {
                return null
            }
            return body
        }

        /**
         * Return the raw CFW ambient-light report from a sid-0x09 frame, or null when this is an
         * ordinary settings frame. Only the 65.toByte(),76.toByte(),version prelude is validated
         * here; the fields are decoded on the TS side.
         */
        @JvmStatic
        fun parseFaceclawAlsReport(pb: ByteArray?): ByteArray? {
            if ((pb == null)) {
                return null
            }
            var body: ByteArray? = readFieldBytes(stripTrailingCrc(pb), FACECLAW_ALS_REPORT_FIELD)
            if (
                (((((body == null) || (body.size < 24)) || (body[0].toInt() != 65)) ||
                    (body[1].toInt() != 76)) || ((body[2] and 0xff) != 1))
            ) {
                return null
            }
            return body
        }

        /** Field 106: RB/version 1/flags/percentage, from the CFW ring-battery cache. */
        @JvmStatic
        fun parseRingBattery(pb: ByteArray?): RingBatterySnapshot? {
            if ((pb == null)) {
                return null
            }
            var body: ByteArray? = readFieldBytes(stripTrailingCrc(pb), 106)
            if (
                (((((body == null) || (body.size != 5)) || (body[0].toInt() != 82)) ||
                    (body[1].toInt() != 66)) || (body[2].toInt() != 1))
            ) {
                return null
            }
            var flags: Int = (body[3] and 0xff)
            var level: Int = (body[4] and 0xff)
            if (((flags and 7.inv()) != 0)) {
                return null
            }
            if (((flags and 2) != 0)) {
                if ((((flags and 1) == 0) || (level > 100))) {
                    return null
                }
                return RingBatterySnapshot(level, (if (((flags and 4) != 0)) 1 else 0))
            }
            if (((level != 255) || ((flags and 4) != 0))) {
                return null
            }
            return RingBatterySnapshot(-1, -1)
        }

        /**
         * Return the uint16 wake nonce from a CFW field-102 deferred-wake notification (double tap
         * or head-up), or -1 when this is an ordinary settings frame (idle-gesture events
         * included).
         */
        @JvmStatic
        fun parseFaceclawWakeEvent(pb: ByteArray): Int {
            var event: ByteArray? = faceclawWakeEventBytes(pb)
            return (if ((event == null)) -1
            else ((event[4] and 0xff) or ((event[5] and 0xff) shl 8)))
        }

        /**
         * Which gesture a CFW deferred-wake notification reports: 1 (double tap) or
         * FACECLAW_WAKE_EVENT_HEAD_UP; -1 when the frame is not a wake event.
         */
        @JvmStatic
        fun parseFaceclawWakeEventCode(pb: ByteArray): Int {
            var event: ByteArray? = faceclawWakeEventBytes(pb)
            return (if ((event == null)) -1 else (event[3] and 0xff))
        }

        private fun faceclawWakeEventBytes(pb: ByteArray?): ByteArray? {
            if ((pb == null)) {
                return null
            }
            var event: ByteArray? = readFieldBytes(stripTrailingCrc(pb), FACECLAW_WAKE_EVENT_FIELD)
            if (
                (((((event == null) || (event.size != 6)) || (event[0].toInt() != 70)) ||
                    (event[1].toInt() != 67)) ||
                    ((event[2] and 0xff) != FACECLAW_WAKE_PROTOCOL_VERSION))
            ) {
                return null
            }
            var code: Int = (event[3] and 0xff)
            return (if (((code == FACECLAW_WAKE_EVENT) || (code == FACECLAW_WAKE_EVENT_HEAD_UP)))
                event
            else null)
        }

        /**
         * Decode a CFW field-102 idle-gesture event (tap, long press, release while no app is on
         * screen) into the EvenHub sys-event type and source the same gesture would carry from a
         * live page, or null when the frame is not one (ordinary settings frames and the double-tap
         * wake event included).
         */
        @JvmStatic
        fun parseFaceclawGestureEvent(pb: ByteArray?): FaceclawGestureEvent? {
            if ((pb == null)) {
                return null
            }
            var event: ByteArray? = readFieldBytes(stripTrailingCrc(pb), FACECLAW_WAKE_EVENT_FIELD)
            if (
                (((((event == null) || (event.size != 6)) || (event[0].toInt() != 70)) ||
                    (event[1].toInt() != 67)) ||
                    ((event[2] and 0xff) != FACECLAW_WAKE_PROTOCOL_VERSION))
            ) {
                return null
            }
            var eventType: Int
            when ((event[3] and 0xff)) {
                FACECLAW_GESTURE_EVENT_TAP -> {
                    eventType = EVENT_CLICK
                }
                FACECLAW_GESTURE_EVENT_LONG_PRESS -> {
                    eventType = EVENT_RING_LONG_PRESS
                }
                FACECLAW_GESTURE_EVENT_LONG_PRESS_RELEASE -> {
                    eventType = EVENT_RING_LONG_PRESS_RELEASE
                }
                else -> {
                    return null
                }
            }
            var eventSource: Int
            when ((event[4] and 0xff)) {
                FACECLAW_RAW_SOURCE_LEFT_TEMPLE -> {
                    eventSource = EVENT_SOURCE_GLASSES_L
                }
                FACECLAW_RAW_SOURCE_RIGHT_TEMPLE -> {
                    eventSource = EVENT_SOURCE_GLASSES_R
                }
                FACECLAW_RAW_SOURCE_RING -> {
                    eventSource = EVENT_SOURCE_RING
                }
                else -> {
                    eventSource = 0
                }
            }
            return FaceclawGestureEvent(eventType, eventSource)
        }

        /**
         * Decode OnboardingDataPackage EVENT/GLS_WEAR_STATUS. Unlike most async G2 traffic, stock
         * firmware sends this event with flag 0x00, so callers must recognize it by sid and
         * protobuf shape rather than notify flag. Returns 0/1, or -1 when the frame is not a wear
         * event.
         */
        @JvmStatic
        fun parseWearState(frame: ParsedFrame?): Int {
            if ((((frame == null) || !frame.ok) || (frame.sid != SID_ONBOARDING))) {
                return -1
            }
            var root: ByteArray = stripTrailingCrc(frame.pb)
            if ((readVarintFieldValue(root, 1, -1) != 3)) {
                return -1
            }
            var event: ByteArray? = readFieldBytes(root, 5)
            if (((event == null) || (readVarintFieldValue(event, 1, -1) != 1))) {
                return -1
            }
            var wearStatus: Int = readVarintFieldValue(event, 2, -1)
            return (if (((wearStatus == 0) || (wearStatus == 1))) wearStatus else -1)
        }

        @JvmStatic
        fun parseSettingsBattery(pb: ByteArray): BatterySnapshot? {
            var root: ByteArray = stripTrailingCrc(pb)
            var request: ByteArray? = readFieldBytes(root, 4)
            if ((request == null)) {
                return null
            }
            var battery: Int = readVarintFieldValue(request, 12, -1)
            var charging: Int = readVarintFieldValue(request, 13, -1)
            var silentMode: Int = readVarintFieldValue(request, 14, -1)
            if ((battery < 0)) {
                return null
            }
            return BatterySnapshot(battery, charging, silentMode)
        }

        /**
         * Silent mode from an unsolicited settings push. The wearer toggles silent mode by
         * long-pressing both touchpads at once; the firmware then sends
         * G2SettingPackage{commandId=3 (DeviceSendToAPP), deviceSendInfoToApp(5){
         * silentModeSwitch(2)}} on sid 0x09, with a magic it picked itself, so this arrives outside
         * the request/ack flow.
         *
         * Returns -1 when the frame is not such a push. Ordinary settings-read acks (the battery
         * poll) carry commandId=2 and deviceReceiveRequestFromApp in field 4, so they never match
         * and stay on the normal ack path.
         */
        @JvmStatic
        fun parseSilentModePush(pb: ByteArray?): Int {
            if ((pb == null)) {
                return -1
            }
            var root: ByteArray = stripTrailingCrc(pb)
            if ((readVarintFieldValue(root, 1, -1) != SETTINGS_CMD_DEVICE_SEND_TO_APP)) {
                return -1
            }
            var info: ByteArray? = readFieldBytes(root, 5)
            if ((info == null)) {
                return -1
            }
            return readVarintFieldValue(info, 2, -1)
        }

        /**
         * Firmware versions and the firmware-extension string from a settings READ ack. Versions
         * are fields 5/6 of the deviceReceiveRequestFromApp submessage (field 4); Faceclaw's custom
         * firmware additionally appends top-level field 100 with its revision ("Faceclaw/<n>";
         * older builds sent "EVENCFW/<ver> <tokens>"), which stock firmware never sends. Returns
         * null when the ack carries none of it. Compatibility is judged on the TS side
         * (app/g2/firmware-compat.ts); Java only needs to know whether the firmware is ours at all.
         */
        @JvmStatic
        fun parseSettingsFirmwareInfo(pb: ByteArray): FirmwareInfo? {
            var root: ByteArray = stripTrailingCrc(pb)
            var request: ByteArray? = readFieldBytes(root, 4)
            if ((request == null)) {
                return null
            }
            var leftVersion: String = readStringFieldValue(request, 5)
            var rightVersion: String = readStringFieldValue(request, 6)
            var extension: String = readStringFieldValue(root, 100)
            if (((leftVersion.isEmpty() && rightVersion.isEmpty()) && extension.isEmpty())) {
                return null
            }
            return FirmwareInfo(leftVersion, rightVersion, extension)
        }

        @JvmStatic
        fun wrapEvenHub(cmd: Int, magic: Int, innerFieldNumber: Int, inner: ByteArray): ByteArray {
            var parts: MutableList<ByteArray> = ArrayList()
            parts.add(encodeVarintField(1, cmd))
            parts.add(encodeVarintField(2, magic))
            parts.add(encodeMessageField(innerFieldNumber, inner))
            return concat(parts)
        }

        @JvmStatic
        fun encodeTextObject(
            name: String,
            containerId: Int,
            x: Int,
            y: Int,
            width: Int,
            height: Int,
            text: String,
            captureEvents: Boolean,
        ): ByteArray {
            var parts: MutableList<ByteArray> = ArrayList()
            parts.add(encodeVarintField(1, x))
            parts.add(encodeVarintField(2, y))
            parts.add(encodeVarintField(3, width))
            parts.add(encodeVarintField(4, height))
            parts.add(encodeVarintField(9, containerId))
            parts.add(encodeStringField(10, name))
            if (captureEvents) {
                parts.add(encodeVarintField(11, 1))
            }
            parts.add(encodeStringField(12, text))
            return concat(parts)
        }

        @JvmStatic
        fun encodeImageObject(tile: ImageTileOptions): ByteArray {
            var parts: MutableList<ByteArray> = ArrayList()
            parts.add(encodeVarintField(1, tile.x))
            parts.add(encodeVarintField(2, tile.y))
            parts.add(encodeVarintField(3, tile.width))
            parts.add(encodeVarintField(4, tile.height))
            parts.add(encodeVarintField(5, tile.containerId))
            parts.add(encodeStringField(6, tile.name))
            return concat(parts)
        }

        private fun concat(parts: MutableList<ByteArray>): ByteArray {
            var out: ByteSink = ByteSink()
            for (part in parts) {
                if (((part != null) && (part.size > 0))) {
                    out.write(part, 0, part.size)
                }
            }
            return out.toByteArray()
        }

        internal fun encodeVarintField(fieldNumber: Int, value: Int): ByteArray {
            return concat(CollectionUtils.listOf(encodeKey(fieldNumber, 0), encodeVarint(value)))
        }

        private fun encodeStringField(fieldNumber: Int, value: String?): ByteArray {
            var bytes: ByteArray =
                (if ((value == null)) ByteArray(0) else value.encodeToByteArray())
            return concat(
                CollectionUtils.listOf(encodeKey(fieldNumber, 2), encodeVarint(bytes.size), bytes)
            )
        }

        internal fun encodeBytesField(fieldNumber: Int, value: ByteArray?): ByteArray {
            var bytes: ByteArray = (if ((value == null)) ByteArray(0) else value)
            return concat(
                CollectionUtils.listOf(encodeKey(fieldNumber, 2), encodeVarint(bytes.size), bytes)
            )
        }

        private fun encodeMessageField(fieldNumber: Int, value: ByteArray?): ByteArray {
            var bytes: ByteArray = (if ((value == null)) ByteArray(0) else value)
            return concat(
                CollectionUtils.listOf(encodeKey(fieldNumber, 2), encodeVarint(bytes.size), bytes)
            )
        }

        private fun encodeKey(fieldNumber: Int, wireType: Int): ByteArray {
            return encodeVarint(((fieldNumber shl 3) or wireType))
        }

        private fun encodeVarint(value: Int): ByteArray {
            var out: ByteSink = ByteSink()
            var v: Int = (value ushr 0)
            while ((v >= 0x80)) {
                out.write(((v and 0x7f) or 0x80))
                v = (v ushr 7)
            }
            out.write(v)
            return out.toByteArray()
        }

        private fun crcBytesLe(data: ByteArray): ByteArray {
            var crc: Int = 0xffff
            for (b in data) {
                crc = (crc xor ((b and 0xff) shl 8))
                run {
                    var i: Int = 0
                    while ((i < 8)) {
                        if (((crc and 0x8000) != 0)) {
                            crc = (((crc shl 1) xor 0x1021) and 0xffff)
                        } else {
                            crc = ((crc shl 1) and 0xffff)
                        }
                        i++
                    }
                }
            }
            return byteArrayOf(((crc and 0xff)).toByte(), (((crc ushr 8) and 0xff)).toByte())
        }

        /**
         * Split one notification value into individual `aa21`/`aa12` envelope frames. A value
         * normally holds exactly one frame, but the firmware can pack several (each self-describing
         * via the length byte at offset 3), and a frame that only reads the first would silently
         * drop the rest. A value that does not start with an envelope, or a trailing partial frame
         * (truncated by the stack — observed on a Samsung tablet for values over 64 bytes), is
         * returned as-is so the caller can log it.
         */
        @JvmStatic
        fun splitFrames(value: ByteArray?): MutableList<ByteArray> {
            var out: MutableList<ByteArray> = ArrayList()
            if (((value == null) || (value.size == 0))) {
                return out
            }
            var offset: Int = 0
            while (
                ((((offset + 8) <= value.size) && (value[offset] == (0xaa).toByte())) &&
                    ((value[(offset + 1)].toInt() == 0x21) ||
                        (value[(offset + 1)].toInt() == 0x12)))
            ) {
                var len: Int = (value[(offset + 3)] and 0xff)
                var end: Int = minOf(value.size, ((offset + 8) + len))
                out.add(value.copyOfRange(offset, end))
                offset = end
            }
            if ((offset < value.size)) {
                out.add(value.copyOfRange(offset, value.size))
            }
            return out
        }

        @JvmStatic
        fun parseFrame(buf: ByteArray?): ParsedFrame {
            if (
                ((((buf == null) || (buf.size < 10)) || (buf[0] != (0xaa).toByte())) ||
                    ((buf[1].toInt() != 0x21) && (buf[1].toInt() != 0x12)))
            ) {
                return ParsedFrame(false, 0, 0, ByteArray(0), -1, -1)
            }
            var sid: Int = (buf[6] and 0xff)
            var flag: Int = (buf[7] and 0xff)
            var len: Int = (buf[3] and 0xff)
            var end: Int = minOf(buf.size, (8 + len))
            var pb: ByteArray = buf.copyOfRange(8, end)
            var msgType: Int = -1
            var msgSeq: Int = -1
            var offset: Int = 0
            run {
                var i: Int = 0
                while (((i < 8) && (offset < pb.size))) {
                    var key: VarintResult? = readVarint(pb, offset)
                    if ((key == null)) {
                        break
                    }
                    offset = key.next
                    var tag: Int = (key.value shr 3)
                    var wire: Int = (key.value and 7)
                    if ((wire == 0)) {
                        var value: VarintResult? = readVarint(pb, offset)
                        if ((value == null)) {
                            break
                        }
                        if ((tag == 1)) {
                            msgType = value.value
                        } else {
                            if ((tag == 2)) {
                                msgSeq = value.value
                            }
                        }
                        offset = value.next
                    } else {
                        if ((wire == 2)) {
                            var length: VarintResult? = readVarint(pb, offset)
                            if ((length == null)) {
                                break
                            }
                            offset = (length.next + length.value)
                        } else {
                            break
                        }
                    }
                    if (((msgType >= 0) && (msgSeq >= 0))) {
                        break
                    }
                    i++
                }
            }
            return ParsedFrame(true, sid, flag, pb, msgType, msgSeq)
        }

        @JvmStatic
        fun stripTrailingCrc(pb: ByteArray?): ByteArray {
            if (((pb == null) || (pb.size < 2))) {
                return (if ((pb == null)) ByteArray(0) else pb)
            }
            return pb.copyOf((pb.size - 2))
        }

        /** Decode the stock firmware's compass navigation notifications (sid 0x08). */
        @JvmStatic
        fun parseCompassEvent(frame: ParsedFrame?): CompassEvent? {
            if (frame == null || !frame.ok) return null
            return parseCompassPayload(frame.sid, frame.flag, stripTrailingCrc(frame.pb))
        }

        /** MessageReceiver has already validated and removed the CRC. */
        @JvmStatic
        fun parseCompassPayload(sid: Int, flag: Int, root: ByteArray): CompassEvent? {
            if (sid != SID_NAVIGATION || (flag != FLAG_NOTIFY && flag != FLAG_NOTIFY_ALT)) return null
            var command: Int = readVarintFieldValue(root, 1, -1)
            if ((command == NAV_CMD_COMPASS_CHANGED)) {
                var compass: ByteArray? = readFieldBytes(root, 10)
                if ((compass == null)) {
                    return null
                }
                var heading: Int = readVarintFieldValue(compass, 1, -1)
                if (((heading < 0) || (heading >= 360))) {
                    return null
                }
                var diagnostic: ByteArray? = readFieldBytes(root, 100)
                if (
                    (((((((((diagnostic != null) && (diagnostic.size == 12)) &&
                        (diagnostic[0].toInt() == 67)) && (diagnostic[1].toInt() == 77)) &&
                        (diagnostic[2].toInt() == 1)) && (diagnostic[7].toInt() == 0)) &&
                        (((diagnostic[3] and 0xff) <= 3) || (diagnostic[3] == (255).toByte()))) &&
                        (((diagnostic[4] and 0xff) <= 2) || (diagnostic[4] == (255).toByte()))) &&
                        ((diagnostic[5] and 0xff) <= 3))
                ) {
                    var sampleTimeMs: Long = 0
                    run {
                        var i: Int = 0
                        while ((i < 4)) {
                            sampleTimeMs =
                                (sampleTimeMs or
                                    (((diagnostic[(8 + i)] and 0xff)).toLong() shl (8 * i)))
                            i++
                        }
                    }
                    return CompassEvent(
                        command,
                        heading,
                        (if ((diagnostic[3] == (255).toByte())) -1 else (diagnostic[3] and 0xff)),
                        (if ((diagnostic[4] == (255).toByte())) -1 else (diagnostic[4] and 0xff)),
                        (diagnostic[5] and 0xff),
                        (diagnostic[6] and 0xff),
                        sampleTimeMs,
                    )
                }
                return CompassEvent(command, heading)
            }
            if (
                ((command == NAV_CMD_COMPASS_CALIBRATION_STARTED) ||
                    (command == NAV_CMD_COMPASS_CALIBRATION_COMPLETE))
            ) {
                return CompassEvent(command, -1)
            }
            return null
        }

        /**
         * Display wake notification observed after a ring or right-arm double tap while no EvenHub
         * page is running:
         *
         * sid=0x0d, flag=notify, payload f1=1, f3={f1=1}
         *
         * Other state-change shapes (wear, charging, head-up, etc.) are deliberately excluded. The
         * caller additionally gates this on an intentional EvenHub suspension, so normal state
         * traffic cannot become application input.
         */
        @JvmStatic
        fun isDisplayWakeStateChange(frame: ParsedFrame?): Boolean {
            if (
                ((((frame == null) || !frame.ok) || (frame.sid != SID_STATE_CHANGE)) ||
                    ((frame.flag != FLAG_NOTIFY) && (frame.flag != FLAG_NOTIFY_ALT)))
            ) {
                return false
            }
            var root: ByteArray = stripTrailingCrc(frame.pb)
            if ((readVarintFieldValue(root, 1, -1) != 1)) {
                return false
            }
            var state: ByteArray? = readFieldBytes(root, 3)
            return (((state != null) && (state.size == 2)) &&
                (readVarintFieldValue(state, 1, -1) == 1))
        }

        @JvmStatic
        fun readFieldBytes(pb: ByteArray, fieldNumber: Int): ByteArray? {
            var offset: Int = 0
            while ((offset < pb.size)) {
                var key: VarintResult? = readVarint(pb, offset)
                if ((key == null)) {
                    return null
                }
                offset = key.next
                var field: Int = (key.value shr 3)
                var wire: Int = (key.value and 0x07)
                if ((wire == 0)) {
                    var value: VarintResult? = readVarint(pb, offset)
                    if ((value == null)) {
                        return null
                    }
                    offset = value.next
                    continue
                }
                if ((wire == 1)) {
                    offset += 8
                    continue
                }
                if ((wire == 5)) {
                    offset += 4
                    continue
                }
                if ((wire != 2)) {
                    return null
                }
                var length: VarintResult? = readVarint(pb, offset)
                if ((length == null)) {
                    return null
                }
                offset = length.next
                var end: Int = (offset + length.value)
                if ((end > pb.size)) {
                    return null
                }
                var bytes: ByteArray = pb.copyOfRange(offset, end)
                offset = end
                if ((field == fieldNumber)) {
                    return bytes
                }
            }
            return null
        }

        @JvmStatic
        fun readVarintFieldValue(pb: ByteArray, fieldNumber: Int, defaultValue: Int): Int {
            var offset: Int = 0
            while ((offset < pb.size)) {
                var key: VarintResult? = readVarint(pb, offset)
                if ((key == null)) {
                    return defaultValue
                }
                offset = key.next
                var field: Int = (key.value shr 3)
                var wire: Int = (key.value and 0x07)
                if ((wire == 0)) {
                    var value: VarintResult? = readVarint(pb, offset)
                    if ((value == null)) {
                        return defaultValue
                    }
                    offset = value.next
                    if ((field == fieldNumber)) {
                        return value.value
                    }
                    continue
                }
                if ((wire == 1)) {
                    offset += 8
                    continue
                }
                if ((wire == 5)) {
                    offset += 4
                    continue
                }
                if ((wire != 2)) {
                    return defaultValue
                }
                var length: VarintResult? = readVarint(pb, offset)
                if ((length == null)) {
                    return defaultValue
                }
                offset = (length.next + length.value)
            }
            return defaultValue
        }

        /**
         * Read a `float` (protobuf wire type 5, little-endian fixed32) field. The g2-kit proto
         * declares IMU_Report_Data's x/y/z as `double`, but the firmware actually sends them as
         * fixed32 floats (confirmed from captures). Returns defaultValue if absent.
         */
        @JvmStatic
        fun readFloatFieldValue(pb: ByteArray, fieldNumber: Int, defaultValue: Float): Float {
            var offset: Int = 0
            while ((offset < pb.size)) {
                var key: VarintResult? = readVarint(pb, offset)
                if ((key == null)) {
                    return defaultValue
                }
                offset = key.next
                var field: Int = (key.value shr 3)
                var wire: Int = (key.value and 0x07)
                if ((wire == 0)) {
                    var value: VarintResult? = readVarint(pb, offset)
                    if ((value == null)) {
                        return defaultValue
                    }
                    offset = value.next
                } else {
                    if ((wire == 1)) {
                        offset += 8
                    } else {
                        if ((wire == 5)) {
                            if (((offset + 4) > pb.size)) {
                                return defaultValue
                            }
                            if ((field == fieldNumber)) {
                                var bits: Int = 0
                                run {
                                    var i: Int = 0
                                    while ((i < 4)) {
                                        bits = (bits or ((pb[(offset + i)] and 0xff) shl (8 * i)))
                                        i++
                                    }
                                }
                                return Float.fromBits(bits)
                            }
                            offset += 4
                        } else {
                            if ((wire == 2)) {
                                var length: VarintResult? = readVarint(pb, offset)
                                if ((length == null)) {
                                    return defaultValue
                                }
                                offset = (length.next + length.value)
                            } else {
                                return defaultValue
                            }
                        }
                    }
                }
            }
            return defaultValue
        }

        @JvmStatic
        fun readStringFieldValue(pb: ByteArray, fieldNumber: Int): String {
            var bytes: ByteArray? = readFieldBytes(pb, fieldNumber)
            if ((bytes == null)) {
                return ""
            }
            return bytes.decodeToString()
        }

        @JvmStatic
        fun readVarint(pb: ByteArray, offset: Int): VarintResult? {
            var value: Int = 0
            var shift: Int = 0
            var cursor: Int = offset
            while ((cursor < pb.size)) {
                var b: Int = (pb[cursor++] and 0xff)
                value = (value or ((b and 0x7f) shl shift))
                if (((b and 0x80) == 0)) {
                    return VarintResult(value, cursor)
                }
                shift += 7
            }
            return null
        }
    }

    class RingBatterySnapshot {
        @JvmField val battery: Int

        @JvmField val charging: Int

        constructor(battery: Int, charging: Int) {
            this.battery = battery
            this.charging = charging
        }
    }

    /** An idle gesture from a CFW field-102 notification, in EvenHub sys-event terms. */
    class FaceclawGestureEvent {
        @JvmField val eventType: Int

        @JvmField val eventSource: Int

        constructor(eventType: Int, eventSource: Int) {
            this.eventType = eventType
            this.eventSource = eventSource
        }
    }

    class ParsedFrame {
        @JvmField val ok: Boolean

        @JvmField val sid: Int

        @JvmField val flag: Int

        @JvmField val pb: ByteArray

        @JvmField val msgType: Int

        @JvmField val msgSeq: Int

        constructor(ok: Boolean, sid: Int, flag: Int, pb: ByteArray, msgType: Int, msgSeq: Int) {
            this.ok = ok
            this.sid = sid
            this.flag = flag
            this.pb = pb
            this.msgType = msgType
            this.msgSeq = msgSeq
        }
    }

    class VarintResult {
        @JvmField val value: Int

        @JvmField val next: Int

        constructor(value: Int, next: Int) {
            this.value = value
            this.next = next
        }
    }

    class ListSelection {
        @JvmField val containerName: String?

        @JvmField val itemName: String?

        @JvmField val itemIndex: Int

        @JvmField val eventType: Int

        constructor(containerName: String?, itemName: String?, itemIndex: Int, eventType: Int) {
            this.containerName = (if ((containerName == null)) "" else containerName)
            this.itemName = (if ((itemName == null)) "" else itemName)
            this.itemIndex = itemIndex
            this.eventType = eventType
        }
    }

    class CompassEvent {
        @JvmField val command: Int

        @JvmField val headingDegrees: Int

        /** -1 means unavailable; source: 0 unknown, 1 GRV, 2 GMRV, 3 RV. */
        @JvmField val magneticAccuracy: Int
        @JvmField val magneticAnomalies: Int
        @JvmField val orientationSource: Int
        @JvmField val diagnosticFlags: Int

        @JvmField val sampleTimeMs: Long

        constructor(
            command: Int,
            headingDegrees: Int,
        ) : this(command, headingDegrees, -1, -1, -1, -1, -1) {}

        constructor(
            command: Int,
            headingDegrees: Int,
            magneticAccuracy: Int,
            magneticAnomalies: Int,
            orientationSource: Int,
            diagnosticFlags: Int,
            sampleTimeMs: Long,
        ) {
            this.command = command
            this.headingDegrees = headingDegrees
            this.magneticAccuracy = magneticAccuracy
            this.magneticAnomalies = magneticAnomalies
            this.orientationSource = orientationSource
            this.diagnosticFlags = diagnosticFlags
            this.sampleTimeMs = sampleTimeMs
        }
    }

    class ImageTileOptions {
        @JvmField val name: String

        @JvmField val containerId: Int

        @JvmField val x: Int

        @JvmField val y: Int

        @JvmField val width: Int

        @JvmField val height: Int

        constructor(name: String, containerId: Int, x: Int, y: Int, width: Int, height: Int) {
            this.name = name
            this.containerId = containerId
            this.x = x
            this.y = y
            this.width = width
            this.height = height
        }
    }

    class ImageFragment {
        @JvmField val index: Int

        @JvmField val data: ByteArray

        @JvmField val size: Int

        constructor(index: Int, data: ByteArray, size: Int) {
            this.index = index
            this.data = data
            this.size = size
        }
    }

    class BatterySnapshot {
        @JvmField val battery: Int

        @JvmField val charging: Int

        /** 1 = silent mode on, 0 = off, -1 = the ack didn't carry the field. */
        @JvmField val silentMode: Int

        constructor(battery: Int, charging: Int, silentMode: Int) {
            this.battery = battery
            this.charging = charging
            this.silentMode = silentMode
        }
    }

    class FirmwareInfo {
        companion object {
            /** Prefix of the firmware-extension string on Faceclaw's custom firmware. */
            const val FACECLAW_EXTENSION_PREFIX: String = "Faceclaw/"
        }

        @JvmField val leftVersion: String

        @JvmField val rightVersion: String

        /** Raw field-100 string ("" on stock firmware). */
        @JvmField val extension: String

        constructor(leftVersion: String, rightVersion: String, extension: String?) {
            this.leftVersion = leftVersion
            this.rightVersion = rightVersion
            this.extension = (if ((extension == null)) "" else extension)
        }

        /**
         * True when the glasses run Faceclaw's custom firmware (any revision). Whether the revision
         * is the one this app needs is decided on the TS side, which disconnects on a mismatch;
         * this only guards the private modes against stock or third-party firmware in the meantime.
         */
        fun isFaceclawFirmware(): Boolean {
            return extension.trim().startsWith(FACECLAW_EXTENSION_PREFIX)
        }
    }
}
