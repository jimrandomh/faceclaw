import { Utils } from "@nativescript/core";

declare const android: any;

export type PhoneBatteryState = {
  battery: number | null;
  charging: boolean | null;
};

export function readPhoneBatteryState(): PhoneBatteryState {
  if (!global.isAndroid) {
    return { battery: null, charging: null };
  }
  const context = Utils.android.getApplicationContext();
  if (!context) {
    return { battery: null, charging: null };
  }

  const filter = new android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED);
  const intent = context.registerReceiver(null, filter);
  if (!intent) {
    return { battery: null, charging: null };
  }

  const level = Number(intent.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1));
  const scale = Number(intent.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, -1));
  const status = Number(intent.getIntExtra(android.os.BatteryManager.EXTRA_STATUS, -1));
  const charging =
    status === android.os.BatteryManager.BATTERY_STATUS_CHARGING ||
    status === android.os.BatteryManager.BATTERY_STATUS_FULL;

  return {
    battery: level >= 0 && scale > 0 ? Math.round((level * 100) / scale) : null,
    charging,
  };
}
