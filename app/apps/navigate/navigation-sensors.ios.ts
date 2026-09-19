import { type LocationTrackerCallbacks } from '../../native/location-types'
import { type CompassEvent } from '../../native/compass-types'
import { type NavigationSensorEvent, type NavigationSensorRequest } from './navigation-sensors-messages'
export { type TrackedLocation } from '../../native/location-types'
export { COMPASS_CHANGED, type CompassEvent } from '../../native/compass-types'
declare const global: any

const listeners = new Set<(event: CompassEvent) => void>()
const trackers = new Map<number, LocationTracker>()
let nextId = 0
let declination: number | null = null
function send(request: NavigationSensorRequest): void {
  global.postMessage({ type: 'navigation-sensors', request })
}
export class LocationTracker {
  private id = 0
  constructor(private readonly callbacks: LocationTrackerCallbacks) {}
  isRunning(): boolean { return this.id !== 0 }
  start(intervalMs = 1000): void {
    if (this.id) return
    this.id = ++nextId; trackers.set(this.id, this)
    send({ action: 'start', id: this.id, intervalMs })
  }
  stop(): void {
    if (!this.id) return
    const id = this.id; this.id = 0; trackers.delete(id)
    send({ action: 'stop', id })
  }
  receive(event: NavigationSensorEvent): void {
    if (event.kind === 'location') this.callbacks.onLocation(event.location)
    else if (event.kind === 'error') { this.stop(); this.callbacks.onError(event.message) }
  }
}
export function handleNavigationSensorEvent(event: NavigationSensorEvent): void {
  if (event.kind === 'compass') {
    declination = event.declination
    for (const listener of [...listeners]) listener(event.event)
  } else trackers.get(event.id)?.receive(event)
}
export function addCompassListener(listener: (event: CompassEvent) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function setCompassEnabled(enabled: boolean, _owner?: string): void { send({ action: 'compass', enabled }) }
export function magneticDeclinationDegrees(_latitude: number, _longitude: number): number | null { return declination }
