/**
 * Decodes an Even Realities serial number into the product family, frame shape,
 * and colourway the wearer can actually see.
 *
 * ## Why this exists
 *
 * A G2 arm advertises its 14-character serial inside the manufacturer data
 * (`"ER"` + SN(14) + MAC(6) + flag(1), see `even-advertisement.ts`). Two people
 * in the same room with glasses in pairing mode therefore produce two rows of
 * near-identical alphanumerics, and the only way to tell which one you are
 * holding is to guess. The serial already encodes the answer — the shape of
 * the frame and its colour — so decoding it turns "S211GBBC180304" into
 * "Even G2 B · Brown", which the wearer can check against the thing in their
 * hand without connecting to a stranger's hardware first.
 *
 * ## Where the mapping comes from
 *
 * Recovered from the Even Realities app 2.2.0
 * (`even/common/utils/device_image_resolver` `_parseGlassesSku`, and
 * `even/common/extension/ble/ble_mtach_device_ext` `evenSNName` / `matchModel`).
 * That app does exactly this decode to pick its product artwork:
 *
 * | Serial slice | Meaning |
 * | --- | --- |
 * | `[0..<2]` | Product family — `S1` = G1 glasses, `S2` = G2 glasses, `B2` = R1 ring |
 * | `[0..<3]` | Frame shape — `S20`/`S28` → A, `S21`/`S29` → B, `S22` → C (G1: `S11` → B, else A) |
 * | `[0..<4]` | Model code (`S211`, `S110`, `B210`, `B290`) |
 * | `[5]` | Colourway — `A` grey, `B` brown, `C` green |
 *
 * Two deliberate departures from the Even app: it silently defaults an
 * unrecognised prefix to frame A and an unrecognised colour byte to grey. For
 * identification that is the wrong trade — mislabelling a future SKU as
 * "Frame A · Grey" is worse than saying nothing — so unknown values decode to
 * `null` here and the UI falls back to the serial.
 *
 * This module is pure (no NativeScript imports) so it can run under node tests.
 */

export type GlassesFamily = "g1" | "g2" | "r1";

/** Frame shape. Even ships these as bare letters — frame A is round, B is square. */
export type GlassesFrame = "a" | "b" | "c";

/** Frame finish. The three colourways Even sells across G1 and G2. */
export type GlassesColorway = "grey" | "brown" | "green";

const FAMILY_PRODUCT_NAME: Record<GlassesFamily, string> = {
  g1: "Even G1",
  g2: "Even G2",
  r1: "Even R1",
};

const COLORWAY_DISPLAY_NAME: Record<GlassesColorway, string> = {
  grey: "Grey",
  brown: "Brown",
  green: "Green",
};

/**
 * sRGB hex for the swatch shown beside a scan row. Approximations of the
 * shipping finishes, chosen to stay distinguishable at small sizes.
 */
const COLORWAY_SWATCH_HEX: Record<GlassesColorway, string> = {
  grey: "#8A8D91",
  brown: "#6B4F3A",
  green: "#3E5B45",
};

export function familyProductName(family: GlassesFamily): string {
  return FAMILY_PRODUCT_NAME[family];
}

export function familyIsGlasses(family: GlassesFamily): boolean {
  return family === "g1" || family === "g2";
}

export function frameLetter(frame: GlassesFrame): string {
  return frame.toUpperCase();
}

export function frameDisplayName(frame: GlassesFrame): string {
  return `Frame ${frameLetter(frame)}`;
}

export function colorwayDisplayName(colorway: GlassesColorway): string {
  return COLORWAY_DISPLAY_NAME[colorway];
}

export function colorwaySwatchHex(colorway: GlassesColorway): string {
  return COLORWAY_SWATCH_HEX[colorway];
}

export class GlassesHardwareIdentity {
  /** The normalised (uppercased, trimmed, suffix-stripped) serial this identity was decoded from. */
  readonly serial: string;
  readonly family: GlassesFamily;
  /** Null when the prefix is a family we recognise but a shape we do not, and always null for the ring. */
  readonly frame: GlassesFrame | null;
  /** Null when the colour byte is not one of A/B/C, and always null for the ring. */
  readonly colorway: GlassesColorway | null;

