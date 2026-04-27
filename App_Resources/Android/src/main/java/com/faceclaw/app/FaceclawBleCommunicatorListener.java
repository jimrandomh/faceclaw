package com.faceclaw.app;

public interface FaceclawBleCommunicatorListener {
    void onLog(String line);
    void onStateChange(String phase, String status);
    void onRingEvent(String kind, String containerName, int eventType, int eventSource, int systemExitReasonCode);
    void onBatteryState(int headsetBattery, int headsetCharging);
    void onEvenAppConflict(String message);
}
