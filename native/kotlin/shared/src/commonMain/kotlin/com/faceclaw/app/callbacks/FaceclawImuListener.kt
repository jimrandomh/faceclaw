package com.faceclaw.app

/**
 * Receives IMU (accelerometer) readings decoded from the glasses' sys-event stream. Registered on
 * FaceclawBleCommunicator via addImuListener; callbacks are delivered on the Android main thread.
 * x, y, z are in g, in the canonical frame of every glasses model (+x forward, +y left, +z up;
 * see ImuOrientation).
 */
interface FaceclawImuListener {
    fun onImuData(x: Double, y: Double, z: Double, eventSource: Int): Unit
}
