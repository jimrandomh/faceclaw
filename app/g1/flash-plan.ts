/** What installing firmware on a G1 has to decide. No I/O. */
import type { GlassesPairCandidate } from "../g2/pairing-candidates";

export type G1Side = "left" | "right";

/** Left first: a right arm on g1v0 next to a left arm on Even's firmware would leave the left eye dark. */
export const G1_SIDES: readonly G1Side[] = ["left", "right"];

export const G1_CASE_INSTRUCTIONS =
  "Put the glasses in their charging case with the lid open, and plug the case in. Stay nearby, and leave Faceclaw open.";

/** An arm bonds only once it knows it's in the case, and a full case only says so about every 5 minutes. */
export const G1_CASE_DELAY_HINT =
  "A fully charged arm can take up to 5 minutes to notice it's in the case, so this may take a while.";

export const G1_INSTALL_NOTICE =
  "This replaces the firmware on both arms, about two minutes each. Going back to Even's firmware later takes a computer, and " +
  "may not be the version you have now. Installing custom firmware is not covered by warranty.";

/** What the native flow says when it finishes (G1ArmFlashFlow). */
export type G1FlashResult = {
  flashed?: boolean;
  firmware?: "g1v0" | "stock";
  version?: string;
  safeMode?: boolean;
  inCase?: boolean;
  battery?: number | null;
};

export function parseG1FlashResult(detail: string): G1FlashResult {
  try {
    const parsed = JSON.parse(detail);
    return parsed && typeof parsed === "object" ? (parsed as G1FlashResult) : {};
  } catch {
    return {};
  }
}

/** Dotted versions, component by component; a missing component counts as 0. */
export function compareG1Versions(a: string, b: string): number {
  const parts = (version: string) => version.split(".").map((part) => parseInt(part, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export type G1Wanted = { serial?: string | null; left?: string; right?: string };

const serialOf = (serial: string | null | undefined) => (serial ?? "").trim().toUpperCase();

export function sameG1Serial(a: string | null | undefined, b: string | null | undefined): boolean {
  return serialOf(a) !== "" && serialOf(a) === serialOf(b);
}

/**
 * The pair being installed on, among those heard, once both arms have been. Its serial decides, as a flash changes an arm's
 * address; an address it was saved under also tells. Only with neither known does the only G1 around count: firmware
 * must never go to someone else's glasses because the wanted ones weren't heard.
 */
export function pickG1Pair(pairs: readonly GlassesPairCandidate[], wanted: G1Wanted): GlassesPairCandidate | null {
  const g1 = pairs.filter((pair) => pair.g1Firmware);
  const complete = (pair: GlassesPairCandidate | undefined) => (pair?.left && pair.right ? pair : null);
  const bySerial = g1.find((pair) => sameG1Serial(pair.serial, wanted.serial));
  if (bySerial) return complete(bySerial);
  const byAddress = g1.find((pair) =>
    (!!wanted.left && pair.left?.address === wanted.left) || (!!wanted.right && pair.right?.address === wanted.right));
  if (byAddress) return complete(byAddress);
  if (serialOf(wanted.serial) || wanted.left || wanted.right) return null;
  return g1.length === 1 ? complete(g1[0]) : null;
}

/**
 * What a check of the two arms found: "stock", Even's firmware on an arm; "safe-mode", g1v0 restarted repeatedly and only
 * updates work; "older", older than the app ships; "current", nothing to do.
 */
export type G1FirmwareState = "stock" | "safe-mode" | "older" | "current";

export function g1FirmwareState(arms: readonly G1FlashResult[], shipped: string): G1FirmwareState {
  if (arms.some((arm) => arm.firmware === "stock")) return "stock";
  if (arms.some((arm) => arm.safeMode)) return "safe-mode";
  return arms.some((arm) => compareG1Versions(arm.version ?? "", shipped) < 0) ? "older" : "current";
}

/**
 * What the arms' advertising alone says about their firmware, or null when an arm has to be asked: firmware before 0.5.66
 * doesn't advertise its version.
 */
export function g1StateFromAdvertising(
  pair: Pick<GlassesPairCandidate, "left" | "right">,
  shipped: string,
): { state: G1FirmwareState; version: string } | null {
  const arms = [pair.left, pair.right];
  if (arms.some((arm) => arm?.g1Firmware === "stock")) return { state: "stock", version: "" };
  if (arms.some((arm) => arm?.g1Firmware === "g1v0-safe")) return { state: "safe-mode", version: "" };
  const versions = arms.map((arm) => arm?.g1Version);
  if (!versions[0] || !versions[1]) return null;
  const lowest = compareG1Versions(versions[0], versions[1]) <= 0 ? versions[0] : versions[1];
  return { state: compareG1Versions(lowest, shipped) < 0 ? "older" : "current", version: lowest };
}

/** Each arm counts for half of the bar. */
export function g1FlashPercent(side: G1Side, bytesSent: number, bytesTotal: number): number {
  const within = bytesTotal > 0 ? Math.min(1, bytesSent / bytesTotal) : 0;
  return ((side === "right" ? 1 + within : within) / 2) * 100;
}
