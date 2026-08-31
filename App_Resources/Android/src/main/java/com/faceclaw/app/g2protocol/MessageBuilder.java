package com.faceclaw.app;

public class MessageBuilder {
    private static final int ACK_TIMEOUT_MS = 3_500;
    private static final int HEARTBEAT_TIMEOUT_MS = 1_500;

    private BleMagicPool magicPool;

    public MessageBuilder(BleMagicPool magicPool) {
        this.magicPool = magicPool;
    }

    public OutboundMessage prelude() {
        return new OutboundMessage(
            "prelude", "prelude",
            BleProtocol.PRELUDE_ACK_SID,
            BleProtocol.FLAG_REQUEST,
            BleProtocol.PRELUDE_ACK_MAGIC,
            BleProtocol.PRELUDE_F5872_PAYLOAD,
            ACK_TIMEOUT_MS,
            -1,
            false
        );
    }

    /** The per-connection sid-0x80 security-auth request (one per arm). */
    public OutboundMessage securityAuth(boolean leftArm) {
        int magic = magicPool.allocate();
        return new OutboundMessage(
            "security-auth",
            "security auth " + (leftArm ? "L" : "R"),
            BleProtocol.SID_SECURITY_AUTH,
            BleProtocol.FLAG_SECURITY_AUTH,
            magic,
            BleProtocol.buildAuthenticationRequest(magic),
            ConnectionOptions.SECURITY_AUTH_SOFT_TIMEOUT_MS,
            -1,
            leftArm
        );
    }

    public OutboundMessage shutdown(int exitMode) {
        int magic = magicPool.allocate();
        return new OutboundMessage(
            "shutdown",
            "shutdown mode=" + exitMode,
            BleProtocol.SID_EVENHUB,
            BleProtocol.FLAG_REQUEST,
            magic,
            BleProtocol.buildShutdown(magic, exitMode),
            ACK_TIMEOUT_MS,
            -1,
            false
        );
    }

    public OutboundMessage imagePayload(
        BleProtocol.ImageTileOptions tile,
        int sessionId,
        byte[] payload,
        String label,
        boolean leftArm
    ) {
        return imagePayload("sound", tile, sessionId, payload, label, leftArm);
    }

    public OutboundMessage imagePayload(
        String kind,
        BleProtocol.ImageTileOptions tile,
        int sessionId,
        byte[] payload,
        String label,
        boolean leftArm
    ) {
        BleProtocol.ImageFragment fragment =
            new BleProtocol.ImageFragment(0, payload, payload.length);
        int magic = magicPool.allocate();
        return new OutboundMessage(
            kind,
            label,
            BleProtocol.SID_EVENHUB,
            BleProtocol.FLAG_REQUEST,
            magic,
            BleProtocol.buildImageRawData(tile, sessionId, payload.length, fragment, magic),
            ACK_TIMEOUT_MS,
            -1,
            leftArm
        );
    }

    public OutboundMessage imageFragment(BleProtocol.ImageFragment fragment, BleImageOptimizer.TileImagePlan plan, boolean requestAck, boolean leftArm) {
        int magic = requestAck ? magicPool.allocate() : 0;
        return new OutboundMessage(
            "image",
            "image " + plan.tile.name + "#" + fragment.index,
            BleProtocol.SID_EVENHUB,
            BleProtocol.FLAG_REQUEST,
            magic,
            BleProtocol.buildImageRawData(plan.tile, plan.sessionId, plan.payload.length, fragment, magic),
            ACK_TIMEOUT_MS,
            plan.tileIndex,
            leftArm
        );
    }

    public OutboundMessage cfwCleanup(
        BleProtocol.ImageTileOptions tile,
        int sessionId,
        boolean leftArm
    ) {
        byte[] payload = new byte[] { (byte) BleProtocol.CFW_IMAGE_MODE_CLEANUP };
        return imagePayload(
            "cfw-cleanup",
            tile,
            sessionId,
            payload,
            "CFW cleanup",
            leftArm
        );
    }

    public OutboundMessage enableOrDisableMic(boolean enable) {
        int magic = magicPool.allocate();
        return new OutboundMessage(
            "audio-control",
            enable ? "G2 mic enable" : "G2 mic disable",
            BleProtocol.SID_EVENHUB,
            BleProtocol.FLAG_REQUEST,
            magic,
            BleProtocol.buildAudioControl(magic, enable),
            ACK_TIMEOUT_MS,
            -1,
            false
        );
    }

    public OutboundMessage enableOrDisableImu(boolean enable, int reportFrq) {
        int magic = magicPool.allocate();
        return new OutboundMessage(
            "imu-control",
            enable ? "IMU enable" : "IMU disable",
            BleProtocol.SID_EVENHUB,
            BleProtocol.FLAG_REQUEST,
            magic,
            BleProtocol.buildImuControl(magic, enable, reportFrq),
            ACK_TIMEOUT_MS,
            -1,
            false
        );
    }

