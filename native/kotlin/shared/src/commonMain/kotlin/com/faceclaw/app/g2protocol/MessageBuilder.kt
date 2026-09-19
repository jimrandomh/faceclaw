package com.faceclaw.app

class MessageBuilder {
    companion object {
        private const val ACK_TIMEOUT_MS: Int = 3_500

        private const val HEARTBEAT_TIMEOUT_MS: Int = 1_500
    }

    private var magicPool: BleMagicPool

    constructor(magicPool: BleMagicPool) {
        this.magicPool = magicPool
    }

    fun prelude(): OutboundMessage {
        return OutboundMessage(
            "prelude",
            "prelude",
            BleProtocol.PRELUDE_ACK_SID,
            BleProtocol.FLAG_REQUEST,
            BleProtocol.PRELUDE_ACK_MAGIC,
            BleProtocol.PRELUDE_F5872_PAYLOAD,
            ACK_TIMEOUT_MS,
            -1,
            false,
        )
    }

    /** The per-connection sid-0x80 security-auth request (one per arm). */
    fun securityAuth(leftArm: Boolean): OutboundMessage {
        var magic: Int = magicPool.allocate()
        return OutboundMessage(
            "security-auth",
            ("security auth " + (if (leftArm) "L" else "R")),
            BleProtocol.SID_SECURITY_AUTH,
            BleProtocol.FLAG_SECURITY_AUTH,
            magic,
            BleProtocol.buildAuthenticationRequest(magic),
            ConnectionOptions.SECURITY_AUTH_SOFT_TIMEOUT_MS,
            -1,
            leftArm,
        )
    }

    fun shutdown(exitMode: Int): OutboundMessage {
        var magic: Int = magicPool.allocate()
        return OutboundMessage(
            "shutdown",
            ("shutdown mode=" + exitMode),
            BleProtocol.SID_EVENHUB,
            BleProtocol.FLAG_REQUEST,
            magic,
            BleProtocol.buildShutdown(magic, exitMode),
            ACK_TIMEOUT_MS,
            -1,
            false,
        )
    }

    fun imagePayload(
        tile: BleProtocol.ImageTileOptions,
        sessionId: Int,
        payload: ByteArray,
        label: String,
        leftArm: Boolean,
    ): OutboundMessage {
        return imagePayload("sound", tile, sessionId, payload, label, leftArm)
    }

    fun imagePayload(
        kind: String,
        tile: BleProtocol.ImageTileOptions,
        sessionId: Int,
        payload: ByteArray,
        label: String,
        leftArm: Boolean,
    ): OutboundMessage {
        return customMessage(kind, payload, label, -1, leftArm)
    }

    fun customMessage(
        kind: String,
        payload: ByteArray?,
        label: String,
        tileIndex: Int,
        leftArm: Boolean,
    ): OutboundMessage {
        if (((payload == null) || (payload.size > CfwTransport.MAX_MESSAGE))) {
            throw IllegalArgumentException("CFW message exceeds uint16 length")
        }
        var streamId: Int = magicPool.allocate()
        return OutboundMessage(
            kind,
            label,
            CfwTransport.SID,
            0,
            streamId,
            payload,
            CfwMessageWindow.ACK_TIMEOUT_MS,
            tileIndex,
            leftArm,
        )
    }

    fun cfwCleanup(
        tile: BleProtocol.ImageTileOptions,
        sessionId: Int,
        leftArm: Boolean,
    ): OutboundMessage {
        var payload: ByteArray = byteArrayOf((BleProtocol.CFW_IMAGE_MODE_CLEANUP).toByte())
        return imagePayload("cfw-cleanup", tile, sessionId, payload, "CFW cleanup", leftArm)
    }

    fun enableOrDisableMic(enable: Boolean): OutboundMessage {
        var magic: Int = magicPool.allocate()
        return OutboundMessage(
            "audio-control",
            (if (enable) "G2 mic enable" else "G2 mic disable"),
            BleProtocol.SID_EVENHUB,
            BleProtocol.FLAG_REQUEST,
            magic,
            BleProtocol.buildAudioControl(magic, enable),
            ACK_TIMEOUT_MS,
            -1,
            false,
        )
    }

    fun enableOrDisableImu(enable: Boolean, reportFrq: Int): OutboundMessage {
        var magic: Int = magicPool.allocate()
        return OutboundMessage(
            "imu-control",
            (if (enable) "IMU enable" else "IMU disable"),
            BleProtocol.SID_EVENHUB,
            BleProtocol.FLAG_REQUEST,
            magic,
            BleProtocol.buildImuControl(magic, enable, reportFrq),
            ACK_TIMEOUT_MS,
            -1,
            false,
        )
    }

