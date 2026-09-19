package com.faceclaw.app

/** Receives stock compass heading and calibration notifications on the thread that subscribed. */
interface FaceclawCompassListener {
    fun onCompassEvent(
        command: Int,
        headingDegrees: Int,
        magneticAccuracy: Int,
        magneticAnomalies: Int,
        orientationSource: Int,
        diagnosticFlags: Int,
        sampleTimeMs: Long,
    ): Unit
}
