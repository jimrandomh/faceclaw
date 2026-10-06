package com.faceclaw.app

import kotlin.jvm.JvmStatic

/** Ordered completion and go-back-N recovery for the custom-message window. */
class CfwMessageWindow private constructor() {
    companion object {
        // An unresolved message is presumed lost only once both kinds of progress on
        // its arm have stopped: no write completion for DATA_STALL_MS, and no CFW ack
        // for ACK_STALL_MS since it was sent. Android withholds write completions
        // while its outgoing queue is congested, so completions mean data is still
        // draining; acks mean the firmware is still working through the window. A
        // single 500 ms deadline from send replayed large uploads whose acks were
        // just slow (an 11 KB upload acked by one lens at 536 ms), and under
        // bandwidth pressure (LE Audio streaming) it tore the session down.
        const val DATA_STALL_MS = 500
        const val ACK_STALL_MS = 3_000
        const val MAX_RETRIES = 3

        /** When a message sent at [sentAtMs] counts as lost, given its arm's latest write completion and CFW ack. */
        @JvmStatic
        fun ackDeadline(sentAtMs: Long, lastArmWriteAtMs: Long, lastArmAckAtMs: Long): Long =
            maxOf(lastArmWriteAtMs + DATA_STALL_MS, maxOf(sentAtMs, lastArmAckAtMs) + ACK_STALL_MS)

        /** ID reuse must not invalidate an earlier command still eligible for replay. */
        @JvmStatic
        fun canSend(messages: Iterable<OutboundMessage>, candidate: OutboundMessage): Boolean =
            candidate.sid != CfwTransport.SID ||
                candidate.message.firstOrNull()?.toInt() != ResourceCacheState.EVICT_MODE ||
                messages.none { it.sid == CfwTransport.SID }

        @JvmStatic
        fun acknowledgedHead(messages: Iterable<OutboundMessage>): OutboundMessage? {
            for (message in messages) {
                if (message.sid != CfwTransport.SID) continue
                return if (!message.cfwRetryPending && message.cfwAckLenses == CfwTransport.BOTH)
                    message
                else null
            }
            return null
        }

        @JvmStatic
        fun replayWindow(messages: Iterable<OutboundMessage>, nowMs: Long): List<OutboundMessage> {
            val replay = mutableListOf<OutboundMessage>()
            var failed = false
            for (message in messages) {
                if (message.sid != CfwTransport.SID) continue
                failed =
                    failed ||
                        message.cfwRetryPending ||
                        (message.cfwAckLenses != CfwTransport.BOTH &&
                            message.ackDeadlineAtMs > 0 &&
                            message.ackDeadlineAtMs <= nowMs)
                replay.add(message)
            }
            // Replaying only the named failure can strand an older unresolved
            // attempt at the head. Rewind the entire unresolved custom window.
            if (!failed) replay.clear()
            return replay
        }
    }
}
