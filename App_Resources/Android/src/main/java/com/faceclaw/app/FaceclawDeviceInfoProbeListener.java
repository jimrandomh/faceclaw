package com.faceclaw.app;

/** Callbacks from FaceclawDeviceInfoProbe to the TypeScript layer. */
public interface FaceclawDeviceInfoProbeListener {
    void onLog(String line);

    /** Lifecycle: connecting/authenticating for each arm, then querying. */
    void onState(String state, String detail);

    /** Terminal success: firmware versions and the firmware-extension string (empty on stock). */
    void onResult(String leftVersion, String rightVersion, String extension);

    /** Terminal failure (couldn't connect or read the version). */
    void onError(String message);
}
