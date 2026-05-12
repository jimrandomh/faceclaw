package com.faceclaw.app;

public class MessageBuilder {
    private static final int ACK_TIMEOUT_MS = 3_500;
    private static final int HEARTBEAT_TIMEOUT_MS = 1_500;
    private static final int WARMUP_FRAGMENT_TIMEOUT_MS = 3_000;

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

    public OutboundMessage imageWarmupFragment(BleProtocol.ImageTileOptions tile, int sessionId, BleProtocol.ImageFragment fragment, byte[] bmp, boolean leftArm) {
        int magic = magicPool.allocate();
        return new OutboundMessage(
            "warmup",
            "warmup " + tile.name + "#" + fragment.index,
            BleProtocol.SID_EVENHUB,
            BleProtocol.FLAG_REQUEST,
            magic,
            BleProtocol.buildImageRawData(tile, sessionId, bmp.length, fragment, magic),
            WARMUP_FRAGMENT_TIMEOUT_MS,
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
            BleProtocol.buildImageRawData(plan.tile, plan.sessionId, plan.bmp.length, fragment, magic),
            ACK_TIMEOUT_MS,
            plan.tileIndex,
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

    public OutboundMessage createLayout(BleProtocol.ImageTileOptions[] tiles) {
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
}
