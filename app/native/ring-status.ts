import { Utils } from "@nativescript/core";

declare const com: any;

/**
 * R1 ring diagnostics (Developer > Debug tests > Ring status). Session-side
 * state comes from the active communicator; the phone's own Bluetooth view of
 * the ring (bond, GATT/ACL link) is queried separately so it is available
 * even with no session or with the direct ring link disabled.
 */

/** GlassesSessionCore.getRingStatus. Ages are ms before now, -1 = never. */
export type RingSessionStatus = {
  directEnabled: boolean;
  ringAddress: string;
  glassesConnected: boolean;
  sessionReady: boolean;
  directConnected: boolean;
  directNotificationsReady: boolean;
  directConnectCount: number;
  directStateAgeMs: number;
  directBattery: number;
  lastDirectNotifyAgeMs: number;
  lastDirectInputAgeMs: number;
  lastDirectInput: string;
  glassesRingBattery: number;
  glassesRingBatteryAgeMs: number;
  lastGlassesInputAgeMs: number;
  lastGlassesInput: string;
  lastDirectError: string;
  /** Ring MAC as the glasses reported it (wire byte order, hex), "" if not yet seen. */
  glassesRingMac: string;
  glassesRingName: string;
  lastGlassesReport: string;
  lastGlassesReportAgeMs: number;
  lastCommand: string;
  lastCommandAgeMs: number;
  lastCommandResultR: string;
  lastCommandResultL: string;
  /** Which ring role the direct link claims: "phone" or "glasses". */
  directRole: string;
  /** Glasses role only: what the ring made of our legacy pair-auth this connection ("" = not sent). */
  directGlassesAuth: string;
  directGlassesAuthAgeMs: number;
  lastRingCommand: string;
  lastRingCommandAgeMs: number;
  lastRingCommandResult: string;
  /** Last direct-link notification nothing decoded: characteristic prefix and hex. */
  lastDirectRaw: string;
  lastDirectRawAgeMs: number;
};

/**
 * EXPERIMENTAL glasses-side ring link control (sid 0x80 pair manager):
 * "disconnect" drops the glasses' ring link, "release" also clears their
 * connect mode (may hold off auto-reconnect), "unpair" makes them forget the
 * ring, "connect" hands the ring back.
 */
export type GlassesRingLinkAction = "disconnect" | "release" | "unpair" | "connect";

/**
 * EXPERIMENTAL ring-side binding commands over the direct link (see
 * GlassesSessionCore.sendRingConfigCommand). "bind" and "unbind" combine the
 * ring and glasses halves in the official app's order.
 */
export type RingConfigAction =
  | "bind"
  | "unbind"
  | "pair-auth"
  | "targets-glasses"
  | "targets-clear"
  | "touch-on"
  | "touch-off"
  | "remove-ring";

export type RingSystemBluetoothState = {
  address: string;
  bonded?: boolean;
  gattConnected?: boolean;
  aclConnected?: boolean;
  name?: string | null;
  error?: string;
};

function activeCommunicator(): any {
  if (!global.isAndroid) return null;
  try {
    return com.faceclaw.app.FaceclawBleCommunicator.getActive();
  } catch {
    return null;
  }
}

/** Null when there is no active glasses session (or on iOS). */
export function getRingSessionStatus(): RingSessionStatus | null {
  const active = activeCommunicator();
  if (!active) return null;
  try {
    return JSON.parse(String(active.getRingStatus())) as RingSessionStatus;
  } catch (error) {
    console.warn(`getRingStatus failed: ${error}`);
    return null;
  }
}

/** Null on iOS or when the query itself fails. */
export function getRingSystemBluetoothState(address: string): RingSystemBluetoothState | null {
  if (!global.isAndroid) return null;
  try {
    const json = com.faceclaw.app.FaceclawBleCommunicator.getSystemBluetoothStateJson(
      Utils.android.getApplicationContext(), address);
    return JSON.parse(String(json)) as RingSystemBluetoothState;
  } catch (error) {
    console.warn(`getSystemBluetoothStateJson failed: ${error}`);
    return null;
  }
}

/** False when there is no session or the command could not be queued. */
export function setGlassesRingLink(action: GlassesRingLinkAction, fallbackAddress: string, fallbackName: string): boolean {
  const active = activeCommunicator();
  if (!active) return false;
  try {
    return Boolean(active.setGlassesRingLink(action, fallbackAddress, fallbackName));
  } catch (error) {
    console.warn(`setGlassesRingLink failed: ${error}`);
    return false;
  }
}

/** A one-line outcome for the UI. */
export function sendRingConfigCommand(action: RingConfigAction, fallbackAddress: string, fallbackName: string): string {
  const active = activeCommunicator();
  if (!active) return "not sent: no glasses session";
  try {
    return String(active.sendRingConfigCommand(action, fallbackAddress, fallbackName));
  } catch (error) {
    console.warn(`sendRingConfigCommand failed: ${error}`);
    return `failed: ${error}`;
  }
}

/**
 * The R1's advertised name, "EVEN R1_" plus the last three address bytes
 * (e.g. FF:AA:F1:F6:7E:28 -> "EVEN R1_F67E28"). The glasses store it with the
 * ring's MAC when told to connect.
 */
export function defaultRingName(address: string): string {
  const hex = address.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  return hex.length === 12 ? `EVEN R1_${hex.slice(6)}` : "";
}
