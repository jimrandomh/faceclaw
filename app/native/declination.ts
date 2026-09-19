import { magneticDeclinationDegrees } from './geomagnetic'
import { getCurrentLocation } from './location'

export function restoreDeclination(latitude: number, longitude: number, _degrees: number): number | null {
  return magneticDeclinationDegrees(latitude, longitude)
}

export async function getCurrentDeclination(): Promise<{ latitude: number; longitude: number; degrees: number }> {
  const location = await getCurrentLocation()
  const degrees = magneticDeclinationDegrees(location.latitude, location.longitude)
  if (degrees === null) throw new Error('Magnetic declination unavailable')
  return { ...location, degrees }
}
