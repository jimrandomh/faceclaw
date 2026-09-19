import type { BleTrafficSample } from '../native/ble-traffic'

/** Shared Android/iOS five-second traffic readout. Poll once per second. */
export class BleBandwidthMeter {
  private history: Array<{ atMs: number; bytes: number; frames: number }> = []
  reset(): void { this.history = [] }
  sample(sample: BleTrafficSample, atMs: number): string {
    const previous = this.history[this.history.length - 1]
    if (previous && (atMs <= previous.atMs || sample.bytes < previous.bytes || sample.frames < previous.frames)) this.reset()
    this.history.push({ atMs, bytes: sample.bytes, frames: sample.frames })
    while (this.history.length && this.history[0]!.atMs < atMs - 5000) this.history.shift()
    let label = `BLE sent: ${formatCount(sample.messages)} messages, ${formatCount(sample.bytes)} bytes`
    const oldest = this.history[0]!, elapsedSec = (atMs - oldest.atMs) / 1000
    if (elapsedSec > 0) {
      const byteDelta = sample.bytes - oldest.bytes, frameDelta = sample.frames - oldest.frames
      label += ` · ${formatByteRate(byteDelta / elapsedSec)}, ${(frameDelta / elapsedSec).toFixed(1)} fps`
      if (frameDelta > 0) label += `, ${formatCount(byteDelta / frameDelta)} B/frame`
    }
    return label
  }
}
function formatCount(value: number): string { return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') }
function formatByteRate(bytesPerSec: number): string {
  if (bytesPerSec >= 1e6) return (bytesPerSec / 1e6).toFixed(2) + ' MB/s'
  if (bytesPerSec >= 1e3) return (bytesPerSec / 1e3).toFixed(1) + ' kB/s'
  return Math.round(bytesPerSec) + ' B/s'
}
