/**
 * Math for "Set to current head angle", kept free of NativeScript imports so
 * tests/head-tilt-math.test.cjs can run it under plain node.
 *
 * The temple's accelerometer axes are not documented (nor whether the report
 * stream applies the firmware's mount matrix), so nothing here assumes which
 * axis points forward. Instead the capture takes two readings, one with the
 * head level and one tilted up, and the tilt is the angle between the two
 * gravity vectors. That works for any mounting and any angle; what it cannot
 * tell is direction (tilting down by 30° reads the same as up by 30°), so the
 * row's instructions say to tilt up, and head roll between the two readings
 * adds to the result.
 */

export type Vec3 = { x: number; y: number; z: number };

/** The setting's range; the firmware itself accepts 1..90. */
export const MIN_GLANCE_ANGLE = 5;
export const MAX_GLANCE_ANGLE = 60;

/** Mean of the samples, or null when there are none or they sum to zero. */
export function meanVector(samples: readonly Vec3[]): Vec3 | null {
  if (samples.length === 0) return null;
  let x = 0, y = 0, z = 0;
  for (const s of samples) {
    x += s.x;
    y += s.y;
    z += s.z;
  }
  const mean = { x: x / samples.length, y: y / samples.length, z: z / samples.length };
  return Math.hypot(mean.x, mean.y, mean.z) > 1e-6 ? mean : null;
}

/** Angle between two gravity readings, in degrees (0..180). */
export function angleBetweenDegrees(a: Vec3, b: Vec3): number {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  const cross = Math.hypot(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  // atan2 stays accurate near 0° and 180°, where acos of the normalized dot does not.
  return (Math.atan2(cross, dot) * 180) / Math.PI;
}

/** Nearest multiple of 5, kept within the setting's range. */
export function roundGlanceAngle(degrees: number): number {
  const rounded = Math.round(degrees / 5) * 5;
  return Math.min(MAX_GLANCE_ANGLE, Math.max(MIN_GLANCE_ANGLE, rounded));
}

/**
 * The setting value for a measured tilt, or why it cannot be used: a tilt that
 * would round below the minimum is reported (a head that did not move, not a
 * 5° trigger), and so is one past the maximum.
 */
export function glanceAngleForTilt(degrees: number): { ok: true; rounded: number } | { ok: false; reason: string } {
  if (!Number.isFinite(degrees)) return { ok: false, reason: "no reading" };
  if (degrees < MIN_GLANCE_ANGLE - 2.5) return { ok: false, reason: "head not tilted" };
  if (degrees >= MAX_GLANCE_ANGLE + 2.5) return { ok: false, reason: `over ${MAX_GLANCE_ANGLE}°` };
  return { ok: true, rounded: roundGlanceAngle(degrees) };
}
