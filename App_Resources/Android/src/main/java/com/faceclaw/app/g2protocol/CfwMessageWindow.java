package com.faceclaw.app;

import java.util.ArrayList;
import java.util.List;

/** Ordered completion and go-back-N recovery for the custom-message window. */
final class CfwMessageWindow {
    // Flappy capture: p99 ACK 63ms, max 77ms. Leave room for full-frame
    // processing while recovering a lost reply well before the stock timeout.
    static final int ACK_TIMEOUT_MS = 500;
    static final int MAX_RETRIES = 3;

    private CfwMessageWindow() {}

    static OutboundMessage acknowledgedHead(Iterable<OutboundMessage> messages) {
        for (OutboundMessage message : messages) {
            if (message.sid != CfwTransport.SID) continue;
            return !message.cfwRetryPending && message.cfwAckLenses == CfwTransport.BOTH ? message : null;
        }
        return null;
    }

    static List<OutboundMessage> replayWindow(Iterable<OutboundMessage> messages, long nowMs) {
        List<OutboundMessage> replay = new ArrayList<>();
        boolean failed = false;
        for (OutboundMessage message : messages) {
            if (message.sid != CfwTransport.SID) continue;
            failed |= message.cfwRetryPending || (message.cfwAckLenses != CfwTransport.BOTH
                    && message.ackDeadlineAtMs > 0 && message.ackDeadlineAtMs <= nowMs);
            replay.add(message);
        }
        // A lost ACK, first fragment, or NACK can leave an older attempt
        // unresolved. Replaying only the named failure strands that older
        // attempt at the head until its timeout. Rewind the unresolved window.
        if (!failed) replay.clear();
        return replay;
    }
}
