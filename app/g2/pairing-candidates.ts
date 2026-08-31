/**
 * Turns a stream of Even advertisements into the things a pairing list shows:
 * G2 pairs (a left and a right temple that advertise the same serial) and R1
 * rings, each ranked by how close it probably is.
 *
 * Ranks by nearest-device margin, previously-paired match, and closest-first
 * ordering, with the left↔right pair grouping that Faceclaw needs because
 * it connects to each arm by address rather than through a vendor SDK.
 *
 * This module is pure (no NativeScript imports) so it can run under node tests.
 */

import {
  estimateProximity,
  GLASSES_CALIBRATION,
  RING_CALIBRATION,
  sortedByProximity,
  zoneGlyph,
  zoneLabel,
  type ProximityEstimate,
  type ProximityZone,
} from "./ble-proximity";
import { classifyAdvertisement, normalizeMacAddress, type EvenAdvertisement, type RawAdvertisement } from "./even-advertisement";
import { glassesImagePath, R1_IMAGE_PATH } from "./glasses-artwork";
import {
  colorwayDisplayName,
  colorwaySwatchHex,
  evaluatePairSerials,
  GlassesHardwareIdentity,
  pairSerialWarning,
  serialKey,
  serialsMatch,
  type GlassesColorway,
} from "./glasses-hardware-identity";

export type PairCompleteness = "complete" | "left-only" | "right-only";

/** A G2 pair as seen over the air: up to one advertisement per side, joined on serial. */
export type GlassesPairCandidate = {
  /** Stable id: the serial when known, otherwise the lone arm's address. */
  id: string;
  serial: string | null;
  identity: GlassesHardwareIdentity | null;
  left: EvenAdvertisement | null;
  right: EvenAdvertisement | null;
  completeness: PairCompleteness;
  /** Strongest smoothed signal across the arms that have one. */
  rssi: number | null;
  proximity: ProximityEstimate | null;
  lastSeenMs: number;
  /**
   * Set when this lone arm and a lone arm of the other side carry different
   * serials — the mixed-pair situation the serial check exists to name.
   * Grouping is by serial, so the mismatch can only show up across groups.
   */
  mismatchWarning: string | null;
};

export type RingCandidate = {
  id: string;
  advertisement: EvenAdvertisement;
  rssi: number | null;
  proximity: ProximityEstimate | null;
  lastSeenMs: number;
};

/**
 * Android delivers a callback per advertisement (several per second per arm),
 * far more often than CoreBluetooth's coalesced reports, so the raw RSSI
 * jitters visibly. A light exponential average keeps the list calm without
 * hiding a real move. Ordering still uses the smoothed value; the margin for
 * the "Closest" badge is applied on top.
 */
const RSSI_SMOOTHING = 0.35;

/**
 * The device whose signal is strong enough to call "the one you are holding"
 * needs a clear margin over the runner-up: RSSI wanders by a few dB between
 * advertisements, so a badge awarded on a 1 dB lead would hop between rows
 * every scan pass and mean nothing.
 */
export const NEAREST_SIGNAL_MARGIN_DBM = 8;

/** Advertisements older than this are dropped — the pair went back in its case or walked off. */
export const DEFAULT_STALE_AFTER_MS = 12_000;

export class DiscoveryAggregator {
  private readonly byAddress = new Map<string, EvenAdvertisement & { smoothedRssi: number | null }>();
  private readonly rejectedNames = new Set<string>();

