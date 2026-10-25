/**
 * Missed-bolus detector: given a recent window of CGM readings and
 * treatments, decide whether glucose is rising the way an unannounced meal
 * does, with no meal bolus, manual bolus or carb entry to account for it.
 *
 * Deliberately self-contained (no imports; plain data in, plain data out) so
 * it can move to the server side of Nightscout unchanged, and so it can be
 * iterated on against recorded history with
 * scripts/nightscout-missed-bolus-replay.cjs. The Faceclaw side (when to run
 * it, cooldown, the glasses notification) is in missed-bolus-monitor.ts.
 *
 * Glucose is mg/dL throughout: Nightscout stores sgv in mg/dL whatever the
 * site's display units.
 */

export type GlucoseReading = { timeMs: number; mgdl: number };

/**
 * - meal: a meal/snack/wizard bolus, or any bolus entered together with carbs.
 * - manual: a bolus explicitly marked user-initiated (e.g. Loop's `automatic: false`).
 * - automatic: a bolus the loop issued (SMB, automatic bolus).
 * - ambiguous: not marked either way. OpenAPS on a Medtronic pump uploads its
 *   SMBs as plain "Correction Bolus" records, indistinguishable from a manual
 *   correction except by size; `ambiguousBolusMinUnits` decides.
 */
export type BolusKind = "meal" | "manual" | "automatic" | "ambiguous";
export type BolusEvent = { timeMs: number; units: number; kind: BolusKind };
export type CarbEntry = { timeMs: number; grams: number };

export type MissedBolusInput = {
  /** The time to classify as of. Readings and treatments after it are ignored. */
  nowMs: number;
  glucose: readonly GlucoseReading[];
  boluses: readonly BolusEvent[];
  carbs: readonly CarbEntry[];
};

export type MissedBolusOptions = {
  /** The latest reading must be at most this old, or there is nothing current to judge. */
  maxReadingAgeMs: number;
  /** How far back from the latest reading to look for where the rise started. */
  lookbackMs: number;
  /** A gap between readings longer than this ends the window (the CGM dropped out). */
  maxGapMs: number;
  /** Recent span the rate of rise is fitted over (least squares). */
  slopeWindowMs: number;
  /** Fewest readings the rate fit needs. */
  minSlopeReadings: number;
  /** Rise from the window's lowest reading to the latest. */
  minRiseMgdl: number;
  /** The latest reading must be at least this high. */
  minGlucoseMgdl: number;
  /** Rises from below this are taken as recovering from a low (rescue carbs go unbolused). */
  hypoNadirMgdl: number;
  /** The rise must have lasted at least this long, to rule out sensor noise. */
  minRiseDurationMs: number;
  /** Rate of rise over the slope window, mg/dL per minute. */
  minRateMgdlPerMin: number;
  /** A bolus or carb entry this long before the rise began still accounts for it (pre-bolusing). */
  preBolusWindowMs: number;
  /** Smallest meal or manual bolus that accounts for a rise. */
  minManualBolusUnits: number;
  /** Smallest unmarked bolus taken as manual rather than an SMB. */
  ambiguousBolusMinUnits: number;
  /** Whether a carb entry with no bolus accounts for a rise (the user evidently knows they ate). */
  carbsCountAsAnnouncement: boolean;
};

export const DEFAULT_MISSED_BOLUS_OPTIONS: Readonly<MissedBolusOptions> = {
  maxReadingAgeMs: 12 * 60_000,
  lookbackMs: 90 * 60_000,
  maxGapMs: 16 * 60_000,
  slopeWindowMs: 20 * 60_000,
  minSlopeReadings: 3,
  minRiseMgdl: 40,
  minGlucoseMgdl: 140,
  hypoNadirMgdl: 70,
  minRiseDurationMs: 20 * 60_000,
  minRateMgdlPerMin: 1.5,
  preBolusWindowMs: 60 * 60_000,
  minManualBolusUnits: 0.5,
  ambiguousBolusMinUnits: 1.5,
  carbsCountAsAnnouncement: true,
};

export type GlucoseRise = {
  /** When the rise started: the lowest reading in the window (the latest, if tied). */
  onsetMs: number;
  nadirMgdl: number;
  latestMs: number;
  latestMgdl: number;
  riseMgdl: number;
  /** Least-squares rate over the slope window, mg/dL per minute. */
  rateMgdlPerMin: number;
};

export type MissedBolusClassification = "missed-bolus" | "no-alert" | "insufficient-data";

export type MissedBolusResult = {
  classification: MissedBolusClassification;
  /** One-line explanation, for logs and the replay tool. */
  reason: string;
  /** The rise that was judged, when there was enough data to measure one. */
  rise: GlucoseRise | null;
};

