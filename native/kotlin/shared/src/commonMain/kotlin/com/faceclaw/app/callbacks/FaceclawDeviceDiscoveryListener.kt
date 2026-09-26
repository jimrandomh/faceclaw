package com.faceclaw.app

/** Callbacks from FaceclawDeviceDiscovery's live scan to the TypeScript layer. */
interface FaceclawDeviceDiscoveryListener {
    /**
     * One advertisement (or one bonded device) as a JSON object: {address, name, manufacturerData
     * (hex, company id included), rssi|null, txPower|null, connectable|null, bonded, source,
     * seenAtMs}. Protocol decoding happens in TypeScript (see app/g2/even-advertisement.ts).
     */
    fun onAdvertisement(json: String?): Unit

    /** The platform refused to start or continue the scan. */
    fun onScanFailed(errorCode: Int, message: String?): Unit

    /** Diagnostic line for the pairing log. */
    fun onLog(line: String?): Unit
}
