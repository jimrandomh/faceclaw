import { getNumberSetting, getStringSetting, removeSetting, setNumberSetting, setStringSetting } from "../native/settings-store";

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
    right: normalizeMacAddress(getStringSetting(ADDRESS_KEYS.right, DEFAULT_DEVICE_ADDRESSES.right)),
    left: normalizeMacAddress(getStringSetting(ADDRESS_KEYS.left, DEFAULT_DEVICE_ADDRESSES.left)),
    ring: normalizeMacAddress(getStringSetting(ADDRESS_KEYS.ring, DEFAULT_DEVICE_ADDRESSES.ring)),
  };
}

export function saveDeviceAddresses(addresses: DeviceAddresses): void {
  setStringSetting(ADDRESS_KEYS.right, normalizeMacAddress(addresses.right));
  setStringSetting(ADDRESS_KEYS.left, normalizeMacAddress(addresses.left));
  setStringSetting(ADDRESS_KEYS.ring, normalizeMacAddress(addresses.ring));
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
  const serial = getStringSetting(IDENTITY_KEYS.serial, "").trim();
  if (!serial) return null;
  return {
    serial,
    leftName: getStringSetting(IDENTITY_KEYS.leftName, ""),
    rightName: getStringSetting(IDENTITY_KEYS.rightName, ""),
    leftAddress: normalizeMacAddress(getStringSetting(IDENTITY_KEYS.leftAddress, "")),
    rightAddress: normalizeMacAddress(getStringSetting(IDENTITY_KEYS.rightAddress, "")),
    ringName: getStringSetting(IDENTITY_KEYS.ringName, ""),
    ringAddress: normalizeMacAddress(getStringSetting(IDENTITY_KEYS.ringAddress, "")),
    pairedAtMs: getNumberSetting(IDENTITY_KEYS.pairedAtMs, 0),
  };
}

export function savePairedGlassesIdentity(identity: PairedGlassesIdentity): void {
  setStringSetting(IDENTITY_KEYS.serial, identity.serial.trim().toUpperCase());
  setStringSetting(IDENTITY_KEYS.leftName, identity.leftName);
  setStringSetting(IDENTITY_KEYS.rightName, identity.rightName);
  setStringSetting(IDENTITY_KEYS.leftAddress, normalizeMacAddress(identity.leftAddress));
  setStringSetting(IDENTITY_KEYS.rightAddress, normalizeMacAddress(identity.rightAddress));
  setStringSetting(IDENTITY_KEYS.ringName, identity.ringName);
  setStringSetting(IDENTITY_KEYS.ringAddress, normalizeMacAddress(identity.ringAddress));
  setNumberSetting(IDENTITY_KEYS.pairedAtMs, identity.pairedAtMs);
}

export function clearPairedGlassesIdentity(): void {
  for (const key of Object.values(IDENTITY_KEYS)) {
    removeSetting(key);
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
