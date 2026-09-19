declare const com: any;

/**
 * The Java object a worker isolate submits surface frames to: the live BLE
 * communicator, or the preview-only compositor standing in when no glasses
 * are paired (both expose the same submitSurfaceFrame signature). Located
 * through Java statics because those are shared across isolates, unlike any
 * JS-side state.
 *
 * Frame submission only. Buzzer effects use worker-buzzer, which routes to
 * the platform BLE session and skips playback when disconnected.
 */
export function getActiveDisplay(): any {
  return (
    com.faceclaw.app.FaceclawBleCommunicator.getActive() ??
    com.faceclaw.app.FaceclawPreviewCompositor.getActive()
  );
}