  /** Feed one raw advertisement. Returns the classified record, or null when ignored. */
  ingest(raw: RawAdvertisement): EvenAdvertisement | null {
    let classified = classifyAdvertisement(raw);
    if (!classified) {
      // Android sometimes splits an advertisement across reports — an ADV
      // report without the scan response's name, or the reverse. If earlier
      // traffic from this address already supplied the missing half, retry
      // with it filled in rather than dropping the arm.
      const remembered = this.byAddress.get(normalizeMacAddress(raw.address));
      if (remembered) {
        classified = classifyAdvertisement({
          ...raw,
          name: raw.name || remembered.name,
          manufacturerData: raw.manufacturerData || remembered.manufacturerData,
        });
      }
      if (!classified) {
        if (raw.name) this.rejectedNames.add(raw.name);
        return null;
      }
    }
    const previous = this.byAddress.get(classified.address);
    let smoothedRssi: number | null = classified.rssi;
    if (classified.rssi != null && previous?.smoothedRssi != null) {
      smoothedRssi = previous.smoothedRssi + RSSI_SMOOTHING * (classified.rssi - previous.smoothedRssi);
    } else if (classified.rssi == null && previous) {
      // A bonded-device entry carries no signal; keep what the scan told us.
      smoothedRssi = previous.smoothedRssi;
    }
    const merged: EvenAdvertisement & { smoothedRssi: number | null } = {
      ...classified,
      // A bonded listing never has a serial; do not let it erase a scanned one.
      serial: classified.serial ?? previous?.serial ?? null,
      embeddedMac: classified.embeddedMac ?? previous?.embeddedMac ?? null,
      manufacturerData: classified.manufacturerData || previous?.manufacturerData || "",
      bonded: classified.bonded || (previous?.bonded ?? false),
      rssi: classified.rssi ?? previous?.rssi ?? null,
      txPower: classified.txPower ?? previous?.txPower ?? null,
      seenAtMs: Math.max(classified.seenAtMs, previous?.seenAtMs ?? 0),
      smoothedRssi,
    };
    if (previous && !classified.manufacturerData && previous.manufacturerData) {
      // A record without manufacturer data (a bonded listing, or a split
      // report) parses to "serial unknown" notes and a possibly stale cached
      // name; those must not overwrite what a fuller advertisement already
      // established, or the row shows a serial and claims it is unknown.
      merged.note = previous.note;
      merged.flag = previous.flag;
      merged.embeddedMacMismatch = previous.embeddedMacMismatch;
      merged.ringSerialSuffix = previous.ringSerialSuffix;
      if (previous.name && (!classified.name || classified.source === "paired")) {
        merged.name = previous.name;
      }
    }
    this.byAddress.set(merged.address, merged);
    return merged;
  }

  /** Forget advertisements not refreshed within `maxAgeMs`. Bonded entries are kept. */
  prune(nowMs: number, maxAgeMs: number = DEFAULT_STALE_AFTER_MS): void {
    for (const [address, record] of this.byAddress) {
      if (record.bonded) continue;
      if (nowMs - record.seenAtMs > maxAgeMs) this.byAddress.delete(address);
    }
  }

  clear(): void {
    this.byAddress.clear();
    this.rejectedNames.clear();
  }

  get size(): number {
    return this.byAddress.size;
  }

  /** Names of advertisements that looked like nothing we pair with — for the diagnostics log. */
  get rejectedNameList(): string[] {
    return Array.from(this.rejectedNames).sort();
  }

  advertisements(): EvenAdvertisement[] {
    return Array.from(this.byAddress.values());
  }

  /** Every G2 pair seen, joined on serial, closest first. */
  pairs(): GlassesPairCandidate[] {
    const groups = new Map<string, { left: (EvenAdvertisement & { smoothedRssi: number | null }) | null; right: (EvenAdvertisement & { smoothedRssi: number | null }) | null }>();
    for (const record of this.byAddress.values()) {
      if (record.role === "ring") continue;
      const canonical = serialKey(record.serial);
      const key = canonical ? `serial:${canonical}` : `arm:${record.address}`;
      const group = groups.get(key) ?? { left: null, right: null };
      const slot = record.role === "left" ? "left" : "right";
      const incumbent = group[slot];
      // Two arms of one side claiming the same serial is a replaced temple or a
      // stale row; keep the one heard most recently.
      if (!incumbent || incumbent.seenAtMs <= record.seenAtMs) group[slot] = record;
      groups.set(key, group);
    }
    const pairs: GlassesPairCandidate[] = [];
    for (const group of groups.values()) {
      const left = group.left;
      const right = group.right;
      const any = (left ?? right)!;
      const serial = any.serial;
      const samples = [left, right].filter((arm): arm is NonNullable<typeof arm> => !!arm && arm.smoothedRssi != null);
      const strongest = samples.length ? samples.reduce((a, b) => (a.smoothedRssi! >= b.smoothedRssi! ? a : b)) : null;
      const rssi = strongest ? Math.round(strongest.smoothedRssi!) : null;
      pairs.push({
        id: serialKey(serial) ?? `arm:${any.address}`,
        serial,
        identity: GlassesHardwareIdentity.decode(serial),
        left: left ? stripSmoothing(left) : null,
        right: right ? stripSmoothing(right) : null,
        completeness: left && right ? "complete" : left ? "left-only" : "right-only",
        rssi,
        proximity: estimateProximity(rssi, GLASSES_CALIBRATION),
        lastSeenMs: Math.max(left?.seenAtMs ?? 0, right?.seenAtMs ?? 0),
        mismatchWarning: null,
      });
    }
    // Grouping on the serial means a group can never hold two different
    // serials, so a mixed pair (left temple from A, right from B) surfaces as
    // two lone arms, not as one mismatched row. With exactly one lone arm per
    // side visible that IS the mixed-arms situation — name it on both rows so
    // the wearer isn't left staring at two "waiting for the other" rows.
    const loneLeft = pairs.filter((pair) => pair.completeness === "left-only" && pair.serial);
    const loneRight = pairs.filter((pair) => pair.completeness === "right-only" && pair.serial);
    if (loneLeft.length === 1 && loneRight.length === 1) {
      const warning = pairSerialWarning(evaluatePairSerials(loneLeft[0]!.left!.serial, loneRight[0]!.right!.serial));
      loneLeft[0]!.mismatchWarning = warning;
      loneRight[0]!.mismatchWarning = warning;
    }
    return sortedByProximity(pairs, (pair) => pair.proximity, (pair) => pair.id);
  }

