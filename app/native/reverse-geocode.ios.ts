import { type Place } from './location-types'
declare const CLGeocoder: any, CLLocation: any

/** Geocoders with a lookup in flight, held until their callback so collection can't drop it. */
const pending = new Set<any>()

/** The place at a coordinate from Apple's geocoder, or null when it can't name it. */
export function reverseGeocode(latitude: number, longitude: number): Promise<Place | null> {
  return new Promise(resolve => {
    const geocoder = CLGeocoder.new()
    pending.add(geocoder)
    const location = CLLocation.alloc().initWithLatitudeLongitude(latitude, longitude)
    geocoder.reverseGeocodeLocationCompletionHandler(location, (placemarks: any, error: any) => {
      pending.delete(geocoder)
      const placemark = !error && placemarks && placemarks.count ? placemarks.objectAtIndex(0) : null
      resolve(placemark
        ? { locality: placemark.locality ?? '', region: placemark.administrativeArea ?? '', country: placemark.country ?? '' }
        : null)
    })
  })
}
