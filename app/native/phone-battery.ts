import { Utils } from "@nativescript/core";

declare const android: any;

export type PhoneBatteryState = {
  battery: number | null;
  charging: boolean | null;
};

// The Android read is a sticky-broadcast binder round trip, and the top bar
// asks on every shell paint; the level moves far slower than that.
const ANDROID_CACHE_MS = 5000;
let cachedState: PhoneBatteryState | null = null;
let cachedAtMs = 0;

export function readPhoneBatteryState(): PhoneBatteryState {
  if (global.isAndroid) {
    const now = Date.now();
    if (cachedState === null || now - cachedAtMs >= ANDROID_CACHE_MS || now < cachedAtMs) {
      cachedState = readPhoneBatteryStateUncached();
      cachedAtMs = now;
    }
    return { ...cachedState };
  }
  return readPhoneBatteryStateUncached();
}

function readPhoneBatteryStateUncached(): PhoneBatteryState {
  if (global.isIOS) {
    const device = UIDevice.currentDevice
    const level = device.batteryLevel
    const state = device.batteryState
    return {
      battery: level >= 0 ? Math.round(level * 100) : null,
      charging: state === UIDeviceBatteryState.Unknown ? null : state === UIDeviceBatteryState.Charging || state === UIDeviceBatteryState.Full,
    }
  }
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
