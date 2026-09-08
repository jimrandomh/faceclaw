export type NightscoutAlertValues = {
  cageTimestampMs: number | null;
  reservoirUnits: number | null;
  batteryVoltage: number | null;
  loopTimestampMs: number | null;
};

export type NightscoutThresholds = {
  maxCannulaAgeHours: number;
  cartridgeLowUnits: number;
  batteryLowVoltage: number;
  maxLoopAgeMinutes: number;
};

/** Zero disables a threshold. Missing measurements do not imply a breach. */
export function evaluateNightscoutAlerts(values: NightscoutAlertValues, limits: NightscoutThresholds, nowMs: number) {
  const known = (value: number | null): value is number => value !== null && Number.isFinite(value) && value >= 0;
  const enabled = (value: number): boolean => Number.isFinite(value) && value > 0;
  const tooOld = (timestamp: number | null, limit: number, unitMs: number): boolean =>
    enabled(limit) && known(timestamp) && timestamp > 0 && nowMs - timestamp > limit * unitMs;
  const tooLow = (value: number | null, limit: number): boolean => enabled(limit) && known(value) && value < limit;
  const cannula = tooOld(values.cageTimestampMs, limits.maxCannulaAgeHours, 3_600_000);
  const cartridge = tooLow(values.reservoirUnits, limits.cartridgeLowUnits);
  const battery = tooLow(values.batteryVoltage, limits.batteryLowVoltage);
  const loop = tooOld(values.loopTimestampMs, limits.maxLoopAgeMinutes, 60_000);
  return { cannula, cartridge, battery, loop, any: cannula || cartridge || battery || loop };
}

export function normalizeNightscoutThreshold(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  const number = Number(text);
  return /^(\d+(\.\d*)?|\.\d+)$/.test(text) && Number.isFinite(number) && number >= 0 ? String(number) : "0";
}
