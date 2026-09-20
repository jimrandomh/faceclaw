declare const FaceclawLocation: any

export function restoreDeclination(_latitude: number, _longitude: number, degrees: number): number | null {
  return Number.isFinite(degrees) && Math.abs(degrees) <= 180 ? degrees : null
}

export function getCurrentDeclination(): Promise<{ latitude: number; longitude: number; degrees: number }> {
  return new Promise((resolve, reject) => {
    FaceclawLocation.shared().requestDeclination((degrees: number, latitude: number, longitude: number, error: string) => {
      if (error) reject(new Error(error))
      else resolve({ degrees, latitude, longitude })
    })
  })
}
