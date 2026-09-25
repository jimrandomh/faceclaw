export const DEFAULT_BRIGHTNESS_CURVE = "0:0,0.2:7,1.5:33,5:100";
const PREVIOUS_DEFAULT_CURVE = "0:0,1:10,10:30,100:65,1000:100";

/** Percent of the configured range; defaults (20–100) give 20/26/46/100. */
export function brightnessCurveError(value: string): string | null {
  const pairs = value.split(",").map(part => part.trim().split(":"));
  if (pairs.length < 2 || pairs.length > 16 || pairs.some(p => p.length !== 2 || p.some(s => !s.trim())))
    return "Use 2–16 lux:percent pairs separated by commas.";
  const points = pairs.map(pair => pair.map(Number));
  if (points.some(([lux, percent]) => !Number.isFinite(lux) || !Number.isFinite(percent)
    || lux < 0 || lux > 1_000_000 || percent < 0 || percent > 100))
    return "Lux must be 0–1000000 and percent must be 0–100.";
  if (points[0][0] !== 0 || points[0][1] !== 0 || points[points.length - 1][1] !== 100)
    return "Start at 0:0 and end at 100%. Set dark-room brightness with Auto minimum.";
  if (points.some(([lux, percent], i) => i > 0 && (lux <= points[i-1][0] || percent < points[i-1][1])))
    return "Lux must increase and brightness must not decrease.";
  return null;
}

/** Keep incomplete drafts intact. Validation must never replace typed input. */
export function normalizeBrightnessCurve(value: string | null | undefined): string {
  if (value == null) return DEFAULT_BRIGHTNESS_CURVE;
  if (brightnessCurveError(value)) return value;
  const canonical = value.split(",").map(pair => pair.split(":").map(Number).join(":")).join(",");
  return canonical === PREVIOUS_DEFAULT_CURVE ? DEFAULT_BRIGHTNESS_CURVE : canonical;
}
