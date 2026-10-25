/**
 * The live data behind an EvenHub app's device status: glasses presence (fed
 * by the connection controller), the headset battery (from the shell's top
 * bar state), and the paired glasses' serial.
 */
import { shell } from "../../ui/shell/shell";
import { getGlassesPresence, onGlassesPresenceChanged } from "../../g2/glasses-presence";
import { loadPairedGlassesIdentity } from "../../g2/device-addresses";
import { type EvenHubDeviceStatusSource } from "./device-status";

export const liveDeviceStatusSource: EvenHubDeviceStatusSource = {
  read: () => {
    const presence = getGlassesPresence();
    return {
      serial: loadPairedGlassesIdentity()?.serial ?? null,
      connected: presence.connected,
      worn: presence.worn,
      battery: shell.getBatteryLevels().headset,
      charging: presence.charging,
    };
  },
  subscribe: (listener) => {
    const offs = [onGlassesPresenceChanged(listener), shell.onBatteryLevelsChanged(listener)];
    return () => {
      for (const off of offs) off();
    };
  },
};
