package com.faceclaw.app;
import java.util.Arrays;

public final class OutboundMessage {
    final String kind;
    final String label;
    final int sid;
    final int flag;
    int magic;
    final byte[] message;
    final int ackTimeoutMs;
    final int tileIndex;
    final boolean isLeftArmMessage;

    int cfwAckLenses, cfwRetries;
    boolean cfwRetryPending;
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

    /** NACK names this attempt's stream/message sequence, even without a decoded size. */
    boolean acceptCfwAck(CfwTransport.Ack ack) {
        if (ack == null || sid != CfwTransport.SID || magic != ack.streamId
                || ack.messageId != 0 || (ack.lens != 1 && ack.lens != 2)) return false;
        if (ack.nack) {
            cfwRetryPending = true;
            return false;
        }
        if (message.length != ack.size || cfwChecksum != ack.checksum) return false;
        cfwAckLenses |= ack.lens;
        return !cfwRetryPending && cfwAckLenses == CfwTransport.BOTH;
    }

    /** Replace an attempt atomically under the communicator lock. */
    void prepareCfwReplay(int streamId) {
        magic = streamId;
        ++cfwRetries;
        cfwAckLenses = 0;
        cfwRetryPending = false;
        ackDeadlineAtMs = 0;
        ackPayload = new byte[0];
    }

    void setImageUpdatePosition(int updateId, int messageNumber, int messageCount) {
        this.imageUpdateId = updateId;
        this.imageMessageNumber = messageNumber;
        this.imageMessageCount = messageCount;
    }
}
