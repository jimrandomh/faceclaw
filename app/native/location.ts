import { Utils } from "@nativescript/core";

declare const com: any;

import { type CurrentLocation } from "./location-types";
export { type CurrentLocation } from "./location-types";

/** Resolve one current foreground location using Android's LocationManager. */
export function getCurrentLocation(): Promise<CurrentLocation> {
  if (!global.isAndroid) {
    return Promise.reject(new Error("Weather location is only available on Android."));
  }
  const context = Utils.android.getApplicationContext();
  if (!context) {
    return Promise.reject(new Error("Android application context unavailable."));
  }

  return new Promise<CurrentLocation>((resolve, reject) => {
    const provider = new com.faceclaw.app.FaceclawLocationProvider(context);
    let settled = false;
    const listener = new com.faceclaw.app.FaceclawLocationListener({
      onLocation: (
        latitude: number,
        longitude: number,
        accuracyMeters: number,
        timestampMs: number,
      ) => {
        if (settled) return;
        settled = true;
        provider.setListener(null);
        resolve({
          latitude: Number(latitude),
          longitude: Number(longitude),
          accuracyMeters: Number(accuracyMeters) >= 0 ? Number(accuracyMeters) : null,
          timestampMs: Number(timestampMs),
        });
      },
      onError: (message: string) => {
        if (settled) return;
        settled = true;
        provider.setListener(null);
        reject(new Error(String(message)));
      },
    });
    // Retain the proxy through the Java provider until one terminal callback.
    provider.setListener(listener);
    provider.start();
  });
}
