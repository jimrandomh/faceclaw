/** Native services still outside the current iOS app-screen milestone. */
const unavailable: Record<string, string> = {
  music: 'Media-player integration is not available on iOS yet.',
  transcribe: 'Voice capture and transcription are not available on iOS yet.',
  microphones: 'Glasses microphone capture is not available on iOS yet.',
}
export function iosAppUnavailableReason(appId: string): string | null {
  return unavailable[appId] ?? null
}
