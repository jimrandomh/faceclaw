import { JavaDirectBuffer } from "./java-direct-buffer";

declare const com: any;

// Reused Java-side buffers for this isolate's frames: passing a JS ArrayBuffer
// to Java leaks it (java-direct-buffer.ts). Module state is per isolate, so
// each worker gets its own pair.
const framePixelsBuffer = new JavaDirectBuffer(640 * 480);
const frameDrawsBuffer = new JavaDirectBuffer();

/**
 * The display a worker isolate submits surface frames to: the live BLE
 * communicator, or the preview-only compositor standing in when no glasses
 * are paired (both expose the same submitSurfaceFrame signature). Located
 * through Java statics because those are shared across isolates, unlike any
 * JS-side state. Null when neither exists.
 *
 * Frame submission only. Buzzer effects use worker-buzzer, which routes to
 * the platform BLE session and skips playback when disconnected.
 */
export function getActiveDisplay(): typeof display | null {
  return activeJavaDisplay() ? display : null;
}

function activeJavaDisplay(): any {
  return (
    com.faceclaw.app.FaceclawBleCommunicator.getActive() ??
    com.faceclaw.app.FaceclawPreviewCompositor.getActive()
  );
}

/**
 * Takes the same ArrayBuffer arguments as the iOS active display and copies
 * them into the reused Java buffers right before the synchronous Java call.
 */
const display = {
  submitSurfaceFrame(buffer: ArrayBuffer, surfaceId: string, x: number, y: number, width: number, height: number,
    fingerprint: string, paintMs: number, frameId: number, draws: ArrayBuffer | null = null): void {
    const target = activeJavaDisplay();
    if (!target) return;
    target.submitSurfaceFrame(
      framePixelsBuffer.load(new Uint8Array(buffer)),
      surfaceId,
      x,
      y,
      width,
      height,
      fingerprint,
      paintMs,
      frameId,
      frameDrawsBuffer.loadOptional(draws),
    );
  },
};
