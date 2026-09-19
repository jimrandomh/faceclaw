/**
 * Continuous GPS updates for navigation, backed by the Java
 * FaceclawLocationTracker. Usable from any isolate; callbacks arrive on the
 * calling isolate's own thread (the tracker captures the constructing
 * thread's Looper).
 */
import { Utils } from "@nativescript/core";

declare const com: any;
declare const global: any;

import { type LocationTrackerCallbacks } from "./location-types";
export { type LocationTrackerCallbacks, type TrackedLocation } from "./location-types";

export class LocationTracker {
  private tracker: any = null;
  private running = false;

  constructor(private readonly callbacks: LocationTrackerCallbacks) {}

  isRunning(): boolean {
    return this.running;
  }

  start(intervalMs = 1000): void {
    if (!global.isAndroid) {
      this.callbacks.onError("Location tracking is only available on Android.");
      return;
    }
    if (this.running) return;
    const context = Utils.android.getApplicationContext();
    if (!context) {
      this.callbacks.onError("Android application context unavailable.");
      return;
    }
    this.tracker = new com.faceclaw.app.FaceclawLocationTracker(context);
    const listener = new com.faceclaw.app.FaceclawLocationTrackerListener({
      onLocation: (
        latitude: number,
        longitude: number,
        accuracyMeters: number,
        bearingDeg: number,
        speedMps: number,
        timestampMs: number,
      ) => {
        if (!this.running) return;
        this.callbacks.onLocation({
          latitude: Number(latitude),
          longitude: Number(longitude),
          accuracyMeters: Number(accuracyMeters) >= 0 ? Number(accuracyMeters) : null,
          bearingDeg: Number(bearingDeg) >= 0 ? Number(bearingDeg) : null,
          speedMps: Number(speedMps) >= 0 ? Number(speedMps) : null,
          timestampMs: Number(timestampMs),
        });
      },
      onError: (message: string) => {
        if (!this.running) return;
        this.callbacks.onError(String(message));
      },
    });
    // The Java tracker retains the listener proxy for the stream's lifetime.
    this.tracker.setListener(listener);
    this.running = true;
    this.tracker.start(intervalMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    try {
      this.tracker?.stop();
      this.tracker?.setListener(null);
    } catch (error) {
      console.warn(`location tracker stop failed: ${error}`);
    }
    this.tracker = null;
  }
}
