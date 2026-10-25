/**
 * The stock SDK's DeviceStatus (getGlassesInfo().status and the
 * deviceStatusChanged push), built from what Faceclaw actually knows about
 * the glasses. Pure, so it can be tested without NativeScript.
 */

/** Used when no glasses have been paired (preview-only mode). */
export const PLACEHOLDER_SERIAL = "FACECLAW-G2";

/** Wire shape of the SDK's DeviceStatus. Unknown fields are omitted rather than guessed. */
export type EvenHubDeviceStatus = {
  sn: string;
  connectType: "connected" | "disconnected";
  isWearing?: boolean;
  batteryLevel?: number;
  isCharging?: boolean;
  isInCase?: boolean;
};

export type EvenHubDeviceStatusInput = {
  /** The paired glasses' serial number, or null when none are paired. */
  serial: string | null;
  connected: boolean;
  /** null until the firmware reports a wear state this session. */
  worn: boolean | null;
  /** Last known headset battery percentage, or null if never reported. */
  battery: number | null;
  charging: boolean;
};

/** Where a session reads the device status from (live in the app; fixed in tests). */
export type EvenHubDeviceStatusSource = {
  read(): EvenHubDeviceStatusInput;
  /** Call `listener` after anything read() reports may have changed. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
};

/** No glasses: what a session reports when it isn't given a live source. */
export const OFFLINE_DEVICE_STATUS_SOURCE: EvenHubDeviceStatusSource = {
  read: () => ({ serial: null, connected: false, worn: null, battery: null, charging: false }),
  subscribe: () => () => {},
};

export function buildEvenHubDeviceStatus(input: EvenHubDeviceStatusInput): EvenHubDeviceStatus {
  const status: EvenHubDeviceStatus = {
    // The SDK only applies a status push whose sn matches getGlassesInfo's,
    // so both must come from here.
    sn: input.serial?.trim() || PLACEHOLDER_SERIAL,
    connectType: input.connected ? "connected" : "disconnected",
    isCharging: input.charging,
    // The G2 only charges in its case, and Faceclaw has no separate
    // in-case report.
    isInCase: input.charging,
  };
  if (input.worn !== null) status.isWearing = input.worn;
  if (input.battery !== null) status.batteryLevel = input.battery;
  return status;
}

export function sameDeviceStatus(a: EvenHubDeviceStatus, b: EvenHubDeviceStatus): boolean {
  return a.sn === b.sn && a.connectType === b.connectType && a.isWearing === b.isWearing &&
    a.batteryLevel === b.batteryLevel && a.isCharging === b.isCharging && a.isInCase === b.isInCase;
}
