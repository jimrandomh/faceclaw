import { DEMO_LOCATION } from "../web/demo-data/device";
import { type CurrentLocation } from "./location-types";

export { type CurrentLocation } from "./location-types";

/** A fixed place: a demo has no reason to ask a visitor for their location. */
export async function getCurrentLocation(): Promise<CurrentLocation> {
  return { latitude: DEMO_LOCATION.latitude, longitude: DEMO_LOCATION.longitude, accuracyMeters: 10, timestampMs: Date.now() };
}
