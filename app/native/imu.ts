declare const com: any;

/**
 * IMU (accelerometer) access. The G2 gates its accelerometer stream behind an
 * ImuCtrl control message; once enabled, the firmware reports x/y/z samples as
 * sys-events, which the Java communicator decodes and forwards here.
 *
 * Note: this stream has historically been unreliable — the firmware may not
 * populate IMU data at all. Treat it as experimental.
 *
 * Talks to the active communicator via the FaceclawBleCommunicator.getActive()
 * static, so it works from any isolate without threading the bridge through.
 */

import { type ImuReading } from "./imu-types";

export * from "./imu-types";

function activeCommunicator(): any {
  if (!global.isAndroid) return null;
  try {
    return com.faceclaw.app.FaceclawBleCommunicator.getActive();
  } catch {
    return null;
  }
}

/** Enable/disable the accelerometer report stream. No-op if not connected. */
export function setImuReportEnabled(enable: boolean, reportFreq: number): void {
  const active = activeCommunicator();
  if (!active) return;
  try {
    active.setImuReportEnabled(enable, Math.max(0, Math.round(reportFreq)));
  } catch (error) {
    console.warn(`setImuReportEnabled failed: ${error}`);
  }
}

/** Subscribe to IMU readings; returns an unsubscribe function. */
export function addImuListener(listener: (reading: ImuReading) => void): () => void {
  const active = activeCommunicator();
  if (!active) return () => {};
  const proxy = new com.faceclaw.app.FaceclawImuListener({
    onImuData: (x: number, y: number, z: number, source: number) => {
      listener({ x: Number(x), y: Number(y), z: Number(z), source: Number(source) });
    },
  });
  active.addImuListener(proxy);
  return () => {
    try {
      activeCommunicator()?.removeImuListener(proxy);
    } catch {
      // The instance may be gone after a disconnect; nothing to clean up.
    }
  };
}
