/**
 * Compatibility check for the glasses firmware. Faceclaw requires its own
 * custom firmware at a specific revision.
 *
 * The firmware identifies itself through one extra string in the sid-0x09
 * settings READ response (protobuf field 100, the "firmware extension" slot):
 *
 *   "Faceclaw/<n>"  -- Faceclaw's custom firmware, revision <n>. The revision
 *                      goes up whenever the firmware contract changes and is
 *                      not kept in sync with Faceclaw app versions.
 *   "EVENCFW/..."   -- older Faceclaw firmware, from before revisions existed
 *                      (it advertised feature tokens instead). Always outdated.
 *   (empty)         -- stock firmware; it never sends the field.
 *   anything else   -- custom firmware from a different source.
 *
 * Because an exact revision is required, nothing else in the app gates on the
 * extension string: once the firmware is compatible, every feature it provides
 * is assumed present.
 */

export type FirmwareInfo = {
  leftVersion: string;
  rightVersion: string;
  /** Raw contents of the firmware-extension slot ("" on stock firmware). */
  extension: string;
};

/** The Faceclaw firmware revision this build of the app needs. */
export const REQUIRED_FACECLAW_FIRMWARE_VERSION = 1;

const FACECLAW_PREFIX = "Faceclaw/";
const LEGACY_PREFIX = "EVENCFW";

// The stock firmware release Faceclaw's custom image is built from. Stock at or
// below this can be flashed with our patched image; a newer stock version is
// unrecognized (its layout may differ from what our patch set targets).
export const BASE_STOCK_VERSION = [2, 2, 9, 22];
export const BASE_STOCK_VERSION_TEXT = BASE_STOCK_VERSION.join(".");
export const VALIDATED_STOCK_VERSION = [2, 2, 10, 10];
export const VALIDATED_STOCK_VERSION_TEXT = VALIDATED_STOCK_VERSION.join(".");

export type FirmwareExtension =
  /** Nothing in the slot: stock firmware. */
  | { kind: "none" }
  /** Faceclaw's firmware at the given revision. */
  | { kind: "faceclaw"; version: number }
  /** Pre-revision Faceclaw firmware ("EVENCFW/<ver> <tokens>"). */
  | { kind: "legacy-faceclaw"; text: string }
  /** Custom firmware from some other project. */
  | { kind: "other"; text: string };

export function parseFirmwareExtension(extension: string): FirmwareExtension {
  const text = extension.trim();
  if (!text) return { kind: "none" };
  if (text.startsWith(FACECLAW_PREFIX)) {
    const version = parseInt(text.slice(FACECLAW_PREFIX.length), 10);
    if (Number.isFinite(version) && version >= 0) return { kind: "faceclaw", version };
    return { kind: "other", text };
  }
  if (text.startsWith(LEGACY_PREFIX)) return { kind: "legacy-faceclaw", text };
  return { kind: "other", text };
}

/** Short user-facing description of what the extension slot reported. */
export function describeFirmwareExtension(extension: FirmwareExtension): string {
  switch (extension.kind) {
    case "faceclaw":
      return `Faceclaw firmware revision ${extension.version}`;
    case "legacy-faceclaw":
      return `an older Faceclaw firmware (reported "${extension.text}")`;
    case "other":
      return `custom firmware from a different source (reported "${extension.text}")`;
    default:
      return "stock firmware";
  }
}

function parseDottedVersion(version: string): number[] {
  return version
    .trim()
    .split(".")
    .map((part) => {
      const value = parseInt(part, 10);
      return Number.isFinite(value) ? value : 0;
    });
}

