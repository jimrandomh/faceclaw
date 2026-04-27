import { ApplicationSettings } from "@nativescript/core";

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

export function normalizeMacAddress(value: string | null | undefined): string {
  const compact = (value ?? "")
    .trim()
    .replace(/[^0-9a-fA-F]/g, "")
    .toUpperCase();
  if (compact.length !== 12) {
    return (value ?? "").trim().toUpperCase();
  }
  return compact.match(/.{1,2}/g)?.join(":") ?? compact;
}

export function isValidMacAddress(value: string, allowEmpty = false): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return allowEmpty;
  }
  return /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/.test(normalizeMacAddress(trimmed));
}
