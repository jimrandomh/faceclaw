package com.faceclaw.app;
import java.util.List;

public final class OutboundMessage {
    final String kind;
    final String label;
    final int sid;
    final int magic;
    final List<byte[]> frames;
    final int ackTimeoutMs;
    final int tileIndex;
    final byte[] tileBmp;

    int imageUpdateId;
    int imageMessageNumber;
    int imageMessageCount;
    long sentAtMs;
    long writeStartedAtMs;
    long ackDeadlineAtMs;
    byte[] ackPayload = new byte[0];
    Runnable onAck;
    Runnable onTimeout;

    OutboundMessage(String kind, String label, int sid, int magic, List<byte[]> frames, int ackTimeoutMs, int tileIndex, byte[] tileBmp) {
        this.kind = kind;
        this.label = label;
        this.sid = sid;
        this.magic = magic;
        this.frames = frames;
        this.ackTimeoutMs = ackTimeoutMs;
        this.tileIndex = tileIndex;
        this.tileBmp = BmpUtil.copyTileBmp(tileBmp);
    }

    void setImageUpdatePosition(int updateId, int messageNumber, int messageCount) {
        this.imageUpdateId = updateId;
        this.imageMessageNumber = messageNumber;
        this.imageMessageCount = messageCount;
    }
}
