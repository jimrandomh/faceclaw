import { Utils } from "@nativescript/core";

import { type Place } from "./location-types";

declare const com: any;

/** The place at a coordinate from Android's Geocoder, or null when the phone can't name it. */
export function reverseGeocode(latitude: number, longitude: number): Promise<Place | null> {
  const context = Utils.android.getApplicationContext();
  if (!context) return Promise.resolve(null);
  return new Promise<Place | null>((resolve) => {
    const geocoder = new com.faceclaw.app.FaceclawReverseGeocoder(context);
    // The lookup thread holds the listener proxy until its one callback.
    geocoder.lookup(latitude, longitude, new com.faceclaw.app.FaceclawReverseGeocoder.Listener({
      onResult: (locality: string | null, region: string | null, country: string | null) => {
        resolve({ locality: locality ? String(locality) : "", region: region ? String(region) : "", country: country ? String(country) : "" });
      },
    }));
  });
}
