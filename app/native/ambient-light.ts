/**
 * Ambient light sensor access through the custom firmware (CFW image-handler
 * mode 16; see g2flash/patches/als_sensor.c).
 *
 * The stock firmware only reads its OPT3001 light sensor while auto-brightness
 * is on, and then steps the panel brightness itself (visible flicker). The CFW
 * adds two things:
 *
 *   - QUERY: one report from the driver's current state.
 *   - PASSIVE polling: the firmware opens and polls the sensor at our interval,
 *     the stock adjuster never touches the panel, and a report arrives when the
 *     reading moved by at least `minDelta` or `heartbeatMs` elapsed. The phone
 *     then applies brightness itself (setBrightness with autoAdjust=false), e.g.
 *     only while the display is blank or during a UI transition.
 *
 * Reports are 24-byte ['A','L',version,...] records on settings field 105.
 */
import { toUint8Array } from "../util/array-util";
import {
  decodeAmbientLightReport,
  resolvePollingOptions,
  type AmbientLightPollingOptions,
  type AmbientLightReport,
} from "./ambient-light-types";

declare const com: any;
declare const global: any;

export * from "./ambient-light-types";

function activeCommunicator(): any {
  if (!global.isAndroid) return null;
  try {
    return com.faceclaw.app.FaceclawBleCommunicator.getActive();
  } catch {
    return null;
  }
}

/** Ask the firmware for one ambient-light report (delivered to listeners). */
export function queryAmbientLight(): void {
  try {
    activeCommunicator()?.queryAmbientLight();
  } catch (error) {
    console.warn(`queryAmbientLight failed: ${error}`);
  }
}

/**
 * Start or stop CFW passive light-sensor polling. Starting is idempotent and
 * re-opens the sensor if the stock firmware closed it, so it is safe to resend
 * on every session start.
 */
export function setAmbientLightPolling(enabled: boolean, options: AmbientLightPollingOptions = {}): void {
  const { intervalMs, minDelta, heartbeatMs, bindToLease } = resolvePollingOptions(options);
  try {
    activeCommunicator()?.setAmbientLightPolling(enabled, intervalMs, minDelta, heartbeatMs, bindToLease);
  } catch (error) {
    console.warn(`setAmbientLightPolling failed: ${error}`);
  }
}

/** Subscribe to decoded ambient-light reports. Delivered on the main thread. */
export function addAmbientLightListener(listener: (report: AmbientLightReport) => void): () => void {
  const active = activeCommunicator();
  if (!active) return () => {};
  const proxy = new com.faceclaw.app.FaceclawAmbientLightListener({
    onAmbientLight: (body: any) => {
      const report = decodeAmbientLightReport(toUint8Array(body));
      if (report) listener(report);
    },
  });
  active.addAmbientLightListener(proxy);
  return () => {
    try {
      activeCommunicator()?.removeAmbientLightListener(proxy);
    } catch {
      // The communicator may have been replaced during a disconnect.
    }
  };
}
