package com.faceclaw.app

import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic

class G2Event {
    companion object {
        @JvmStatic
        fun decode(frame: BleProtocol.ParsedFrame): G2Event? {
            return decodePayload(frame.sid, BleProtocol.stripTrailingCrc(frame.pb))
        }

        /** Decode an already validated payload, without the envelope's trailing CRC. */
        @JvmStatic
        fun decodePayload(sid: Int, pb: ByteArray): G2Event? {
            if ((sid == BleProtocol.SID_EVEN_AI)) {
                var commandId: Int = BleProtocol.readVarintFieldValue(pb, 1, -1)
                if ((commandId != BleProtocol.EVEN_AI_CMD_CTRL)) {
                    return null
                }
                var ctrl: ByteArray? = BleProtocol.readFieldBytes(pb, 3)
                if ((ctrl == null)) {
                    return null
                }
                var status: Int = BleProtocol.readVarintFieldValue(ctrl, 1, -1)
                if ((status < 0)) {
                    return null
                }
                return G2Event("even-ai", "", status, 0, 0)
            }
            var deviceEvent: ByteArray? = BleProtocol.readFieldBytes(pb, 13)
            if ((deviceEvent == null)) {
                return null
            }
            var listEvent: ByteArray? = BleProtocol.readFieldBytes(deviceEvent, 1)
            if ((listEvent != null)) {
                return G2Event(
                    "list-click",
                    BleProtocol.readStringFieldValue(listEvent, 2),
                    BleProtocol.readVarintFieldValue(listEvent, 5, BleProtocol.EVENT_CLICK),
                    0,
                    0,
                )
            }
            var textEvent: ByteArray? = BleProtocol.readFieldBytes(deviceEvent, 2)
            if ((textEvent != null)) {
                return G2Event(
                    "text-click",
                    BleProtocol.readStringFieldValue(textEvent, 2),
                    BleProtocol.readVarintFieldValue(textEvent, 3, BleProtocol.EVENT_CLICK),
                    0,
                    0,
                )
            }
            var sysEvent: ByteArray? = BleProtocol.readFieldBytes(deviceEvent, 3)
            if ((sysEvent != null)) {
                var eventType: Int =
                    BleProtocol.readVarintFieldValue(sysEvent, 1, BleProtocol.EVENT_CLICK)
                var eventSource: Int = BleProtocol.readVarintFieldValue(sysEvent, 2, 0)
                var exitReason: Int = BleProtocol.readVarintFieldValue(sysEvent, 4, 0)
                var imu: ByteArray? = BleProtocol.readFieldBytes(sysEvent, 3)
                if ((imu != null)) {
                    var x: Double = BleProtocol.readFloatFieldValue(imu, 1, 0f).toDouble()
                    var y: Double = BleProtocol.readFloatFieldValue(imu, 2, 0f).toDouble()
                    var z: Double = BleProtocol.readFloatFieldValue(imu, 3, 0f).toDouble()
                    return G2Event(
                        "sys-event",
                        "",
                        eventType,
                        eventSource,
                        exitReason,
                        true,
                        x,
                        y,
                        z,
                    )
                }
                return G2Event("sys-event", "", eventType, eventSource, exitReason)
            }
            return null
        }
    }

    @JvmField val kind: String

    @JvmField val containerName: String

    @JvmField val eventType: Int

    @JvmField val eventSource: Int

    @JvmField val systemExitReasonCode: Int

    @JvmField val hasImu: Boolean

    @JvmField val imuX: Double

    @JvmField val imuY: Double

    @JvmField val imuZ: Double

    constructor(
        kind: String,
        containerName: String,
        eventType: Int,
        eventSource: Int,
        systemExitReasonCode: Int,
    ) : this(
        kind,
        containerName,
        eventType,
        eventSource,
        systemExitReasonCode,
        false,
        0.0,
        0.0,
        0.0,
    ) {}

    constructor(
        kind: String,
        containerName: String,
        eventType: Int,
        eventSource: Int,
        systemExitReasonCode: Int,
        hasImu: Boolean,
        imuX: Double,
        imuY: Double,
        imuZ: Double,
    ) {
        this.kind = kind
        this.containerName = containerName
        this.eventType = eventType
        this.eventSource = eventSource
        this.systemExitReasonCode = systemExitReasonCode
        this.hasImu = hasImu
        this.imuX = imuX
        this.imuY = imuY
        this.imuZ = imuZ
    }
}
