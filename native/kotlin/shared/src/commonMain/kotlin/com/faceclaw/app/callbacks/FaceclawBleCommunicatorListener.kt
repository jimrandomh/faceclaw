package com.faceclaw.app

interface FaceclawBleCommunicatorListener {
    fun onStateChange(phase: String?, status: String?): Unit

    fun onRingEvent(
        kind: String?,
        containerName: String?,
        eventType: Int,
        eventSource: Int,
        systemExitReasonCode: Int,
        frameId: Int,
        ringTick: Long,
        ringType: Int,
        ringAux: Int,
        ringSpeed: Int,
    ): Unit

    fun onBatteryState(
        headsetBattery: Int,
        headsetCharging: Int,
        ringBattery: Int,
        ringCharging: Int,
    ): Unit

    /**
     * A new charging-case reading. caseBattery is 0..100, or -1 when the reading has no level
     * (the glasses are out of the case; keep the last one). caseCharging 1 = the case is on
     * USB, known only while caseDocked (0 otherwise).
     */
    fun onCaseState(caseBattery: Int, caseCharging: Int, caseDocked: Boolean): Unit

    fun onSilentMode(silent: Boolean): Unit

    fun onWearState(wearing: Boolean): Unit

    fun onPhoneLockState(locked: Boolean): Unit

    fun onEvenAppConflict(message: String?): Unit

    fun onFrameMetrics(paintMs: Int, transmitMs: Int, tileCount: Int): Unit

    fun onFrameFinished(frameId: Int, outcome: String?): Unit

    fun onFirmwareInfo(leftVersion: String?, rightVersion: String?, extension: String?): Unit
}
