import { disposeSettingsStore } from "../../native/settings-store";

/** Called on the worker after its windows and app-owned resources are closed. */
export function finishWorkerShutdown(): void {
  disposeSettingsStore();
  global.postMessage({ type: "worker-stopped" });
}
