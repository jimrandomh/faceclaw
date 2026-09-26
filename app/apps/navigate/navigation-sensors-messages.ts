import { type TrackedLocation } from '../../native/location-types'
import { type CompassEvent } from '../../native/compass-types'

export type NavigationSensorRequest =
  | { action: 'start'; id: number; intervalMs: number }
  | { action: 'stop'; id: number }
  | { action: 'compass'; enabled: boolean }
export type NavigationSensorEvent =
  | { kind: 'location'; id: number; location: TrackedLocation }
  | { kind: 'error'; id: number; message: string }
  | { kind: 'compass'; event: CompassEvent; declination: number | null }
