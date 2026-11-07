import type { WorkerAppReply } from "../ui/shell/worker-window";

export function playWorkerBuzzerSequence(payload: Uint8Array): void {
  global.postMessage({ type: "buzzer-sequence", payload: Array.from(payload) } satisfies WorkerAppReply);
}
