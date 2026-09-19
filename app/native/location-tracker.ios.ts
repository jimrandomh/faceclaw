import { type LocationTrackerCallbacks } from './location-types'
export { type TrackedLocation, type LocationTrackerCallbacks } from './location-types'
declare const FaceclawLocationUpdates: any

/** Owned by the main-thread iOS sensor host; JSON fixes are relayed to app workers. */
export class LocationTracker {
  private native: any = null
  constructor(private readonly callbacks: LocationTrackerCallbacks) {}
  isRunning(): boolean { return this.native !== null }
  start(intervalMs = 1000): void {
    if (this.native) return
    const native = this.native = FaceclawLocationUpdates.new()
    native.eventHandler = (json: string) => {
      if (this.native !== native) return
      const event = JSON.parse(json)
      if (event.error) { this.stop(); this.callbacks.onError(event.error) }
      else this.callbacks.onLocation(event)
    }
    native.startTracking(intervalMs)
  }
  stop(): void {
    const native = this.native; this.native = null
    native?.stop()
  }
}
