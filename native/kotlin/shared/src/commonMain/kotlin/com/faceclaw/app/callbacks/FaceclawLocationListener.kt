package com.faceclaw.app

/** One-shot Android location callbacks for the TypeScript Weather bridge. */
interface FaceclawLocationListener {
    fun onLocation(
        latitude: Double,
        longitude: Double,
        accuracyMeters: Float,
        timestampMs: Long,
    ): Unit

    fun onError(message: String?): Unit
}
