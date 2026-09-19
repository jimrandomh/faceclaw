import type { WorkerAppReply } from "../ui/shell/worker-window";

declare const com: any;

/** Workers use the main-thread BLE session on iOS and the native queue on Android. */
export function playWorkerBuzzerSequence(payload: Uint8Array): void {
  if (global.isIOS) {
    global.postMessage({ type: "buzzer-sequence", payload: Array.from(payload) } satisfies WorkerAppReply);
  } else {
    com.faceclaw.app.FaceclawBleCommunicator.getActive()?.playBuzzerSequence(new Uint8Array(payload).buffer);
  }
}