  /** Every R1 ring seen, closest first. */
  rings(): RingCandidate[] {
    const rings: RingCandidate[] = [];
    for (const record of this.byAddress.values()) {
      if (record.role !== "ring") continue;
      const rssi = record.smoothedRssi != null ? Math.round(record.smoothedRssi) : null;
      rings.push({
        id: record.address,
        advertisement: stripSmoothing(record),
        rssi,
        proximity: estimateProximity(rssi, RING_CALIBRATION),
        lastSeenMs: record.seenAtMs,
      });
    }
    return sortedByProximity(rings, (ring) => ring.proximity, (ring) => ring.id);
  }
}

function stripSmoothing(record: EvenAdvertisement & { smoothedRssi: number | null }): EvenAdvertisement {
  const { smoothedRssi: _ignored, ...rest } = record;
  return rest;
}

/**
 * The candidate whose signal is strong enough to call "the one you are
 * holding". `null` when nothing leads clearly, which is the honest answer for
 * two pairs sitting on the same table — and when the list has a single entry,
 * where "closest" has nothing to be closer than.
 */
export function nearestCandidateId(candidates: ReadonlyArray<{ id: string; rssi: number | null }>): string | null {
  if (candidates.length < 2) return null;
  const ranked = candidates
    .filter((candidate): candidate is { id: string; rssi: number } => candidate.rssi != null)
    .slice()
    // Stable order for equal signal so repeated polls nominate the same row.
    .sort((lhs, rhs) => (lhs.rssi === rhs.rssi ? (lhs.id < rhs.id ? -1 : 1) : rhs.rssi - lhs.rssi));
  const best = ranked[0];
  if (!best) return null;
  if (ranked.length === 1) return best.id;
  return best.rssi - ranked[1]!.rssi >= NEAREST_SIGNAL_MARGIN_DBM ? best.id : null;
}

/**
 * The saved pair identity is stored as the serial, but historical values may
 * carry the `_L_1` arm suffix; `serialsMatch` compares on the decoded serial
 * so the suffix or casing is not read as different hardware.
 */
export function isPreviouslyPaired(name: string | null | undefined, pairedSerial: string | null | undefined): boolean {
  return serialsMatch(name, pairedSerial);
}

// ---------------------------------------------------------------------------
// Row presentation
// ---------------------------------------------------------------------------

export type PairingRowPresentation = {
  id: string;
  kind: "glasses" | "ring";
  /** "Even G2 B" / "Even R1" / fallback product name. */
  modelTitle: string;
  /** The serial (glasses) or local name (ring). */
  deviceName: string;
  /** "Frame B · Brown", or null when the serial does not carry a variant we recognise. */
  variantSummary: string | null;
  colorway: GlassesColorway | null;
  /** Hex colour for the swatch. Null suppresses it rather than guessing a finish. */
  swatchHex: string | null;
  /** Product photo path for `<Image src>`. Variant art when bundled, else the generic shot. */
  imagePath: string;
  /** True only when the variant-specific photo is available (the swatch is redundant then). */
  hasVariantImage: boolean;
  isNearest: boolean;
  isPreviouslyPaired: boolean;
  /** "Yours" / "Closest" / "". */
  badge: string;
  proximitySummary: string;
  proximityGlyph: string;
  zone: ProximityZone | null;
  /** "Left + right arms found", "Only the left arm has been seen", …; "" when there is nothing worth a line (an unbonded ring). */
  armsSummary: string;
  /** A problem the wearer should read before tapping, or "" when none. */
  warning: string;
  /** Both arms present (or a ring), so tapping can save addresses. */
  canSelect: boolean;
};

export type RowContext = {
  /** Serial of the pair this phone paired with before, if any. */
  pairedSerial?: string | null;
  /** From `nearestCandidateId` over the same list. */
  nearestId?: string | null;
  /** Ring address saved before, if any. */
  pairedRingAddress?: string | null;
};

