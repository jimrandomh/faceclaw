export type CurrentLocation = {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  timestampMs: number;
};

export type TrackedLocation = {
  latitude: number;
  longitude: number;
  /** Meters, or null when the fix doesn't report accuracy. */
  accuracyMeters: number | null;
  /** Degrees clockwise from true north, or null (common when stationary). */
  bearingDeg: number | null;
  /** Meters per second, or null. */
  speedMps: number | null;
  timestampMs: number;
};

export type LocationTrackerCallbacks = {
  onLocation: (location: TrackedLocation) => void;
  onError: (message: string) => void;
};
