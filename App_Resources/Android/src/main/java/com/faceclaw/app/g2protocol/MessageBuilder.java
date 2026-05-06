package com.faceclaw.app;
import java.util.Arrays;

public class MessageBuilder {
    private static final int ACK_TIMEOUT_MS = 3_500;
    private static final int HEARTBEAT_TIMEOUT_MS = 1_500;
    private static final int WARMUP_FRAGMENT_TIMEOUT_MS = 3_000;

    private BleMagicPool magicPool;
    private int nextTransportSeq = 0x40;

    public MessageBuilder(BleMagicPool magicPool) {
        this.magicPool = magicPool;
    }

    public OutboundMessage prelude() {
        return new OutboundMessage(
            "prelude", "prelude",
            BleProtocol.PRELUDE_ACK_SID,
            BleProtocol.PRELUDE_ACK_MAGIC,
            CollectionUtils.singletonList(Arrays.copyOf(BleProtocol.PRELUDE_F5872, BleProtocol.PRELUDE_F5872.length)),
            ACK_TIMEOUT_MS,
            0,
            null
        );
    }

    public OutboundMessage shutdown(int exitMode) {
        int magic = magicPool.allocate();
        return new OutboundMessage(
            "shutdown",
            "shutdown mode=" + exitMode,
            BleProtocol.SID_EVENHUB,
            magic,
            BleProtocol.framePb(
                BleProtocol.buildShutdown(magic, exitMode),
                BleProtocol.SID_EVENHUB,
                BleProtocol.FLAG_REQUEST,
                nextTransportSeq++
            ),
            ACK_TIMEOUT_MS,
            -1,
            null
        );
    }

    public OutboundMessage imageWarmupFragment(BleProtocol.ImageTileOptions tile, int sessionId, BleProtocol.ImageFragment fragment, byte[] bmp) {
        int magic = magicPool.allocate();
        return new OutboundMessage(
            "warmup",
            "warmup " + tile.name + "#" + fragment.index,
            BleProtocol.SID_EVENHUB,
            magic,
            BleProtocol.framePb(
                BleProtocol.buildImageRawData(tile, sessionId, bmp.length, fragment, magic),
                BleProtocol.SID_EVENHUB, BleProtocol.FLAG_REQUEST,
                nextTransportSeq++
            ),
            WARMUP_FRAGMENT_TIMEOUT_MS,
            0,
            bmp
        );
    }

    public OutboundMessage imageFragment(BleProtocol.ImageFragment fragment, BleImageOptimizer.TileImagePlan plan, boolean requestAck) {
        int magic = requestAck ? magicPool.allocate() : 0;
        return new OutboundMessage(
            "image",
            "image " + plan.tile.name + "#" + fragment.index,
            BleProtocol.SID_EVENHUB,
            magic,
            BleProtocol.framePb(
                BleProtocol.buildImageRawData(plan.tile, plan.sessionId, plan.bmp.length, fragment, magic),
                BleProtocol.SID_EVENHUB, BleProtocol.FLAG_REQUEST,
                nextTransportSeq++
            ),
            ACK_TIMEOUT_MS,
            plan.tileIndex,
            plan.bmp
        );
    }

    public OutboundMessage enableOrDisableMic(boolean enable) {
        int magic = magicPool.allocate();
        return new OutboundMessage(
            "audio-control",
            enable ? "G2 mic enable" : "G2 mic disable",
            BleProtocol.SID_EVENHUB,
            magic,
            BleProtocol.framePb(
                BleProtocol.buildAudioControl(magic, enable),
                BleProtocol.SID_EVENHUB,
                BleProtocol.FLAG_REQUEST,
                nextTransportSeq++
            ),
            ACK_TIMEOUT_MS,
            -1,
            null
        );
    }

    public OutboundMessage createLayout(BleProtocol.ImageTileOptions[] tiles) {
        int magic = magicPool.allocate();
        return new OutboundMessage(
            "create-layout",
            "create-layout",
            BleProtocol.SID_EVENHUB,
            magic,
            BleProtocol.framePb(
                BleProtocol.buildCreateMixedImagePage(magic, tiles),
                BleProtocol.SID_EVENHUB,
                BleProtocol.FLAG_REQUEST,
                nextTransportSeq++
            ),
            ACK_TIMEOUT_MS,
            -1,
            null
        );
    }

    public OutboundMessage startupTextProbe() {
        int magic = magicPool.allocate();
        return new OutboundMessage(
            "startup-text-probe",
            "startup text probe",
            BleProtocol.SID_EVENHUB,
            magic,
            BleProtocol.framePb(
                BleProtocol.buildDashboardTextUpgrade(magic),
                BleProtocol.SID_EVENHUB,
                BleProtocol.FLAG_REQUEST,
                nextTransportSeq++
            ),
            ACK_TIMEOUT_MS,
            -1,
            null
        );
    }

    public OutboundMessage heartbeat() {
        int magic = magicPool.allocate();
        return new OutboundMessage(
            "heartbeat",
            "heartbeat",
            BleProtocol.SID_EVENHUB,
            magic,
            BleProtocol.framePb(BleProtocol.buildHeartbeat(magic), BleProtocol.SID_EVENHUB, BleProtocol.FLAG_REQUEST, nextTransportSeq++),
            HEARTBEAT_TIMEOUT_MS,
            -1,
            null
        );
    }

    public OutboundMessage batteryQuery() {
        int magic = magicPool.allocate();
        return new OutboundMessage(
            "battery",
            "battery",
            BleProtocol.SID_UI_SETTING,
            magic,
            BleProtocol.framePb(
                BleProtocol.buildSettingsQuery(magic),
                BleProtocol.SID_UI_SETTING,
                BleProtocol.FLAG_REQUEST,
                nextTransportSeq++
            ),
            ACK_TIMEOUT_MS,
            -1,
            null
        );
    }
}
