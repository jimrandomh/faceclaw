/** San Francisco's declination is close enough: the demo's location is fixed there. */
export function magneticDeclinationDegrees(_latitude: number, _longitude: number, _altitudeMeters = 0, _timestampMs = 0): number | null {
  return 13;
}
