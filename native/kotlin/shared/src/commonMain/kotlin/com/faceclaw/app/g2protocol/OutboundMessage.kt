package com.faceclaw.app

import kotlin.jvm.JvmField

/** Mutable attempt state, owned by the communicator and guarded by its lock. */
class OutboundMessage(
    @JvmField val kind: String?,
    @JvmField val label: String?,
    @JvmField val sid: Int,
    @JvmField val flag: Int,
    @JvmField var magic: Int,
    message: ByteArray?,
    @JvmField val ackTimeoutMs: Int,
    @JvmField val tileIndex: Int,
    @JvmField val isLeftArmMessage: Boolean,
) {
    @JvmField val message: ByteArray = message?.copyOf() ?: ByteArray(0)
    @JvmField
    val cfwChecksum: Int = if (sid == CfwTransport.SID) CfwTransport.crc(this.message) else 0
    @JvmField var cfwAckLenses = 0
    @JvmField var cfwRetries = 0
    @JvmField var cfwRetryPending = false
    @JvmField var imageUpdateId = 0
    @JvmField var imageMessageNumber = 0
    @JvmField var imageMessageCount = 0
    @JvmField var sentAtMs = 0L
    @JvmField var writeStartedAtMs = 0L
    @JvmField var ackDeadlineAtMs = 0L
    @JvmField var ackPayload = ByteArray(0)
    @JvmField var onSent: MessageCallback? = null
    @JvmField var onAck: MessageCallback? = null
    @JvmField var onTimeout: MessageCallback? = null

    /** NACK names this attempt's sequence, even without a decoded size. */
    fun acceptCfwAck(ack: CfwTransport.Ack?): Boolean {
        if (
            ack == null ||
                sid != CfwTransport.SID ||
                magic != ack.streamId ||
                ack.messageId != 0 ||
                (ack.lens != 1 && ack.lens != 2)
        )
            return false
        if (ack.nack) {
            cfwRetryPending = true
            return false
        }
        if (message.size != ack.size || cfwChecksum != ack.checksum) return false
        cfwAckLenses = cfwAckLenses or ack.lens
        return !cfwRetryPending && cfwAckLenses == CfwTransport.BOTH
    }

    /** Replace an attempt atomically under the communicator lock. */
    fun prepareCfwReplay(streamId: Int) {
        magic = streamId
        cfwRetries++
        cfwAckLenses = 0
        cfwRetryPending = false
        ackDeadlineAtMs = 0
        ackPayload = ByteArray(0)
    }

    fun setImageUpdatePosition(updateId: Int, messageNumber: Int, messageCount: Int) {
        imageUpdateId = updateId
        imageMessageNumber = messageNumber
        imageMessageCount = messageCount
    }
}
