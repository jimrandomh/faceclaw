/**
 * Wearer calibration for the glasses compass.
 *
 * The magnetometer lives in the right arm, which curls around the wearer's
 * head, so its zero depends on head shape and how the glasses sit — no
 * firmware-side calibration can account for that. We store one persisted
 * offset in degrees, added to every raw heading before it is shown.
 *
 * The "calibrated" flag is separate from a nonzero offset: an offset of 0 can
 * be a perfectly good calibration result, and we only want to nag first-time
 * users.
 */
import { getBooleanSetting, getStringSetting, setBooleanSetting, setStringSetting } from "../../native/settings-store";

const OFFSET_KEY = "compass.calibrationOffsetDegrees";
const CALIBRATED_KEY = "compass.calibrated";

/** Wrap any angle into [0, 360). */
export function normalizeHeading(value: number): number {
  return ((value % 360) + 360) % 360;
}

/** Persisted calibration offset, wrapped into (-180, 180]. */
export function getCompassOffset(): number {
  const parsed = parseInt(getStringSetting(OFFSET_KEY, "0"), 10);
  return Number.isFinite(parsed) ? signedDegrees(parsed) : 0;
}

export function setCompassOffset(degrees: number): number {
  const normalized = signedDegrees(Math.round(degrees));
  setStringSetting(OFFSET_KEY, String(normalized));
  return normalized;
}

export function isCompassCalibrated(): boolean {
  return getBooleanSetting(CALIBRATED_KEY, false);
}

/** Called once the wearer has been through the calibration screen. */
export function markCompassCalibrated(): void {
  if (!isCompassCalibrated()) setBooleanSetting(CALIBRATED_KEY, true);
}

/** Raw magnetometer heading corrected by the persisted offset. */
export function calibrateHeading(rawDegrees: number): number {
  return normalizeHeading(rawDegrees + getCompassOffset());
}

/** Format a signed offset for display, e.g. "+4°", "0°", "-12°". */
export function formatOffset(degrees: number): string {
  return `${degrees > 0 ? "+" : ""}${degrees}°`;
}

/** Wrap into (-180, 180] so the offset reads as a small correction either way. */
function signedDegrees(value: number): number {
  const wrapped = normalizeHeading(value);
  return wrapped > 180 ? wrapped - 360 : wrapped;
}