    public OutboundMessage setBrightness(boolean autoAdjust, int brightnessLevel) {
        int magic = magicPool.allocate();
        return new OutboundMessage(
            "brightness-control",
            autoAdjust ? "brightness auto" : "brightness level=" + brightnessLevel,
            BleProtocol.SID_UI_SETTING,
            BleProtocol.FLAG_REQUEST,
            magic,
            BleProtocol.buildSetBrightness(magic, autoAdjust, brightnessLevel),
            ACK_TIMEOUT_MS,
            -1,
            false
        );
    }

    public OutboundMessage setWearDetection(boolean enabled) {
        int magic = magicPool.allocate();
        return new OutboundMessage(
            "wear-detection-control",
            "wear detection " + (enabled ? "enable" : "disable"),
            BleProtocol.SID_UI_SETTING,
            BleProtocol.FLAG_REQUEST,
            magic,
            BleProtocol.buildSetWearDetection(magic, enabled),
            ACK_TIMEOUT_MS,
            -1,
            false
        );
    }

    public OutboundMessage createLayout(BleProtocol.ImageTileOptions... tiles) {
        int magic = magicPool.allocate();
        return new OutboundMessage(
            "create-layout",
            "create-layout",
            BleProtocol.SID_EVENHUB,
            BleProtocol.FLAG_REQUEST,
            magic,
            BleProtocol.buildCreateMixedImagePage(magic, tiles),
            ACK_TIMEOUT_MS,
            -1,
            false
        );
    }

    public OutboundMessage startupTextProbe() {
        int magic = magicPool.allocate();
        return new OutboundMessage(
            "startup-text-probe",
            "startup text probe",
            BleProtocol.SID_EVENHUB,
            BleProtocol.FLAG_REQUEST,
            magic,
            BleProtocol.buildDashboardTextUpgrade(magic),
            ACK_TIMEOUT_MS,
            -1,
            false
        );
    }

    public OutboundMessage heartbeat() {
        int magic = magicPool.allocate();
        return new OutboundMessage(
            "heartbeat",
            "heartbeat",
            BleProtocol.SID_EVENHUB,
            BleProtocol.FLAG_REQUEST,
            magic,
            BleProtocol.buildHeartbeat(magic),
            HEARTBEAT_TIMEOUT_MS,
            -1,
            false
        );
    }

    public OutboundMessage batteryQuery() {
        int magic = magicPool.allocate();
        return new OutboundMessage(
            "battery",
            "battery",
            BleProtocol.SID_UI_SETTING,
            BleProtocol.FLAG_REQUEST,
            magic,
            BleProtocol.buildSettingsQuery(magic),
            ACK_TIMEOUT_MS,
            -1,
            false
        );
    }

    public OutboundMessage faceclawWakeControl(int operation, int nonce, boolean leftArm) {
        return new OutboundMessage(
            "wake-lease-control",
            "wake lease op=" + operation + " nonce=" + nonce + (leftArm ? " L" : " R"),
            BleProtocol.SID_UI_SETTING,
            BleProtocol.FLAG_REQUEST,
            0,
            BleProtocol.buildFaceclawWakeControl(operation, nonce),
            ACK_TIMEOUT_MS,
            -1,
            leftArm
        );
    }

    public OutboundMessage faceclawFramebufferControl(int operation, boolean leftArm) {
        return new OutboundMessage(
            "framebuffer-lease-control",
            "framebuffer lease op=" + operation + (leftArm ? " L" : " R"),
            BleProtocol.SID_UI_SETTING,
            BleProtocol.FLAG_REQUEST,
            0,
            BleProtocol.buildFaceclawWakeControl(operation, 0),
            ACK_TIMEOUT_MS,
            -1,
            leftArm
        );
    }

    /** CFW mic_control write (settings field 103) targeted at one temple. */
    public OutboundMessage faceclawMicControl(byte[] record, String label, boolean leftArm) {
        return new OutboundMessage(
            "mic-control",
            "mic control " + label + (leftArm ? " L" : " R"),
            BleProtocol.SID_UI_SETTING,
            BleProtocol.FLAG_REQUEST,
            0,
            BleProtocol.buildFaceclawMicControl(record),
            ACK_TIMEOUT_MS,
            -1,
            leftArm
        );
    }

    public OutboundMessage faceclawWearQuery(boolean leftArm) {
        return new OutboundMessage(
            "wear-query-control",
            "wear state query" + (leftArm ? " L" : " R"),
            BleProtocol.SID_UI_SETTING,
            BleProtocol.FLAG_REQUEST,
            0,
            BleProtocol.buildFaceclawWakeControl(BleProtocol.FACECLAW_WEAR_OP_QUERY, 0),
            ACK_TIMEOUT_MS,
            -1,
            leftArm
        );
    }
}
