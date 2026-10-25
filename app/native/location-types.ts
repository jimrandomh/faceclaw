export type CurrentLocation = {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  timestampMs: number;
};

/** A reverse-geocoded place; parts the geocoder doesn't know are empty. */
export type Place = {
  /** City or town. */
  locality: string;
  /** State, province or similar. */
  region: string;
  country: string;
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
