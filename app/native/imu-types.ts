/** Platform-neutral IMU types, shared by imu.ts and imu.ios.ts. */

export type ImuReading = { x: number; y: number; z: number; source: number };

/** Map an IMU sample's EventSource to a short label. */
export function imuSourceLabel(source: number): string {
  switch (source) {
    case 1:
      return "R arm";
    case 2:
      return "ring";
    case 3:
      return "L arm";
    default:
      return "device";
  }
}
