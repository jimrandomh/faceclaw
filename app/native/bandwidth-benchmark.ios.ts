import type { BandwidthBenchmarkStatus } from './bandwidth-benchmark'
export type { BandwidthBenchmarkStatus } from './bandwidth-benchmark'

// The iOS twin of the Android benchmark bridge. iOS has no static active
// communicator, so the preview controller binds its session here on connect
// and unbinds it on close; the run itself is the same shared-Kotlin
// GlassesSessionCore stream as on Android.
type BenchmarkSession = {
  startBandwidthBenchmark(messageSize: number, windowSize: number, durationMs: number, linkMode: number): boolean
  cancelBandwidthBenchmark(): void
  getBandwidthBenchmarkStatus(): string
}
let session: BenchmarkSession | null = null

export function bindBandwidthBenchmarkSession(next: BenchmarkSession | null): void {
  session = next
}

/** Start a run. False if not connected or a run is already active. */
export function startBandwidthBenchmark(messageSize: number, windowSize: number, durationMs: number, linkMode = 0): boolean {
  if (!session) return false
  try {
    return session.startBandwidthBenchmark(
      Math.round(messageSize), Math.round(windowSize), Math.round(durationMs), Math.round(linkMode))
  } catch (error) {
    console.warn(`startBandwidthBenchmark failed: ${error}`)
    return false
  }
}

/** Cancel an in-progress run. Safe to call when idle. */
export function cancelBandwidthBenchmark(): void {
  try {
    session?.cancelBandwidthBenchmark()
  } catch (error) {
    console.warn(`cancelBandwidthBenchmark failed: ${error}`)
  }
}

/** Status of the current or most recent run; null when not connected. */
export function getBandwidthBenchmarkStatus(): BandwidthBenchmarkStatus | null {
  if (!session) return null
  try {
    return JSON.parse(session.getBandwidthBenchmarkStatus()) as BandwidthBenchmarkStatus
  } catch (error) {
    console.warn(`getBandwidthBenchmarkStatus failed: ${error}`)
    return null
  }
}
