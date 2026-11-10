// From tetramo-labs/glassly (MIT): bluetooth-sdk controllers/neuralband/core/BandOta.kt.
package com.faceclaw.app.neuralband

/** What the band reports about itself on the device-info service during startup. */
data class BandDeviceInfo(
    val firmware: String,
    val software: String,
    val hardware: String,
    val serial: String,
    val releaseBranch: String,
    val model: String,
    val models: List<String>,
) {
    internal companion object {
        fun find(fields: ProtoFields, depth: Int = 0): BandDeviceInfo? {
            val serial = fields.text(6)?.takeIf { it.length in 4..64 && it.all { c -> c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' } }
            val firmware = fields.text(2)
            if (serial != null && firmware != null) {
                return BandDeviceInfo(
                    firmware = firmware,
                    software = fields.text(3) ?: "",
                    hardware = fields.text(4) ?: "",
                    serial = serial,
                    releaseBranch = fields.text(13) ?: "",
                    model = fields.text(5) ?: "",
                    models = fields.allBytes(10).map { it.toString(Charsets.UTF_8) },
                )
            }
            if (depth >= 3) return null
            for (bytes in fields.allByteFields()) {
                val inner = try {
                    ProtoFields(bytes)
                } catch (e: BandProtocolError) {
                    continue
                }
                find(inner, depth + 1)?.let { return it }
            }
            return null
        }
    }
}
