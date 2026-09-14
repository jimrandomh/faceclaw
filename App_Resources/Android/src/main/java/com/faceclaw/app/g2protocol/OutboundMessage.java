package com.faceclaw.app;
import java.util.Arrays;

public final class OutboundMessage {
    final String kind;
    final String label;
    final int sid;
    final int flag;
    final int magic;
    final byte[] message;
    final int ackTimeoutMs;
    final int tileIndex;
    final boolean isLeftArmMessage;

    int cfwAckLenses;
    final int cfwChecksum;

    int imageUpdateId;
    int imageMessageNumber;
    int imageMessageCount;
    long sentAtMs;
    long writeStartedAtMs;
    long ackDeadlineAtMs;
    byte[] ackPayload = new byte[0];
    Runnable onSent;
    Runnable onAck;
    Runnable onTimeout;

    OutboundMessage(String kind, String label, int sid, int flag, int magic, byte[] message, int ackTimeoutMs, int tileIndex, boolean isLeftArmMessage) {
        this.kind = kind;
        this.label = label;
        this.sid = sid;
        this.flag = flag;
        this.magic = magic;
        this.message = message == null ? new byte[0] : Arrays.copyOf(message, message.length);
        this.cfwChecksum = sid == CfwTransport.SID ? CfwTransport.crc(this.message) : 0;
        this.ackTimeoutMs = ackTimeoutMs;
        this.tileIndex = tileIndex;
        this.isLeftArmMessage = isLeftArmMessage;
    }

    /** Record only a matching processing ACK; completion requires both lenses. */
    boolean acceptCfwAck(CfwTransport.Ack ack) {
        if (ack == null || sid != CfwTransport.SID || magic != ack.streamId
                || ack.messageId != 0 || message.length != ack.size || cfwChecksum != ack.checksum
                || (ack.lens != 1 && ack.lens != 2)) return false;
        cfwAckLenses |= ack.lens;
        return cfwAckLenses == CfwTransport.BOTH;
    }

    void setImageUpdatePosition(int updateId, int messageNumber, int messageCount) {
        this.imageUpdateId = updateId;
        this.imageMessageNumber = messageNumber;
        this.imageMessageCount = messageCount;
    }
}
