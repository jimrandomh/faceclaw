/**
 * Magnetic declination from Android's built-in World Magnetic Model. Declination
 * is the angle from magnetic north to true north (east positive), so
 * `true = magnetic + declination`. No network access is involved; the model is
 * baked into the platform and is accurate to well under a degree, which is far
 * inside the magnetometer's own noise.
 */
declare const android: any;
declare const global: any;

/** Declination in degrees at a place and time, or null off-Android. */
export function magneticDeclinationDegrees(
  latitude: number,
  longitude: number,
  timestampMs: number = Date.now(),
  altitudeMeters = 0,
): number | null {
  if (!global.isAndroid) return null;
  try {
    const field = new android.hardware.GeomagneticField(latitude, longitude, altitudeMeters, timestampMs);
    const declination = Number(field.getDeclination());
    return Number.isFinite(declination) ? declination : null;
  } catch (error) {
    console.warn(`GeomagneticField failed: ${error}`);
    return null;
  }
}