export function detectMissedBolus(
  input: MissedBolusInput,
  overrides: Partial<MissedBolusOptions> = {},
): MissedBolusResult {
  const options: MissedBolusOptions = { ...DEFAULT_MISSED_BOLUS_OPTIONS, ...overrides };
  const { nowMs } = input;
  const readings = usableReadings(input.glucose, nowMs);
  const latest = readings[readings.length - 1];
  if (!latest) return insufficient("no glucose readings");
  if (nowMs - latest.timeMs > options.maxReadingAgeMs) {
    return insufficient(`latest reading is ${formatMinutes(nowMs - latest.timeMs)} old`);
  }

  // The contiguous run of readings ending at the latest, within the lookback.
  const windowStartMs = latest.timeMs - options.lookbackMs;
  let first = readings.length - 1;
  while (first > 0) {
    const previous = readings[first - 1]!;
    if (previous.timeMs < windowStartMs || readings[first]!.timeMs - previous.timeMs > options.maxGapMs) break;
    first--;
  }
  const window = readings.slice(first);
  let nadir = window[0]!;
  for (const reading of window) {
    if (reading.mgdl <= nadir.mgdl) nadir = reading;
  }

  const slopeStartMs = Math.max(nadir.timeMs, latest.timeMs - options.slopeWindowMs);
  const slopeReadings = window.filter((reading) => reading.timeMs >= slopeStartMs);
  const rise: GlucoseRise = {
    onsetMs: nadir.timeMs,
    nadirMgdl: nadir.mgdl,
    latestMs: latest.timeMs,
    latestMgdl: latest.mgdl,
    riseMgdl: latest.mgdl - nadir.mgdl,
    rateMgdlPerMin: slopeReadings.length >= 2 ? slopePerMinute(slopeReadings) : 0,
  };
  const noAlert = (reason: string): MissedBolusResult => ({ classification: "no-alert", reason, rise });

  if (rise.riseMgdl < options.minRiseMgdl) {
    return noAlert(`rise of ${rise.riseMgdl} mg/dL is under ${options.minRiseMgdl}`);
  }
  if (latest.mgdl < options.minGlucoseMgdl) {
    return noAlert(`glucose ${latest.mgdl} mg/dL is under ${options.minGlucoseMgdl}`);
  }
  if (nadir.mgdl < options.hypoNadirMgdl) {
    return noAlert(`rising from a low of ${nadir.mgdl} mg/dL`);
  }
  if (latest.timeMs - nadir.timeMs < options.minRiseDurationMs) {
    return noAlert(`rise has lasted only ${formatMinutes(latest.timeMs - nadir.timeMs)}`);
  }
  if (slopeReadings.length < options.minSlopeReadings) {
    return { classification: "insufficient-data", reason: `only ${slopeReadings.length} readings to fit a rate`, rise };
  }
  if (rise.rateMgdlPerMin < options.minRateMgdlPerMin) {
    return noAlert(`rising ${formatRate(rise.rateMgdlPerMin)}, under ${formatRate(options.minRateMgdlPerMin)}`);
  }

  const coverStartMs = nadir.timeMs - options.preBolusWindowMs;
  const inCoverWindow = (timeMs: number) => timeMs >= coverStartMs && timeMs <= nowMs;
  const bolus = latestMatching(input.boluses, (event) => inCoverWindow(event.timeMs) && accountsForRise(event, options));
  if (bolus) {
    return noAlert(`${formatUnits(bolus.units)} U ${bolus.kind} bolus ${formatMinutes(nowMs - bolus.timeMs)} ago`);
  }
  if (options.carbsCountAsAnnouncement) {
    const carbs = latestMatching(input.carbs, (entry) => inCoverWindow(entry.timeMs) && entry.grams > 0);
    if (carbs) return noAlert(`${carbs.grams} g carbs entered ${formatMinutes(nowMs - carbs.timeMs)} ago`);
  }
  return {
    classification: "missed-bolus",
    reason: `up ${rise.riseMgdl} mg/dL in ${formatMinutes(latest.timeMs - nadir.timeMs)}, rising ${formatRate(rise.rateMgdlPerMin)}, no bolus`,
    rise,
  };
}

function insufficient(reason: string): MissedBolusResult {
  return { classification: "insufficient-data", reason, rise: null };
}

function accountsForRise(bolus: BolusEvent, options: MissedBolusOptions): boolean {
  switch (bolus.kind) {
    case "meal":
    case "manual":
      return bolus.units >= options.minManualBolusUnits;
    case "ambiguous":
      return bolus.units >= Math.max(options.minManualBolusUnits, options.ambiguousBolusMinUnits);
    case "automatic":
      return false;
  }
}

/**
 * Finite, in-range readings at or before now, oldest first, one per
 * timestamp. Dexcom reports 39 for "LOW" and smaller values as error codes.
 */
function usableReadings(glucose: readonly GlucoseReading[], nowMs: number): GlucoseReading[] {
  const sorted = glucose
    .filter((reading) => Number.isFinite(reading.timeMs) && Number.isFinite(reading.mgdl)
      && reading.mgdl >= 39 && reading.mgdl <= 600 && reading.timeMs <= nowMs)
    .slice()
    .sort((a, b) => a.timeMs - b.timeMs);
  return sorted.filter((reading, index) => index === 0 || reading.timeMs !== sorted[index - 1]!.timeMs);
}

