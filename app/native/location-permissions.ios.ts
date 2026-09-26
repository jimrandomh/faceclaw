declare const FaceclawLocation: any
export const hasLocationPermission = (): boolean => FaceclawLocation.shared().hasPermission()
export function ensureLocationPermission(): Promise<boolean> {
  return new Promise(resolve => FaceclawLocation.shared().requestPermission(resolve))
}

export function ensureFineLocationPermission(): Promise<boolean> {
  return new Promise(resolve => FaceclawLocation.shared().requestPrecisePermission(resolve))
}
