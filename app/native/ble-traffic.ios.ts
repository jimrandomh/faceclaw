export type { BleTrafficSample } from './ble-traffic'
declare const FaceclawKitIosBleTraffic: any

// The Kotlin counters reset on every sample; accumulate here so callers see
// running totals like FaceclawBleManager.sampleOutboundTraffic on Android.
// CoreBluetooth has no per-message boundary; messages counts write calls.
const totals = { messages: 0, bytes: 0, frames: 0 }
export function sampleBleTraffic(): { messages: number; bytes: number; frames: number } {
  const sample = FaceclawKitIosBleTraffic.shared.sample()
  const written = Number(sample.getIndex(0)), frames = Number(sample.getIndex(2))
  totals.bytes += written
  totals.frames += frames
  if (written > 0) totals.messages++
  return { ...totals }
}