/** The presentation fields glasses and ring rows share, so badge and fallback rules cannot drift apart. */
function presentationBase(
  proximity: ProximityEstimate | null,
  isNearest: boolean,
  isPaired: boolean,
  warnings: readonly string[],
): Pick<PairingRowPresentation, "isNearest" | "isPreviouslyPaired" | "badge" | "proximitySummary" | "proximityGlyph" | "zone" | "warning"> {
  return {
    isNearest,
    isPreviouslyPaired: isPaired,
    badge: isPaired ? "Yours" : isNearest ? "Closest" : "",
    proximitySummary: proximity ? zoneLabel(proximity.zone) : "Signal unknown",
    proximityGlyph: proximity ? zoneGlyph(proximity.zone) : "○○○○",
    zone: proximity?.zone ?? null,
    warning: warnings.join(" "),
  };
}

function embeddedMacMismatchWarning(subject: string, ad: EvenAdvertisement | null): string | null {
  if (!ad?.embeddedMacMismatch) return null;
  return `${subject} advertised address ${ad.embeddedMac} differs from its radio address ${ad.address}.`;
}

export function glassesRow(pair: GlassesPairCandidate, context: RowContext = {}): PairingRowPresentation {
  const identity = pair.identity;
  const imagePath = glassesImagePath(identity);
  const isPreviouslyPairedRow = isPreviouslyPaired(pair.serial, context.pairedSerial);
  const isNearest = !!context.nearestId && context.nearestId === pair.id;
  const warnings: string[] = [];

  const leftNote = pair.left?.note;
  const rightNote = pair.right?.note;
  if (leftNote) warnings.push(`Left arm: ${leftNote}.`);
  if (rightNote) warnings.push(`Right arm: ${rightNote}.`);
  const leftMacWarning = embeddedMacMismatchWarning("Left arm's", pair.left);
  if (leftMacWarning) warnings.push(leftMacWarning);
  const rightMacWarning = embeddedMacMismatchWarning("Right arm's", pair.right);
  if (rightMacWarning) warnings.push(rightMacWarning);
  if (pair.mismatchWarning) warnings.push(pair.mismatchWarning);

  let armsSummary: string;
  switch (pair.completeness) {
    case "complete":
      // Arms are grouped by serial, so a complete pair's serials match by construction.
      armsSummary = "Left + right arms found · serials match";
      break;
    case "left-only":
      armsSummary = "Only the left arm has been seen — waiting for the right";
      break;
    case "right-only":
      armsSummary = "Only the right arm has been seen — waiting for the left";
      break;
  }
  if (!pair.serial) armsSummary += " · serial unknown, cannot match arms";

  return {
    id: pair.id,
    kind: "glasses",
    modelTitle: identity?.productName ?? "Even Realities G2",
    deviceName: pair.serial ?? (pair.left ?? pair.right)!.name,
    variantSummary: identity?.variantSummary ?? null,
    colorway: identity?.colorway ?? null,
    swatchHex: identity?.colorway ? colorwaySwatchHex(identity.colorway) : null,
    imagePath,
    hasVariantImage: !!identity?.imageAssetName,
    ...presentationBase(pair.proximity, isNearest, isPreviouslyPairedRow, warnings),
    armsSummary,
    canSelect: pair.completeness === "complete",
  };
}

export function ringRow(ring: RingCandidate, context: RowContext = {}): PairingRowPresentation {
  const ad = ring.advertisement;
  const isPaired = !!context.pairedRingAddress && normalizeMacAddress(context.pairedRingAddress) === ad.address;
  const isNearest = !!context.nearestId && context.nearestId === ring.id;
  const warnings: string[] = [];
  if (ad.note) warnings.push(`${ad.note}.`);
  const macWarning = embeddedMacMismatchWarning("The ring's", ad);
  if (macWarning) warnings.push(macWarning);
  return {
    id: ring.id,
    kind: "ring",
    modelTitle: "Even R1",
    deviceName: ad.ringSerialSuffix ? `${ad.name} · serial …${ad.ringSerialSuffix}` : ad.name,
    variantSummary: null,
    colorway: null,
    swatchHex: null,
    imagePath: R1_IMAGE_PATH,
    hasVariantImage: true,
    ...presentationBase(ring.proximity, isNearest, isPaired, warnings),
    // "Advertising" told the wearer nothing (a listed ring is advertising by
    // definition); only the bonded state is worth a line.
    armsSummary: ad.bonded ? "Paired with this phone" : "",
    canSelect: true,
  };
}

/** Convenience: a colourway's display text, for rows that show the swatch alone. */
export function colorwayLabel(colorway: GlassesColorway | null): string {
  return colorway ? colorwayDisplayName(colorway) : "";
}