/** Least-squares slope through the readings, in mg/dL per minute. */
function slopePerMinute(readings: readonly GlucoseReading[]): number {
  const t0 = readings[0]!.timeMs;
  const n = readings.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (const reading of readings) {
    const x = (reading.timeMs - t0) / 60_000;
    sumX += x;
    sumY += reading.mgdl;
    sumXY += x * reading.mgdl;
    sumXX += x * x;
  }
  const denominator = n * sumXX - sumX * sumX;
  return denominator > 0 ? (n * sumXY - sumX * sumY) / denominator : 0;
}

function latestMatching<T extends { timeMs: number }>(events: readonly T[], predicate: (event: T) => boolean): T | null {
  let found: T | null = null;
  for (const event of events) {
    if (predicate(event) && (!found || event.timeMs > found.timeMs)) found = event;
  }
  return found;
}

function formatMinutes(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}

function formatRate(mgdlPerMin: number): string {
  return `${mgdlPerMin.toFixed(1)} mg/dL/min`;
}

function formatUnits(units: number): string {
  return `${Math.round(units * 100) / 100}`;
}

// ---------------------------------------------------------------------------
// Nightscout record normalization, shared by the Faceclaw bridge and a
// server-side port.

/** The fields of a Nightscout treatment record the detector reads. */
export type NightscoutTreatmentRecord = {
  eventType?: unknown;
  created_at?: unknown;
  timestamp?: unknown;
  insulin?: unknown;
  carbs?: unknown;
  automatic?: unknown;
  isSMB?: unknown;
  type?: unknown;
  wizard?: unknown;
};

/** The fields of a Nightscout entry record the detector reads. */
export type NightscoutEntryRecord = { date?: unknown; sgv?: unknown };

const MEAL_BOLUS_EVENT_TYPES = new Set(["Meal Bolus", "Snack Bolus", "Bolus Wizard", "Combo Bolus"]);

/**
 * How a treatment's insulin was given. Uploaders mark automatic boluses
 * differently: Loop sets `automatic`, AndroidAPS `isSMB`, Trio/OpenAPS
 * `type: "SMB"` or eventType "SMB". Meal boluses carry carbs or a wizard
 * record, or a meal-type eventType.
 */
export function bolusKindFromTreatment(treatment: NightscoutTreatmentRecord): BolusKind {
  const eventType = typeof treatment.eventType === "string" ? treatment.eventType : "";
  if (treatment.automatic === true || treatment.isSMB === true || treatment.type === "SMB" || eventType === "SMB") {
    return "automatic";
  }
  if (MEAL_BOLUS_EVENT_TYPES.has(eventType) || positiveNumber(treatment.carbs) !== null
    || (typeof treatment.wizard === "object" && treatment.wizard !== null)) {
    return "meal";
  }
  if (treatment.automatic === false || treatment.isSMB === false) return "manual";
  return "ambiguous";
}

/** Boluses and carb entries from raw Nightscout treatment records, oldest first. */
export function normalizeNightscoutTreatments(treatments: readonly NightscoutTreatmentRecord[]): {
  boluses: BolusEvent[];
  carbs: CarbEntry[];
} {
  const boluses: BolusEvent[] = [];
  const carbs: CarbEntry[] = [];
  for (const treatment of treatments) {
    const timeMs = treatmentTimeMs(treatment);
    if (timeMs === null) continue;
    const units = positiveNumber(treatment.insulin);
    if (units !== null) boluses.push({ timeMs, units, kind: bolusKindFromTreatment(treatment) });
    const grams = positiveNumber(treatment.carbs);
    if (grams !== null) carbs.push({ timeMs, grams });
  }
  boluses.sort((a, b) => a.timeMs - b.timeMs);
  carbs.sort((a, b) => a.timeMs - b.timeMs);
  return { boluses, carbs };
}

/** Glucose readings from raw Nightscout sgv entries, oldest first. */
export function normalizeNightscoutEntries(entries: readonly NightscoutEntryRecord[]): GlucoseReading[] {
  const readings: GlucoseReading[] = [];
  for (const entry of entries) {
    const timeMs = Number(entry.date);
    const mgdl = Number(entry.sgv);
    if (Number.isFinite(timeMs) && timeMs > 0 && Number.isFinite(mgdl)) readings.push({ timeMs, mgdl });
  }
  return readings.sort((a, b) => a.timeMs - b.timeMs);
}

function treatmentTimeMs(treatment: NightscoutTreatmentRecord): number | null {
  for (const value of [treatment.created_at, treatment.timestamp]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    if (typeof value === "string" && value.trim()) {
      const numeric = Number(value);
      const parsed = Number.isFinite(numeric) ? numeric : Date.parse(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}

function positiveNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}
