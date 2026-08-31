package com.faceclaw.app;

/**
 * Callbacks from the Android Wear (Wear OS) bridge; implemented in JS. Every
 * call is delivered on the thread that registered the listener (see
 * FaceclawWearBridge.setListener).
 */
public interface FaceclawWearListener {
    /**
     * A message from the watch app. `path` is the Data Layer message path
     * (e.g. "/faceclaw/input"); `json` is the UTF-8 payload (always a JSON
     * object, "{}" when the watch sent none); `nodeId` identifies the watch
     * so a reply can be addressed to it.
     */
    void onMessage(String path, String json, String nodeId);

    /** The set of reachable watches running the Faceclaw watch app changed. */
    void onWatchConnection(boolean reachable, String watchName);
}
