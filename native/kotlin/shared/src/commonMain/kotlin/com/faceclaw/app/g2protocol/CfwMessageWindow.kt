package com.faceclaw.app

import kotlin.jvm.JvmStatic

/** Ordered completion and go-back-N recovery for the custom-message window. */
class CfwMessageWindow private constructor() {
    companion object {
        // Flappy capture: p99 ACK 63ms, max 77ms. Allow full-frame processing
        // while recovering a lost reply well before the stock timeout.
        const val ACK_TIMEOUT_MS = 500
        const val MAX_RETRIES = 3

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
