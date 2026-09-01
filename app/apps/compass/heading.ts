/**
 * The compass heading model: raw magnetometer reading → wearer-calibrated
 * magnetic heading → true heading, and which of the last two the wearer has
 * asked to see.
 *
 * The wearer-fit offset and declination are kept as separate terms on purpose.
 * The offset changes when the glasses are re-seated but not when the wearer
 * travels; declination is the reverse. One combined hand-tuned number would go
 * quietly wrong after a long trip.
 */
import { getStringSetting, setStringSetting } from "../../native/settings-store";
import { calibrateHeading, normalizeHeading } from "./calibration";
import { getDeclinationDegrees } from "./declination";

const NORTH_REFERENCE_KEY = "compass.northReference";

/** Which north the compass reads relative to. True is the default: it is what maps use. */
export type NorthReference = "true" | "magnetic";

export type ResolvedHeading = {
  /** Raw reading corrected by the wearer-fit offset. */
  magneticDegrees: number;
  /** Local declination (east positive), or null when no location is known. */
  declinationDegrees: number | null;
  /** Magnetic heading plus declination, or null when declination is unknown. */
  trueDegrees: number | null;
  /** The heading to show, in whichever frame `frame` names. */
  displayDegrees: number;
  /** The frame actually shown: true if requested and available, else magnetic. */
  frame: NorthReference;
};

export function getNorthReference(): NorthReference {
  return getStringSetting(NORTH_REFERENCE_KEY, "true") === "magnetic" ? "magnetic" : "true";
}

export function setNorthReference(reference: NorthReference): void {
  setStringSetting(NORTH_REFERENCE_KEY, reference);
}

export function resolveHeading(rawDegrees: number): ResolvedHeading {
  const magneticDegrees = calibrateHeading(rawDegrees);
  const declinationDegrees = getDeclinationDegrees();
  const trueDegrees = declinationDegrees === null ? null : normalizeHeading(magneticDegrees + declinationDegrees);
  const wantTrue = getNorthReference() === "true";
  const frame: NorthReference = wantTrue && trueDegrees !== null ? "true" : "magnetic";
  return {
    magneticDegrees,
    declinationDegrees,
    trueDegrees,
    displayDegrees: frame === "true" ? trueDegrees! : magneticDegrees,
    frame,
  };
}
