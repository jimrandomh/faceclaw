/**
 * Compatibility check for the glasses firmware. Faceclaw requires the custom
 * firmware: version >= 2.2.4.34 with the required direct-framebuffer and wear
 * notification tokens in the CFW capability string. Stock firmware sends no
 * capability string at all.
 */

import { type FirmwareInfo } from "../native/faceclaw-communicator";

const MIN_FIRMWARE_VERSION = [2, 2, 4, 34];
const REQUIRED_FIRMWARE_EXTENSIONS = ["img640", "fbguard", "wearnotify"] as const;

// The stock firmware release Faceclaw's custom image is built from. Stock at or
// below this can be flashed with our patched image; a newer stock version is
// unrecognized (its layout may differ from what our patch set targets).
export const FLASHABLE_STOCK_VERSION = [2, 2, 9, 22];
export const FLASHABLE_STOCK_VERSION_TEXT = FLASHABLE_STOCK_VERSION.join(".");

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
 * Human-readable explanation of why this firmware cannot run Faceclaw, or
 * null if it is compatible. Returns null when no version was reported at all
 * (no data is not evidence of incompatibility).
 */
export function firmwareIncompatibilityMessage(info: FirmwareInfo): string | null {
  const reportedVersions = [info.leftVersion, info.rightVersion].filter((v) => v.trim().length > 0);
  if (reportedVersions.length === 0) return null;

  const minVersionText = MIN_FIRMWARE_VERSION.join(".");
  const versionsText = `L=${info.leftVersion || "unknown"} R=${info.rightVersion || "unknown"}`;

  if (reportedVersions.some((v) => compareVersions(parseDottedVersion(v), MIN_FIRMWARE_VERSION) < 0)) {
    return (
      `The glasses report firmware ${versionsText}, but Faceclaw requires the modified firmware, ` +
      `version ${minVersionText} or newer. Displaying images will not work until the glasses firmware is updated.`
    );
  }

  const tokens = info.capabilities.trim().split(/\s+/);
  const missingExtensions = REQUIRED_FIRMWARE_EXTENSIONS.filter(
    (extension) => !tokens.includes(extension),
  );
  if (missingExtensions.length) {
    return (
      `The glasses firmware (${versionsText}) does not advertise the required ` +
      `${missingExtensions.map((extension) => `"${extension}"`).join(" and ")} extension` +
      `${missingExtensions.length === 1 ? "" : "s"}` +
      `${info.capabilities.trim() ? ` (reported: ${info.capabilities.trim()})` : ", which suggests stock firmware"}. ` +
      `Faceclaw requires the modified firmware with the guarded 640x480 direct-framebuffer path and wear notifications.`
    );
  }

  return null;
}

/** True when the glasses advertise every custom-firmware extension Faceclaw needs. */
export function hasCustomFirmware(info: FirmwareInfo): boolean {
  const tokens = info.capabilities.trim().split(/\s+/);
  return REQUIRED_FIRMWARE_EXTENSIONS.every((extension) => tokens.includes(extension));
}

/**
 * True when the firmware advertises the optional mic-control extension: the
 * private field-103/104 channel for per-temple multi-microphone capture that
 * the Microphones app's 4-mic array mode and beamforming need. Absent on the
 * stock single-mono-stream path, which still works (firmware-computed
 * direction of arrival, one mixed channel).
 */
export function hasMicControl(info: FirmwareInfo): boolean {
  return info.capabilities.trim().split(/\s+/).includes("micctl");
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
 * - "custom": Faceclaw's firmware is already installed — nothing to flash.
 * - "flashable-stock": stock firmware at or below the version we build from.
 * - "newer-stock": stock firmware newer than we recognize — flash only on override.
 * - "unknown": no version could be read (treated as a probe/connection failure).
 */
export type OnboardingFirmwareKind = "custom" | "flashable-stock" | "newer-stock" | "unknown";

export function classifyOnboardingFirmware(info: FirmwareInfo): {
  kind: OnboardingFirmwareKind;
  version: string;
} {
  if (hasCustomFirmware(info)) {
    return { kind: "custom", version: reportedFirmwareVersion(info) };
  }
  const version = reportedFirmwareVersion(info);
  if (!version) {
    return { kind: "unknown", version: "" };
  }
  const comparison = compareVersions(parseDottedVersion(version), FLASHABLE_STOCK_VERSION);
  return { kind: comparison <= 0 ? "flashable-stock" : "newer-stock", version };
}
