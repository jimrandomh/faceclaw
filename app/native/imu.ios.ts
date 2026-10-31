import { FaceclawCommunicatorBridge } from "./faceclaw-communicator.ios";
import { type ImuReading } from "./imu-types";

export * from "./imu-types";

/**
 * IMU (accelerometer) access on iOS: the same API as imu.ts over the running
 * shared-Kotlin session. As there, the stream is experimental, the calls are
 * no-ops while no session is running, and a listener stays with the session
 * it subscribed to.
 */

/** Enable/disable the accelerometer report stream. No-op if not connected. */
export function setImuReportEnabled(enable: boolean, reportFreq: number): void {
  try {
    FaceclawCommunicatorBridge.getActive()?.setImuReportEnabled(enable, reportFreq);
  } catch (error) {
    console.warn(`setImuReportEnabled failed: ${error}`);
  }
}

/** Subscribe to IMU readings; returns an unsubscribe function. */
export function addImuListener(listener: (reading: ImuReading) => void): () => void {
  const active = FaceclawCommunicatorBridge.getActive();
  if (!active) return () => {};
  const unsubscribe = active.addImuListener(listener);
  return () => {
    try {
      unsubscribe();
    } catch {
      // The session may be gone after a disconnect; nothing to clean up.
    }
  };
}