  private constructor(serial: string, family: GlassesFamily, frame: GlassesFrame | null, colorway: GlassesColorway | null) {
    this.serial = serial;
    this.family = family;
    this.frame = frame;
    this.colorway = colorway;
  }

  /**
   * Decode a serial, or null when the string is not an Even serial at all.
   *
   * Accepts the advertised name verbatim: the scan list carries the bare
   * serial, but saved pair identities and log lines carry arm suffixes
   * (`S211GBBC180304_L_1`), so the leading serial run is taken and the rest
   * ignored.
   */
  static decode(rawValue: string | null | undefined): GlassesHardwareIdentity | null {
    if (!rawValue) return null;
    const normalized = normalizeSerial(rawValue);
    // Both the family prefix (3) and the colour byte (index 5) must be present
    // for the string to carry any variant information at all.
    if (normalized.length < 6) return null;

    const prefix2 = normalized.slice(0, 2);
    const prefix3 = normalized.slice(0, 3);

    let family: GlassesFamily;
    switch (prefix2) {
      case "S1":
        family = "g1";
        break;
      case "S2":
        family = "g2";
        break;
      case "B2":
        family = "r1";
        break;
      default:
        return null;
    }

    const isGlasses = familyIsGlasses(family);
    return new GlassesHardwareIdentity(
      normalized,
      family,
      isGlasses ? decodeFrame(prefix3, family) : null,
      isGlasses ? decodeColorway(normalized) : null,
    );
  }

  /** The four-character model code (`S211`), matching the Even app's `matchModel`. */
  get modelCode(): string | null {
    return this.serial.length >= 4 ? this.serial.slice(0, 4) : null;
  }

  /**
   * Last four characters of the serial. Two people with the same frame and
   * finish are the case this exists for: it is the shortest string that still
   * separates them.
   */
  get shortSerial(): string {
    return this.serial.slice(-4);
  }

  /** "Even G2 B" — product plus frame letter, the way Even names the SKU. */
  get productName(): string {
    const base = familyProductName(this.family);
    return this.frame ? `${base} ${frameLetter(this.frame)}` : base;
  }

  /** "Frame B · Brown", or just the half that decoded. Null when neither did. */
  get variantSummary(): string | null {
    const parts: string[] = [];
    if (this.frame) parts.push(frameDisplayName(this.frame));
    if (this.colorway) parts.push(colorwayDisplayName(this.colorway));
    return parts.length ? parts.join(" · ") : null;
  }

  /** "Even G2 B · Brown" — the one-line label for a device row or status line. */
  get displayName(): string {
    return this.colorway ? `${this.productName} · ${colorwayDisplayName(this.colorway)}` : this.productName;
  }

  /**
   * Bundled artwork key for the product photo of this exact SKU, or null when
   * the shape or finish did not decode — or when the SKU is real but no
   * artwork is bundled for it. Membership is explicit so a missing image fails
   * to a generic product shot rather than to a blank `<Image>`.
   */
  get imageAssetName(): string | null {
    if (!this.frame || !this.colorway) return null;
    const candidate = `glasses_${this.family}_${this.frame}_${this.colorway}`;
    return BUNDLED_VARIANT_ASSET_NAMES.has(candidate) ? candidate : null;
  }

  equals(other: GlassesHardwareIdentity | null | undefined): boolean {
    return !!other && other.serial === this.serial && other.family === this.family && other.frame === this.frame && other.colorway === this.colorway;
  }
}

/**
 * Frame C artwork is not bundled yet; add the PNG under `app/images/glasses/`
 * and the name here together (see `glasses-artwork.ts`).
 */
export const BUNDLED_VARIANT_ASSET_NAMES: ReadonlySet<string> = new Set([
  "glasses_g2_a_grey",
  "glasses_g2_a_brown",
  "glasses_g2_a_green",
  "glasses_g2_b_grey",
  "glasses_g2_b_brown",
  "glasses_g2_b_green",
]);

