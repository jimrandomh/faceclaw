package com.faceclaw.app

/** Continuous location callbacks for the TypeScript navigation bridge. */
interface FaceclawLocationTrackerListener {
    /**
     * A new fix. bearingDeg/speedMps are -1 when the fix doesn't carry them (common when
     * stationary); accuracyMeters is -1 when unknown.
     */
    fun onLocation(
        latitude: Double,
        longitude: Double,
        accuracyMeters: Float,
        bearingDeg: Float,
        speedMps: Float,
        timestampMs: Long,
    ): Unit

    fun onError(message: String?): Unit
}
