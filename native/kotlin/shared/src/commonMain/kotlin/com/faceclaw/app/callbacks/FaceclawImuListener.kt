package com.faceclaw.app

/**
 * Receives IMU (accelerometer) readings decoded from the glasses' sys-event stream. Registered on
 * FaceclawBleCommunicator via addImuListener; callbacks are delivered on the Android main thread.
 */
interface FaceclawImuListener {
    fun onImuData(x: Double, y: Double, z: Double, eventSource: Int): Unit
}
