/** Platform-neutral IMU types, shared by imu.ts and imu.ios.ts. */

/**
 * An accelerometer sample in g, in Faceclaw's frame for every glasses model
 * (the G2's own; the session rotates other models' samples into it, see
 * ImuOrientation.kt): +x forward, +y to the wearer's left, +z up through the
 * top of the head. At rest it is the "up" direction: head level reads
 * (0, 0, 1), looking 45° up (0.71, 0, 0.71), the head tilted 45° to the right
 * (0, 0.71, 0.71).
 */
export type ImuReading = { x: number; y: number; z: number; source: number };

/**
 * How far the head is tilted up from level, in degrees (negative: down), from
 * a reading taken at rest. Rolling the head to the side does not change it.
 */
export function imuPitchDegrees(reading: { x: number; y: number; z: number }): number {
  return (Math.atan2(reading.x, Math.hypot(reading.y, reading.z)) * 180) / Math.PI;
}

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
