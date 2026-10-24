/** Native services still outside the current iOS app-screen milestone. */
const unavailable: Record<string, string> = {
  microphones: 'Glasses microphone capture is not available on iOS yet.',
}
export function iosAppUnavailableReason(appId: string): string | null {
  return unavailable[appId] ?? null
}