/** Standard component-wise compare; missing components count as 0. */
function compareVersions(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * True when the glasses run Faceclaw's firmware at the required revision or
 * newer. (A newer revision is accepted: revisions only add to the contract.)
 */
export function hasCompatibleFirmware(info: FirmwareInfo): boolean {
  const extension = parseFirmwareExtension(info.extension);
  return extension.kind === "faceclaw" && extension.version >= REQUIRED_FACECLAW_FIRMWARE_VERSION;
}

/**
 * Human-readable explanation of why this firmware cannot run Faceclaw, or
 * null if it is compatible. Returns null when nothing was reported at all
 * (no data is not evidence of incompatibility).
 */
export function firmwareIncompatibilityMessage(info: FirmwareInfo): string | null {
  const reportedVersions = [info.leftVersion, info.rightVersion].filter((v) => v.trim().length > 0);
  const extension = parseFirmwareExtension(info.extension);
  if (reportedVersions.length === 0 && extension.kind === "none") return null;

  const versionsText = `L=${info.leftVersion || "unknown"} R=${info.rightVersion || "unknown"}`;
  const required = `Faceclaw firmware revision ${REQUIRED_FACECLAW_FIRMWARE_VERSION}`;

  switch (extension.kind) {
    case "faceclaw":
      if (extension.version >= REQUIRED_FACECLAW_FIRMWARE_VERSION) return null;
      return (
        `The glasses run Faceclaw firmware revision ${extension.version} (base ${versionsText}), ` +
        `but this version of Faceclaw requires revision ${REQUIRED_FACECLAW_FIRMWARE_VERSION}. ` +
        "Install the updated custom firmware to continue."
      );
    case "legacy-faceclaw":
      return (
        `The glasses run an older version of Faceclaw's custom firmware (reported "${extension.text}", ` +
        `base ${versionsText}). This version of Faceclaw requires ${required}. ` +
        "Install the updated custom firmware to continue."
      );
    case "other":
      return (
        `The glasses run custom firmware from a different source (reported "${extension.text}", ` +
        `base ${versionsText}). Faceclaw requires ${required}; installing it will replace the current firmware.`
      );
    default:
      return (
        `The glasses report stock firmware ${versionsText}. Faceclaw requires ${required}. ` +
        "Displaying images will not work until the custom firmware is installed."
      );
  }
}

/** The higher of the two arms' reported versions, or "" if none reported. */
export function reportedFirmwareVersion(info: FirmwareInfo): string {
  const versions = [info.leftVersion, info.rightVersion].map((v) => v.trim()).filter(Boolean);
  if (versions.length === 0) return "";
  return versions.reduce((highest, current) =>
    compareVersions(parseDottedVersion(current), parseDottedVersion(highest)) > 0 ? current : highest,
  );
}

/**
 * How the pre-flash firmware check should treat the connected glasses:
 * - "custom": Faceclaw's firmware at the required revision (or newer) is
 *   already installed — nothing to flash.
 * - "older-faceclaw": Faceclaw's firmware at an older revision (including
 *   the pre-revision "EVENCFW" builds) — flash to update it.
 * - "other-custom": custom firmware from a different source — flash to
 *   replace it.
 * - "flashable-stock": stock firmware at or below the version we build from.
 * - "newer-stock-validated": stock firmware newer than the version we build
 *   from, on which the downgrade has been tested successfully
 * - "newer-stock-unvalidated": stock firmware newer than we recognize — flash only on override.
 * - "unknown": no version could be read (treated as a probe/connection failure).
 */
export type OnboardingFirmwareKind =
  | "custom"
  | "older-faceclaw"
  | "other-custom"
  | "flashable-stock"
  | "newer-stock-validated"
  | "newer-stock-unvalidated"
  | "unknown";

export function classifyOnboardingFirmware(info: FirmwareInfo): {
  kind: OnboardingFirmwareKind;
  version: string;
  extension: FirmwareExtension;
} {
  const extension = parseFirmwareExtension(info.extension);
  const version = reportedFirmwareVersion(info);
  switch (extension.kind) {
    case "faceclaw":
      return {
        kind: extension.version >= REQUIRED_FACECLAW_FIRMWARE_VERSION ? "custom" : "older-faceclaw",
        version,
        extension,
      };
    case "legacy-faceclaw":
      return { kind: "older-faceclaw", version, extension };
    case "other":
      return { kind: "other-custom", version, extension };
    default:
      break;
  }
  if (!version) {
    return { kind: "unknown", version: "", extension };
  }
  if (compareVersions(parseDottedVersion(version), BASE_STOCK_VERSION) <= 0) {
    return { kind: "flashable-stock", version, extension };
  } else if (compareVersions(parseDottedVersion(version), VALIDATED_STOCK_VERSION) <= 0) {
    return { kind: "newer-stock-validated", version, extension };
  } else {
    return { kind: "newer-stock-unvalidated", version, extension };
  }
}
