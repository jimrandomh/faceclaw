import { type CurrentLocation } from './location-types'
export { type CurrentLocation } from './location-types'
declare const FaceclawLocationUpdates: any

/** Main-thread one-shot lookup, independent of navigation and compass managers. */
export function getCurrentLocation(): Promise<CurrentLocation> {
  return new Promise((resolve, reject) => {
    const provider = FaceclawLocationUpdates.new()
    provider.eventHandler = (json: string) => {
      try {
        const event = JSON.parse(json)
        if (event.error) reject(new Error(event.error))
        else resolve(event)
      } catch (error) { reject(error) }
      finally { provider.stop() }
    }
    provider.startOnce()
  })
}
