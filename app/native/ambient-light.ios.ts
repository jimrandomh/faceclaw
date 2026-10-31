import { FaceclawCommunicatorBridge } from "./faceclaw-communicator.ios";
import {
  decodeAmbientLightReport,
  resolvePollingOptions,
  type AmbientLightPollingOptions,
  type AmbientLightReport,
} from "./ambient-light-types";

export * from "./ambient-light-types";

/**
 * Ambient light sensor access on iOS: the same API as ambient-light.ts (see
 * there for the CFW query and passive-polling semantics) over the running
 * shared-Kotlin session. No-ops while no session is running.
 */

/** Ask the firmware for one ambient-light report (delivered to listeners). */
export function queryAmbientLight(): void {
  try {
    FaceclawCommunicatorBridge.getActive()?.queryAmbientLight();
  } catch (error) {
    console.warn(`queryAmbientLight failed: ${error}`);
  }
}

/** Start or stop CFW passive light-sensor polling. */
export function setAmbientLightPolling(enabled: boolean, options: AmbientLightPollingOptions = {}): void {
  const { intervalMs, minDelta, heartbeatMs, bindToLease } = resolvePollingOptions(options);
  try {
    FaceclawCommunicatorBridge.getActive()?.setAmbientLightPolling(enabled, intervalMs, minDelta, heartbeatMs, bindToLease);
  } catch (error) {
    console.warn(`setAmbientLightPolling failed: ${error}`);
  }
}

/** Subscribe to decoded ambient-light reports. Delivered on the main thread. */
export function addAmbientLightListener(listener: (report: AmbientLightReport) => void): () => void {
  const active = FaceclawCommunicatorBridge.getActive();
  if (!active) return () => {};
  const unsubscribe = active.addAmbientLightListener((body) => {
    const report = decodeAmbientLightReport(body);
    if (report) listener(report);
  });
  return () => {
    try {
      unsubscribe();
    } catch {
      // The session may have been closed during a disconnect.
    }
  };
}
