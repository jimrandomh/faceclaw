import { demoBatteries } from "../web/demo-data/device";

export type PhoneBatteryState = { battery: number | null; charging: boolean | null };

export function readPhoneBatteryState(): PhoneBatteryState {
  return { battery: demoBatteries.phone, charging: false };
}
