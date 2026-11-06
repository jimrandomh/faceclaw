import { addImuListener, setImuReportEnabled, type ImuReading } from "../native/imu";
import { getHeadUpStatus, setHeadUpTrigger, type HeadUpStatus } from "../native/glasses-controls";
import { glanceAngleDegrees, glanceAngleSetting, type GlanceAngle } from "../apps/glanceboard/glanceboard-settings";

// Same ImuReportPace code the accelerometer demo uses (not literal Hz).
const IMU_REPORT_PACE = 200;
/** How long to average once samples start arriving. */
const SAMPLE_WINDOW_MS = 1_200;
/** Give up when the glasses send nothing for this long. */
const FIRST_SAMPLE_TIMEOUT_MS = 3_000;
const MIN_SAMPLES = 3;
/** The setting's range; the firmware itself accepts 1..90. */
export const MIN_GLANCE_ANGLE = 5;
export const MAX_GLANCE_ANGLE = 60;

/** degrees/rounded are set on success; reason on failure. */
export type HeadAngleResult = { ok: boolean; degrees?: number; rounded?: number; reason?: string };

/**
 * Measure how far the head is tilted up right now, from the glasses'
 * accelerometer stream (the same IMU whose pitch the firmware compares with
 * its head-up threshold).
 *
 * The temple's sensor axes are not documented, so this does not assume which
 * axis points forward. When worn, gravity lies mostly along the sensor's
 * vertical axis, and tilting the head up turns it toward the forward axis; the
 * angle between gravity and the dominant axis is therefore the tilt, whichever
 * axis that is and whichever sign it has. Head roll adds to it, so the wearer
 * should keep the head level side to side. Past 45° the dominant axis swaps,
 * which is why the setting stops at 60° and readings are clamped there.
 */
export async function measureHeadTilt(): Promise<HeadAngleResult> {
  const samples: ImuReading[] = [];
  let firstAt = 0;
  const unsubscribe = addImuListener((reading) => {
    // Glasses temples only (1 right, 3 left, 0 unspecified); the ring is 2.
    if (reading.source === 2) return;
    if (!Number.isFinite(reading.x) || !Number.isFinite(reading.y) || !Number.isFinite(reading.z)) return;
    if (firstAt === 0) firstAt = Date.now();
    samples.push(reading);
  });
  setImuReportEnabled(true, IMU_REPORT_PACE);
  try {
    const start = Date.now();
    while (true) {
      await delay(100);
      const now = Date.now();
      if (firstAt === 0 && now - start >= FIRST_SAMPLE_TIMEOUT_MS) break;
      if (firstAt !== 0 && now - firstAt >= SAMPLE_WINDOW_MS) break;
    }
  } finally {
    setImuReportEnabled(false, IMU_REPORT_PACE);
    unsubscribe();
  }
  if (samples.length < MIN_SAMPLES) {
    return { ok: false, reason: samples.length === 0 ? "no sensor data" : "too few samples" };
  }
  let x = 0, y = 0, z = 0;
  for (const s of samples) {
    x += s.x;
    y += s.y;
    z += s.z;
  }
  x /= samples.length;
  y /= samples.length;
  z /= samples.length;
  const magnitude = Math.hypot(x, y, z);
  if (!(magnitude > 1e-6)) return { ok: false, reason: "sensor reads zero" };
  const dominant = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  const degrees = (Math.acos(Math.min(1, dominant / magnitude)) * 180) / Math.PI;
  return { ok: true, degrees, rounded: roundGlanceAngle(degrees) };
}

/** Nearest multiple of 5, kept within the setting's range. */
export function roundGlanceAngle(degrees: number): number {
  const rounded = Math.round(degrees / 5) * 5;
  return Math.min(MAX_GLANCE_ANGLE, Math.max(MIN_GLANCE_ANGLE, rounded));
}

/**
 * Measure, store the rounded angle in the Head tilt angle setting, and send
 * it to the glasses. Returns a short status for the menu row.
 */
export async function setGlanceAngleFromHead(): Promise<string> {
  const result = await measureHeadTilt();
  if (!result.ok) return `Failed: ${result.reason}`;
  glanceAngleSetting.set(String(result.rounded) as GlanceAngle);
  const sent = applyGlanceAngle();
  return sent ? `Set to ${result.rounded}°` : `Saved ${result.rounded}° (glasses offline)`;
}

/** Push the Head tilt angle setting to the session (on change and on each connect). */
export function applyGlanceAngle(): boolean {
  return setHeadUpTrigger(glanceAngleDegrees());
}

/** The glasses' current head-up trigger (angle + calibration), or null when not read yet. */
export function glassesHeadUpTrigger(status: HeadUpStatus | null = getHeadUpStatus()): number | null {
  if (!status || status.switch < 0) return null;
  return status.switch === 1 ? status.angle + status.calibration : 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
