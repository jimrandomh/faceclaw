import { ApplicationSettings } from "@nativescript/core";

import { normalizeMacAddress } from "./even-advertisement";

export { normalizeMacAddress };

export type DeviceAddresses = {
  right: string;
  left: string;
  ring: string;
};

const ADDRESS_KEYS = {
  right: "deviceAddress.right",
  left: "deviceAddress.left",
  ring: "deviceAddress.ring",
} as const;

const DEFAULT_DEVICE_ADDRESSES: DeviceAddresses = {
  right: "",
  left: "",
  ring: "",
};

export function loadDeviceAddresses(): DeviceAddresses {
  return {
    right: normalizeMacAddress(ApplicationSettings.getString(ADDRESS_KEYS.right, DEFAULT_DEVICE_ADDRESSES.right)),
    left: normalizeMacAddress(ApplicationSettings.getString(ADDRESS_KEYS.left, DEFAULT_DEVICE_ADDRESSES.left)),
    ring: normalizeMacAddress(ApplicationSettings.getString(ADDRESS_KEYS.ring, DEFAULT_DEVICE_ADDRESSES.ring)),
  };
}

export function saveDeviceAddresses(addresses: DeviceAddresses): void {
  ApplicationSettings.setString(ADDRESS_KEYS.right, normalizeMacAddress(addresses.right));
  ApplicationSettings.setString(ADDRESS_KEYS.left, normalizeMacAddress(addresses.left));
  ApplicationSettings.setString(ADDRESS_KEYS.ring, normalizeMacAddress(addresses.ring));
}

export function isValidMacAddress(value: string, allowEmpty = false): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return allowEmpty;
  }
  return /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/.test(normalizeMacAddress(trimmed));
}

// ---------------------------------------------------------------------------
// Paired-glasses identity
// ---------------------------------------------------------------------------

/**
 * What the pairing scan learned about the pair whose addresses were saved, so
 * later screens can name and picture the exact glasses without a connection.
 * Kept separate from the addresses so hand-entered MACs keep working.
 */
export type PairedGlassesIdentity = {
  /** The 14-character serial both arms advertised (pair identity). */
  serial: string;
  leftName: string;
  rightName: string;
  leftAddress: string;
  rightAddress: string;
  /** Ring local name ("EVEN R1_B56EE2"), when a ring was chosen from the scan. */
  ringName: string;
  ringAddress: string;
  pairedAtMs: number;
};

const IDENTITY_KEYS = {
  serial: "deviceIdentity.serial",
  leftName: "deviceIdentity.leftName",
  rightName: "deviceIdentity.rightName",
  leftAddress: "deviceIdentity.leftAddress",
  rightAddress: "deviceIdentity.rightAddress",
  ringName: "deviceIdentity.ringName",
  ringAddress: "deviceIdentity.ringAddress",
  pairedAtMs: "deviceIdentity.pairedAtMs",
} as const;

export function loadPairedGlassesIdentity(): PairedGlassesIdentity | null {
  const serial = ApplicationSettings.getString(IDENTITY_KEYS.serial, "").trim();
  if (!serial) return null;
  return {
    serial,
    leftName: ApplicationSettings.getString(IDENTITY_KEYS.leftName, ""),
    rightName: ApplicationSettings.getString(IDENTITY_KEYS.rightName, ""),
    leftAddress: normalizeMacAddress(ApplicationSettings.getString(IDENTITY_KEYS.leftAddress, "")),
    rightAddress: normalizeMacAddress(ApplicationSettings.getString(IDENTITY_KEYS.rightAddress, "")),
    ringName: ApplicationSettings.getString(IDENTITY_KEYS.ringName, ""),
    ringAddress: normalizeMacAddress(ApplicationSettings.getString(IDENTITY_KEYS.ringAddress, "")),
    pairedAtMs: ApplicationSettings.getNumber(IDENTITY_KEYS.pairedAtMs, 0),
  };
}

export function savePairedGlassesIdentity(identity: PairedGlassesIdentity): void {
  ApplicationSettings.setString(IDENTITY_KEYS.serial, identity.serial.trim().toUpperCase());
  ApplicationSettings.setString(IDENTITY_KEYS.leftName, identity.leftName);
  ApplicationSettings.setString(IDENTITY_KEYS.rightName, identity.rightName);
  ApplicationSettings.setString(IDENTITY_KEYS.leftAddress, normalizeMacAddress(identity.leftAddress));
  ApplicationSettings.setString(IDENTITY_KEYS.rightAddress, normalizeMacAddress(identity.rightAddress));
  ApplicationSettings.setString(IDENTITY_KEYS.ringName, identity.ringName);
  ApplicationSettings.setString(IDENTITY_KEYS.ringAddress, normalizeMacAddress(identity.ringAddress));
  ApplicationSettings.setNumber(IDENTITY_KEYS.pairedAtMs, identity.pairedAtMs);
}

export function clearPairedGlassesIdentity(): void {
  for (const key of Object.values(IDENTITY_KEYS)) {
    ApplicationSettings.remove(key);
  }
}

/**
 * The saved identity only describes the saved addresses. If the user later
 * hand-edits an arm's MAC to something else, the serial no longer applies —
 * report null rather than a stale name for a different pair.
 */
export function loadPairedGlassesIdentityForAddresses(addresses: DeviceAddresses): PairedGlassesIdentity | null {
  const identity = loadPairedGlassesIdentity();
  if (!identity) return null;
  if (identity.leftAddress !== normalizeMacAddress(addresses.left)) return null;
  if (identity.rightAddress !== normalizeMacAddress(addresses.right)) return null;
  return identity;
}
