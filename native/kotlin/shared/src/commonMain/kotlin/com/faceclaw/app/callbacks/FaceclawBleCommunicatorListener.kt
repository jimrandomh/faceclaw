package com.faceclaw.app

interface FaceclawBleCommunicatorListener {
    fun onLog(line: String?): Unit

    fun onStateChange(phase: String?, status: String?): Unit

    fun onRingEvent(
        kind: String?,
        containerName: String?,
        eventType: Int,
        eventSource: Int,
        systemExitReasonCode: Int,
        frameId: Int,
    ): Unit

    fun onBatteryState(
        headsetBattery: Int,
        headsetCharging: Int,
        ringBattery: Int,
        ringCharging: Int,
    ): Unit

    fun onSilentMode(silent: Boolean): Unit

    fun onWearState(wearing: Boolean): Unit

    fun onPhoneLockState(locked: Boolean): Unit

    fun onEvenAppConflict(message: String?): Unit

    fun onFrameMetrics(paintMs: Int, transmitMs: Int, tileCount: Int): Unit

    fun onFrameFinished(frameId: Int, outcome: String?): Unit

    fun onFirmwareInfo(leftVersion: String?, rightVersion: String?, extension: String?): Unit
}
