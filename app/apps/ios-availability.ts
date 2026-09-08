/** Native services still outside the current iOS app-screen milestone. */
const unavailable: Record<string, string> = {
  music: 'Media-player integration is not available on iOS yet.',
  notifications: 'Phone notification integration is not available on iOS yet.',
  transcribe: 'Voice capture and transcription are not available on iOS yet.',
  microphones: 'Glasses microphone capture is not available on iOS yet.',
  compass: 'Glasses compass streaming is not available on iOS yet.',
  navigate: 'Navigation location tracking is not available on iOS yet.',
  weather: 'Weather location access is not available on iOS yet.',
  calendar: 'Calendar access is not available on iOS yet.',
  evenhub: 'Open a local .ehpk file in Files to run an EvenHub app. The EvenHub store is not available on iOS yet.',
}
export function iosAppUnavailableReason(appId: string): string | null {
  return unavailable[appId] ?? null
}
