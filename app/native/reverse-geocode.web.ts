import { DEMO_LOCATION } from "../web/demo-data/device";
import { type Place } from "./location-types";

export async function reverseGeocode(_latitude: number, _longitude: number): Promise<Place | null> {
  return DEMO_LOCATION.place;
}
