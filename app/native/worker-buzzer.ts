import type { WorkerAppReply } from "../ui/shell/worker-window";
import { JavaDirectBuffer } from "./java-direct-buffer";

declare const com: any;

// Reused Java-side buffer for this isolate's tone payloads: passing a JS
// ArrayBuffer to Java leaks it (java-direct-buffer.ts).
const buzzerBuffer = new JavaDirectBuffer();

/** Workers use the main-thread BLE session on iOS and the native queue on Android. */
export function playWorkerBuzzerSequence(payload: Uint8Array): void {
  if (global.isIOS) {
    global.postMessage({ type: "buzzer-sequence", payload: Array.from(payload) } satisfies WorkerAppReply);
  } else {
    com.faceclaw.app.FaceclawBleCommunicator.getActive()?.playBuzzerSequence(buzzerBuffer.load(payload));
  }
}
