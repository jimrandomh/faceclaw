/** Pretend hardware: what the status bar and the Glanceboard show in the browser demo. */
export const demoBatteries = { headset: 82, ring: 64, case: 91, phone: 71 };

/** Where the demo "is", for Weather and Compass. No browser location is ever asked for. */
export const DEMO_LOCATION = {
  latitude: 37.7749,
  longitude: -122.4194,
  place: { locality: "San Francisco", region: "California", country: "United States" },
};
