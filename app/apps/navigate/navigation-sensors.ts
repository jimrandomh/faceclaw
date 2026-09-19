import { type NavigationSensorEvent } from './navigation-sensors-messages'
export { LocationTracker, type TrackedLocation } from '../../native/location-tracker'
export { addCompassListener, setCompassEnabled, COMPASS_CHANGED, type CompassEvent } from '../../native/compass'
import { magneticDeclinationDegrees as calculate } from '../../native/geomagnetic'
let cached: { latitude: number; longitude: number; degrees: number | null } | null = null
export function magneticDeclinationDegrees(latitude: number, longitude: number): number | null {
  if (!cached || Math.abs(latitude - cached.latitude) > 0.5 || Math.abs(longitude - cached.longitude) > 0.5)
    cached = { latitude, longitude, degrees: calculate(latitude, longitude) }
  return cached.degrees
}

/** Android delivers native callbacks directly on the worker's Looper. */
export function handleNavigationSensorEvent(_event: NavigationSensorEvent): void {}
