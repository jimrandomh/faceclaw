import { iosBluetooth } from './ios-bluetooth'
import type { DiscoveryEvents } from './device-discovery'
import type { RawAdvertisement } from '../g2/even-advertisement'
export { buildAddressSet } from './device-discovery-common'

export class DeviceDiscoveryBridge {
  private ble = iosBluetooth()
  private off: (() => void) | null = null
  private generation = 0
  private cancelCollection: (() => void) | null = null
  get bluetoothEnabled(): boolean { return this.ble.state === 5 }
  get scanning(): boolean { return !!this.off && this.ble.scanning }
  startScan(events: DiscoveryEvents): boolean {
    this.stopScan()
    const generation = this.generation
    if (!this.bluetoothEnabled) return false
    this.off = this.ble.onEvent(event => {
      if (event.kind === 'device' && 'device' in event) events.onAdvertisement(event.device)
      if (event.kind === 'state' && event.state !== 5) events.onScanFailed?.(event.state ?? 0, 'Bluetooth is unavailable. Turn it on, then tap Scan.')
    })
    void this.ble.startScan(24 * 60 * 60 * 1000).catch(error => {
      if (generation === this.generation) events.onScanFailed?.(-1, String(error.message ?? error))
    })
    return true
  }
  stopScan(): void {
    ++this.generation; this.cancelCollection?.()
    if (this.off) { this.off(); this.off = null; this.ble.stopScan() }
  }
  // CoreBluetooth does not expose the phone's bond list. Fresh advertisements
  // supply both identity and the UUID mapping that iOS needs for connections.
  emitBondedDevices(): void {}
  async getBondedCandidates(): Promise<RawAdvertisement[]> { return [...this.ble.devices.values()] }
  async scanCandidates(timeoutMs = 6000): Promise<RawAdvertisement[]> {
    const generation = this.generation
    await this.ble.ensureReady()
    if (generation !== this.generation) throw new Error('Bluetooth scan cancelled.')
    return new Promise((resolve, reject) => {
      const samples: RawAdvertisement[] = []
      const finish = (error?: Error) => {
        clearTimeout(timer); this.cancelCollection = null; this.stopScan()
        if (error) reject(error); else resolve(samples)
      }
      const timer = setTimeout(() => finish(), timeoutMs)
      if (!this.startScan({ onAdvertisement: sample => samples.push(sample),
        onScanFailed: (_code, message) => finish(new Error(message)) })) {
        finish(new Error('Bluetooth is unavailable.')); return
      }
      this.cancelCollection = () => { this.cancelCollection = null; clearTimeout(timer); reject(new Error('Bluetooth scan cancelled.')) }
    })
  }
}
