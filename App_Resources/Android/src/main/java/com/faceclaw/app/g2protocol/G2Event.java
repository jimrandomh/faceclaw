package com.faceclaw.app;

public final class G2Event {
    final String kind;
    final String containerName;
    final int eventType;
    final int eventSource;
    final int systemExitReasonCode;

    public G2Event(String kind, String containerName, int eventType, int eventSource, int systemExitReasonCode) {
        this.kind = kind;
        this.containerName = containerName;
        this.eventType = eventType;
        this.eventSource = eventSource;
        this.systemExitReasonCode = systemExitReasonCode;
    }

    public static G2Event decode(BleProtocol.ParsedFrame frame) {
        byte[] pb = BleProtocol.stripTrailingCrc(frame.pb);
        byte[] deviceEvent = BleProtocol.readFieldBytes(pb, 13);
        if (deviceEvent == null) {
            return null;
        }

        byte[] listEvent = BleProtocol.readFieldBytes(deviceEvent, 1);
        if (listEvent != null) {
            return new G2Event(
                "list-click",
                BleProtocol.readStringFieldValue(listEvent, 2),
                BleProtocol.readVarintFieldValue(listEvent, 5, BleProtocol.EVENT_CLICK),
                0,
                0
            );
        }

        byte[] textEvent = BleProtocol.readFieldBytes(deviceEvent, 2);
        if (textEvent != null) {
            return new G2Event(
                "text-click",
                BleProtocol.readStringFieldValue(textEvent, 2),
                BleProtocol.readVarintFieldValue(textEvent, 3, BleProtocol.EVENT_CLICK),
                0,
                0
            );
        }

        byte[] sysEvent = BleProtocol.readFieldBytes(deviceEvent, 3);
        if (sysEvent != null) {
            int eventType = BleProtocol.readVarintFieldValue(sysEvent, 1, BleProtocol.EVENT_CLICK);
            int eventSource = BleProtocol.readVarintFieldValue(sysEvent, 2, 0);
            int exitReason = BleProtocol.readVarintFieldValue(sysEvent, 4, 0);
            return new G2Event("sys-event", "", eventType, eventSource, exitReason);
        }
        return null;
    }

}
