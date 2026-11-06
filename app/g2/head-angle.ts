import { addImuListener, setImuReportEnabled, type ImuReading } from "../native/imu";
import { getHeadUpStatus, setHeadUpTrigger, type HeadUpStatus } from "../native/glasses-controls";
import { getStringSetting, setStringSetting } from "../native/settings-store";
import { glanceAngleSetting, glanceAngleTriggerDegrees, type GlanceAngle } from "../apps/glanceboard/glanceboard-settings";
import { angleBetweenDegrees, glanceAngleForTilt, meanVector, type Vec3 } from "./head-tilt-math";

// Same ImuReportPace code the accelerometer demo uses (not literal Hz).
const IMU_REPORT_PACE = 200;
/** How long to average once samples start arriving. */
const SAMPLE_WINDOW_MS = 1_200;
/** Give up when the glasses send nothing for this long. */
const FIRST_SAMPLE_TIMEOUT_MS = 3_000;
const MIN_SAMPLES = 3;
/** The level reading is used for a tilt reading taken within this long. */
const LEVEL_READING_VALID_MS = 60_000;

/**
 * Average the glasses' accelerometer (gravity) over about a second, with the
 * report stream on only for that long.
 */
async function measureGravity(): Promise<{ ok: true; gravity: Vec3 } | { ok: false; reason: string }> {
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
  const gravity = meanVector(samples);
  return gravity ? { ok: true, gravity } : { ok: false, reason: "sensor reads zero" };
}

let levelReading: { gravity: Vec3; atMs: number } | null = null;
let measuring = false;

/** Which reading the next capture takes: the level one, or the tilted one after it. */
export function headAngleCaptureStep(): "level" | "tilt" {
  return levelReading && Date.now() - levelReading.atMs < LEVEL_READING_VALID_MS ? "tilt" : "level";
}

export function headAngleCaptureRunning(): boolean {
  return measuring;
}

/**
 * One step of "Set to current head angle". The first call reads the head
 * level; the next (within a minute) reads it tilted up, stores the angle
 * between the two, rounded to 5°, as the Head tilt angle, and the
 * controller's settings listener sends it to the glasses. Returns a short
 * status for the menu row, or null when a capture is already running.
 */
export async function captureHeadAngleStep(): Promise<string | null> {
  if (measuring) return null;
  measuring = true;
  try {
    const step = headAngleCaptureStep();
    const result = await measureGravity();
    if (result.ok === false) return `Failed: ${result.reason}`;
    if (step === "level") {
      levelReading = { gravity: result.gravity, atMs: Date.now() };
      return "Now tilt up, select";
    }
    const level = levelReading!.gravity;
    levelReading = null;
    const angle = glanceAngleForTilt(angleBetweenDegrees(level, result.gravity));
    if (angle.ok === false) return `Failed: ${angle.reason}`;
    glanceAngleSetting.set(String(angle.rounded) as GlanceAngle);
    return getHeadUpStatus() ? `Set to ${angle.rounded}°` : `Saved ${angle.rounded}° (offline)`;
  } finally {
    measuring = false;
  }
}

/** Forget a level reading (the settings menu was reopened). */
export function resetHeadAngleCapture(): void {
  if (!measuring) levelReading = null;
}

// The glasses' own head-up switch and angle from before Faceclaw first changed
// them, as "switch,angle", or "" when none is held. Kept here (not only in the
// session) so "Glasses default" can still restore them after an app restart.
const ORIGINAL_KEY = "glanceboard.headTiltOriginal";

function savedOriginal(): { switch: number; angle: number } | null {
  const [sw, angle] = getStringSetting(ORIGINAL_KEY, "").split(",").map(Number);
  return (sw === 0 || sw === 1) && Number.isInteger(angle) ? { switch: sw, angle } : null;
}

/**
 * Push the wanted trigger to the session (on change and on each connect):
 * the Head tilt angle while the Glanceboard is enabled, else none, which
 * writes back the glasses' own values if Faceclaw changed them.
 */
export function applyGlanceAngle(): boolean {
  const sent = setHeadUpTrigger(glanceAngleTriggerDegrees(), savedOriginal());
  syncGlanceAngleOriginal();
  return sent;
}

/**
 * Keep the persisted original in step with the session: save the values the
 * session captured before its first write, and drop them once a read shows
 * them restored. Called on apply, from the controller's periodic refresh, and
 * when the settings row draws.
 */
export function syncGlanceAngleOriginal(status: HeadUpStatus | null = getHeadUpStatus()): void {
  if (!status) return;
  const saved = savedOriginal();
  if (!saved) {
    if (status.originalSwitch === 0 || status.originalSwitch === 1) {
      setStringSetting(ORIGINAL_KEY, `${status.originalSwitch},${status.originalAngle}`);
    }
    return;
  }
  if (
    glanceAngleTriggerDegrees() === 0 &&
    status.desired < 0 &&
    !status.restorePending &&
    status.switch === saved.switch &&
    status.angle === saved.angle
  ) {
    setStringSetting(ORIGINAL_KEY, "");
  }
}

/** The glasses' current head-up trigger (angle + calibration), 0 when off, or null when not read yet. */
export function glassesHeadUpTrigger(status: HeadUpStatus | null = getHeadUpStatus()): number | null {
  if (!status || status.switch < 0) return null;
  return status.switch === 1 ? status.angle + status.calibration : 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