/**
 * Uppercase, drop surrounding whitespace, and cut at the first character that
 * cannot appear in a serial — which is how the `_L_1` / `_R_1` arm suffix gets
 * removed.
 */
export function normalizeSerial(rawValue: string): string {
  const trimmed = rawValue.trim().toUpperCase();
  const match = /^[0-9A-Z]*/.exec(trimmed);
  return match ? match[0] : "";
}

function decodeFrame(prefix3: string, family: GlassesFamily): GlassesFrame | null {
  switch (family) {
    case "g1":
      // G1 ships two shapes; the Even app tests only for `S11` and treats every
      // other `S1` prefix as A.
      return prefix3 === "S11" ? "b" : "a";
    case "g2":
      switch (prefix3) {
        case "S20":
        case "S28":
          return "a";
        case "S21":
        case "S29":
          return "b";
        case "S22":
          return "c";
        default:
          return null;
      }
    case "r1":
      return null;
  }
}

function decodeColorway(serial: string): GlassesColorway | null {
  switch (serial.charAt(5)) {
    case "A":
      return "grey";
    case "B":
      return "brown";
    case "C":
      return "green";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Left/right pair check
// ---------------------------------------------------------------------------

/**
 * Do the two temples belong to the same pair?
 *
 * A G2 is two independent BLE peripherals, each advertising its own serial.
 * They should read identically. They will not when two pairs share a case,
 * when an arm from one pair is charged alongside another, or when a
 * replacement temple is fitted — and the result is a link that starts,
 * authenticates on one side, and then behaves inexplicably. This names that
 * failure before a connection is attempted.
 */
export type GlassesPairSerialVerdict =
  | { kind: "matched"; serial: string }
  | { kind: "unknown" }
  | { kind: "mismatched"; left: string; right: string };

/**
 * Canonical comparison key for a serial-ish string: the decoded serial when it
 * decodes (so an `_L_1` arm suffix or casing difference is not read as
 * different hardware), else the trimmed uppercase raw value. Null when empty.
 * The single definition of serial equality — pair grouping, the pair check,
 * and the "Yours" badge must all agree on it.
 */
export function serialKey(value: string | null | undefined): string | null {
  const trimmed = nonEmpty(value);
  if (!trimmed) return null;
  return GlassesHardwareIdentity.decode(trimmed)?.serial ?? trimmed.toUpperCase();
}

/** True when both values carry a serial and the serials name the same hardware. */
export function serialsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const keyA = serialKey(a);
  const keyB = serialKey(b);
  return !!keyA && !!keyB && keyA === keyB;
}

export function evaluatePairSerials(left: string | null | undefined, right: string | null | undefined): GlassesPairSerialVerdict {
  const l = nonEmpty(left);
  const r = nonEmpty(right);
  if (!l || !r) return { kind: "unknown" };
  if (!serialsMatch(l, r)) return { kind: "mismatched", left: l, right: r };
  return { kind: "matched", serial: serialKey(l)! };
}

/**
 * One sentence naming what is wrong and what to do, or null when nothing is
 * wrong. Deliberately concrete about the serials: the wearer has to physically
 * sort two piles of near-identical temples, and the printed serial is what
 * they can sort them by.
 */
export function pairSerialWarning(verdict: GlassesPairSerialVerdict): string | null {
  if (verdict.kind !== "mismatched") return null;
  const leftVariant = GlassesHardwareIdentity.decode(verdict.left)?.displayName;
  const rightVariant = GlassesHardwareIdentity.decode(verdict.right)?.displayName;
  let message = `The left and right temples report different serial numbers (left ${verdict.left}, right ${verdict.right}).`;
  if (leftVariant && rightVariant && leftVariant !== rightVariant) {
    message += ` They are not even the same model: ${leftVariant} and ${rightVariant}.`;
  }
  message += " These are arms from two different pairs — check the serial printed inside each temple and pair a matched set.";
  return message;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
