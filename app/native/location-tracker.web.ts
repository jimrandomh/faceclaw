import { DEMO_LOCATION } from "../web/demo-data/device";
import { type LocationTrackerCallbacks } from "./location-types";

export { type LocationTrackerCallbacks, type TrackedLocation } from "./location-types";

export class LocationTracker {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly callbacks: LocationTrackerCallbacks) {}

  isRunning(): boolean { return this.timer !== null; }

  start(intervalMs = 1000): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.callbacks.onLocation({
      latitude: DEMO_LOCATION.latitude, longitude: DEMO_LOCATION.longitude, accuracyMeters: 10,
      bearingDeg: null, speedMps: null, timestampMs: Date.now(),
    }), intervalMs);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