    fun setBrightness(autoAdjust: Boolean, brightnessLevel: Int): OutboundMessage {
        var magic: Int = magicPool.allocate()
        return OutboundMessage(
            "brightness-control",
            (if (autoAdjust) "brightness auto" else ("brightness level=" + brightnessLevel)),
            BleProtocol.SID_UI_SETTING,
            BleProtocol.FLAG_REQUEST,
            magic,
            BleProtocol.buildSetBrightness(magic, autoAdjust, brightnessLevel),
            ACK_TIMEOUT_MS,
            -1,
            false,
        )
    }

    fun setWearDetection(enabled: Boolean): OutboundMessage {
        var magic: Int = magicPool.allocate()
        return OutboundMessage(
            "wear-detection-control",
            ("wear detection " + (if (enabled) "enable" else "disable")),
            BleProtocol.SID_UI_SETTING,
            BleProtocol.FLAG_REQUEST,
            magic,
            BleProtocol.buildSetWearDetection(magic, enabled),
            ACK_TIMEOUT_MS,
            -1,
            false,
        )
    }

    fun createLayout(): OutboundMessage {
        var magic: Int = magicPool.allocate()
        return OutboundMessage(
            "create-layout",
            "create-layout",
            BleProtocol.SID_EVENHUB,
            BleProtocol.FLAG_REQUEST,
            magic,
            BleProtocol.buildCreateInputPage(magic),
            ACK_TIMEOUT_MS,
            -1,
            false,
        )
    }

    fun startupTextProbe(): OutboundMessage {
        var magic: Int = magicPool.allocate()
        return OutboundMessage(
            "startup-text-probe",
            "startup text probe",
            BleProtocol.SID_EVENHUB,
            BleProtocol.FLAG_REQUEST,
            magic,
            BleProtocol.buildDashboardTextUpgrade(magic),
            ACK_TIMEOUT_MS,
            -1,
            false,
        )
    }

    fun heartbeat(): OutboundMessage {
        var magic: Int = magicPool.allocate()
        return OutboundMessage(
            "heartbeat",
            "heartbeat",
            BleProtocol.SID_EVENHUB,
            BleProtocol.FLAG_REQUEST,
            magic,
            BleProtocol.buildHeartbeat(magic),
            HEARTBEAT_TIMEOUT_MS,
            -1,
            false,
        )
    }

    fun batteryQuery(): OutboundMessage {
        var magic: Int = magicPool.allocate()
        return OutboundMessage(
            "battery",
            "battery",
            BleProtocol.SID_UI_SETTING,
            BleProtocol.FLAG_REQUEST,
            magic,
            BleProtocol.buildSettingsQuery(magic),
            ACK_TIMEOUT_MS,
            -1,
            false,
        )
    }

    fun faceclawWakeControl(operation: Int, nonce: Int, leftArm: Boolean): OutboundMessage {
        return OutboundMessage(
            "wake-lease-control",
            (((("wake lease op=" + operation) + " nonce=") + nonce) +
                (if (leftArm) " L" else " R")),
            BleProtocol.SID_UI_SETTING,
            BleProtocol.FLAG_REQUEST,
            0,
            BleProtocol.buildFaceclawWakeControl(operation, nonce),
            ACK_TIMEOUT_MS,
            -1,
            leftArm,
        )
    }

    fun faceclawFramebufferControl(operation: Int, leftArm: Boolean): OutboundMessage {
        return OutboundMessage(
            "framebuffer-lease-control",
            (("framebuffer lease op=" + operation) + (if (leftArm) " L" else " R")),
            BleProtocol.SID_UI_SETTING,
            BleProtocol.FLAG_REQUEST,
            0,
            BleProtocol.buildFaceclawWakeControl(operation, 0),
            ACK_TIMEOUT_MS,
            -1,
            leftArm,
        )
    }

    /** CFW mic_control write (settings field 103) targeted at one temple. */
    fun faceclawMicControl(record: ByteArray, label: String, leftArm: Boolean): OutboundMessage {
        return OutboundMessage(
            "mic-control",
            (("mic control " + label) + (if (leftArm) " L" else " R")),
            BleProtocol.SID_UI_SETTING,
            BleProtocol.FLAG_REQUEST,
            0,
            BleProtocol.buildFaceclawMicControl(record),
            ACK_TIMEOUT_MS,
            -1,
            leftArm,
        )
    }

    fun faceclawWearQuery(leftArm: Boolean): OutboundMessage {
        return OutboundMessage(
            "wear-query-control",
            ("wear state query" + (if (leftArm) " L" else " R")),
            BleProtocol.SID_UI_SETTING,
            BleProtocol.FLAG_REQUEST,
            0,
            BleProtocol.buildFaceclawWakeControl(BleProtocol.FACECLAW_WEAR_OP_QUERY, 0),
            ACK_TIMEOUT_MS,
            -1,
            leftArm,
        )
    }
}
