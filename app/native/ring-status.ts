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
};

/**
 * EXPERIMENTAL glasses-side ring link control (sid 0x80 pair manager):
 * "disconnect" drops the glasses' ring link, "release" also clears their
 * connect mode (may hold off auto-reconnect), "connect" hands the ring back.
 */
export type GlassesRingLinkAction = "disconnect" | "release" | "connect";

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
