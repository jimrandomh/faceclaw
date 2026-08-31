/**
 * How far away an advertising device probably is, from its signal strength.
 *
 * The calibration table is narrowed to the two products this app pairs.
 *
 * ## The model
 *
 * The log-distance path loss model:
 *
 *     RSSI = txPower - 10 · n · log₁₀(d)   ⇒   d = 10 ^ ((txPower - RSSI) / (10 · n))
 *
 * `txPower` is the expected signal at one metre and `n` the path loss
 * exponent — 2.0 in free space, higher indoors where walls and bodies absorb.
 * The reference power always comes from the per-product calibration table. An
 * advertised BLE "TX Power Level" is deliberately NOT used: that field is the
 * radiated power at the antenna (typically 0…+4 dBm), not an iBeacon-style
 * measured power at one metre, and reading it as the latter inflates every
 * distance by orders of magnitude.
 *
 * ## What this is for, and what it is not
 *
 * It exists so a pairing list can be ordered by "which of these is in my
 * hand", and so a row can say roughly how far away its device is. That is a
 * ranking problem, and RSSI ordering is far more trustworthy than RSSI
 * magnitude — the ordering survives calibration error that would put the
 * absolute numbers metres out.
 *
 * It is **not** a measurement. A hand over the temple, a pocket, or a body
 * between phone and glasses moves the estimate by metres. The wearer therefore
 * only ever sees a coarse zone (glyph + label), never a number in metres they
 * might over-trust; the metres value exists purely to rank and bucket.
 *
 * This module is pure (no NativeScript imports) so it can run under node tests.
 */

import { clamp } from "../util/numeric-util";

/** Expected RSSI at one metre, and the path loss exponent, per product. */
export type ProximityCalibration = {
  readonly txPowerAtOneMeter: number;
  readonly pathLossExponent: number;
};

/**
 * Even Realities G2. Two temple radios on a head, usually held or worn
 * indoors, so the exponent sits above free space. Verified only as a ranking
 * input — see the module note.
 */
export const GLASSES_CALIBRATION: ProximityCalibration = { txPowerAtOneMeter: -62, pathLossExponent: 2.2 };

/**
 * Even Realities R1. A ring antenna is smaller and more easily shadowed by a
 * hand, so it reads weaker at the same distance than the glasses do.
 */
export const RING_CALIBRATION: ProximityCalibration = { txPowerAtOneMeter: -68, pathLossExponent: 2.3 };

/**
 * Estimates below this are indistinguishable from "touching the phone", and
 * above it from "somewhere else entirely". Clamping keeps a noisy sample from
 * rendering as 0.001 m.
 */
export const MINIMUM_METERS = 0.1;
export const MAXIMUM_METERS = 100;

/**
 * Coarse buckets. The wearer is being asked "is this the pair in your hand?",
 * and a bucket answers that better than a number they might over-trust.
 */
export type ProximityZone = "immediate" | "near" | "far" | "distant";

export function zoneFromMeters(meters: number): ProximityZone {
  if (meters < 0.5) return "immediate";
  if (meters < 3) return "near";
  if (meters < 10) return "far";
  return "distant";
}

export function zoneLabel(zone: ProximityZone): string {
  switch (zone) {
    case "immediate":
      return "In your hand";
    case "near":
      return "Nearby";
    case "far":
      return "Across the room";
    case "distant":
      return "Far away";
  }
}

/** A glyph for the zone; SF Symbols have no Android equivalent, so plain text. */
export function zoneGlyph(zone: ProximityZone): string {
  switch (zone) {
    case "immediate":
      return "●●●●";
    case "near":
      return "●●●○";
    case "far":
      return "●●○○";
    case "distant":
      return "●○○○";
  }
}

/** A distance estimate and how much to trust it. */
export type ProximityEstimate = {
  readonly meters: number;
  /** 0…1. Drops with weak signal. */
  readonly confidence: number;
  readonly zone: ProximityZone;
};

/**
 * Estimate distance from a signal sample. Null when there is no RSSI to work
 * from, so callers can say "signal unknown" rather than render a fabricated
 * distance. 127 is the Bluetooth "RSSI unavailable" sentinel.
 */
export function estimateProximity(rssi: number | null | undefined, calibration: ProximityCalibration): ProximityEstimate | null {
  if (rssi == null || !Number.isFinite(rssi) || rssi === 127) return null;
  const ratio = (calibration.txPowerAtOneMeter - rssi) / (10 * calibration.pathLossExponent);
  const meters = clamp(Math.pow(10, ratio), MINIMUM_METERS, MAXIMUM_METERS);
  return {
    meters,
    confidence: proximityConfidence(rssi),
    zone: zoneFromMeters(meters),
  };
}

/**
 * Confidence falls with signal strength, because a weak sample is a noisy one.
 * The 0.85 ceiling reflects that the TX power is always an assumption from the
 * calibration table, never a measurement.
 */
export function proximityConfidence(rssi: number): number {
  let confidence = 0.85;
  if (rssi < -85) confidence *= 0.4;
  else if (rssi < -75) confidence *= 0.7;
  else if (rssi < -65) confidence *= 0.85;
  return confidence;
}

/**
 * Order a list closest-first.
 *
 * Items whose signal never arrived sort last rather than being dropped: a pair
 * that cannot be ranked is still a pair the wearer may need to choose, and
 * hiding it would be worse than showing it at the bottom. Ties break on the
 * stable id so the list does not reshuffle between scan passes — a list that
 * reorders under the finger is how the wrong device gets tapped, which is the
 * whole failure this ordering exists to prevent.
 */
export function sortedByProximity<T>(
  items: readonly T[],
  estimate: (item: T) => ProximityEstimate | null,
  id: (item: T) => string,
): T[] {
  return items.slice().sort((lhs, rhs) => {
    const left = estimate(lhs);
    const right = estimate(rhs);
    if (left && right) {
      if (left.meters !== right.meters) return left.meters < right.meters ? -1 : 1;
      return compareIds(id(lhs), id(rhs));
    }
    if (left && !right) return -1;
    if (!left && right) return 1;
    return compareIds(id(lhs), id(rhs));
  });
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
