// Ported from callbacked/kinesis (MIT, Copyright (c) 2026 callbacked): Sources/KinesisCore/BandBatteryStatus.swift,
// by way of tetramo-labs/glassly (MIT).
package com.faceclaw.app.neuralband

/** BatteryInfoResp.batteryData, mapped from the SDK's serializer and consumer. */
data class BandBatteryStatus(val level: Int, val charging: Boolean?) {
    companion object {
        operator fun invoke(response: ByteArray): BandBatteryStatus {
            val rpc = ProtoFields(response)
            if (rpc.requiredInteger(2) != 1uL) throw BandProtocolError("Battery status unavailable")
            val inner = ProtoFields(rpc.bytes(3))
            val battery = ProtoFields(inner.bytes(1))
            val level = battery.requiredInteger(1)
            if (level > 100uL) throw BandProtocolError("Invalid battery level")
            val charging = if (battery.contains(2)) {
                val value = battery.requiredInteger(2)
                if (value > 1uL) throw BandProtocolError("Invalid charging flag")
                value == 1uL
            } else {
                null
            }
            return BandBatteryStatus(level.toInt(), charging)
        }
    }
}
