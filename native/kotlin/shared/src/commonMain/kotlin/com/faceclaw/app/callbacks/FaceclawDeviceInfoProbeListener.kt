package com.faceclaw.app

/** Callbacks from FaceclawDeviceInfoProbe to the TypeScript layer. */
interface FaceclawDeviceInfoProbeListener {
    fun onLog(line: String?): Unit

    /** Lifecycle: connecting/authenticating for each arm, then querying. */
    fun onState(state: String?, detail: String?): Unit

    /** Terminal success: firmware versions and the firmware-extension string (empty on stock). */
    fun onResult(leftVersion: String?, rightVersion: String?, extension: String?): Unit

    /** Terminal failure (couldn't connect or read the version). */
    fun onError(message: String?): Unit
}
