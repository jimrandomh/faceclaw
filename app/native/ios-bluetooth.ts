import { ApplicationSettings } from '@nativescript/core'
import { identifyIosPeripheral, type IosAdvertisement, type IosDevice } from '../g2/ios-peripheral-identity'
import { hexToBytes } from '../util/hex-util'

declare const FaceclawBluetooth: any
type NativeEvent = { kind: string; id?: number; error?: string; details?: ConnectionDetails; state?: number;
  identifier?: string; characteristic?: string; data?: string; message?: string } & Partial<IosAdvertisement>
export type ConnectionDetails = { characteristics: string[]; maxWrite: number }
export type BluetoothEvent = NativeEvent | { kind: 'device'; device: IosDevice }
type Pending = { resolve: (details: ConnectionDetails) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

/** One central manager per app, with asynchronous main-queue GATT operations. */
export class IosBluetooth {
  private readonly native = FaceclawBluetooth.new()
  private readonly listeners = new Set<(event: BluetoothEvent) => void>()
  private readonly pending = new Map<number, Pending>()
  private readonly advertisements = new Map<string, IosAdvertisement>()
  readonly devices = new Map<string, IosDevice>()
  private requestId = 0
  private scanTimer: ReturnType<typeof setTimeout> | null = null
  state = 0
  scanning = false
  constructor() {
    this.native.eventHandler = (json: string) => {
      try { this.receive(JSON.parse(json)) } catch (error) { console.error(`[ios-ble] ${error}`) }
    }
  }
  onEvent(listener: (event: BluetoothEvent) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener) }
  }
  private emit(event: BluetoothEvent): void { for (const listener of [...this.listeners]) listener(event) }
  private receive(event: NativeEvent): void {
    if (event.kind === 'completion') {
      const pending = this.pending.get(event.id!)
      if (pending) {
        this.pending.delete(event.id!); clearTimeout(pending.timer)
        if (event.error) pending.reject(new Error(event.error)); else pending.resolve(event.details!)
      }
      return
    }
    if (event.kind === 'state') this.state = event.state!
    if (event.kind === 'advertisement') {
      const previous = this.advertisements.get(event.identifier!)
      const raw: IosAdvertisement = { identifier: event.identifier!, name: event.name || previous?.name || '',
        manufacturerData: event.manufacturerData || previous?.manufacturerData || '', rssi: event.rssi!, connectable: event.connectable !== false }
      // Bound the cache even in a crowded radio environment.
      if (this.advertisements.size >= 512 && !this.advertisements.has(raw.identifier)) this.advertisements.delete(this.advertisements.keys().next().value!)
      this.advertisements.set(raw.identifier, raw)
      const device = identifyIosPeripheral(raw)
      if (device) {
        this.devices.set(device.address, device)
        ApplicationSettings.setString(`ios.ble.peripheral.${device.address}`, JSON.stringify({ identifier: device.identifier, role: device.role }))
        this.emit({ kind: 'device', device })
      }
      return
    }
    this.emit(event)
  }
  ensureReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); off(); error ? reject(error) : resolve() }
      const off = this.onEvent(event => {
        if (event.kind !== 'state') return
        const state = (event as NativeEvent).state
        if (state === 5) finish()
        else if (state === 2) finish(new Error('Bluetooth is unavailable on this device. Use the physical iPhone.'))
        else if (state === 3) finish(new Error('Allow Faceclaw to use Bluetooth in iPhone Settings.'))
        else if (state === 4) finish(new Error('Turn on Bluetooth, then try again.'))
      })
      const timer = setTimeout(() => finish(new Error('Waiting for Bluetooth permission timed out. Try again after allowing Bluetooth.')), 30_000)
      this.native.initializeBluetooth()
    })
  }
  async startScan(durationMs = 12_000): Promise<void> {
    await this.ensureReady()
    this.stopScan(); this.scanning = true; this.native.scan(true)
    this.scanTimer = setTimeout(() => this.stopScan(), durationMs)
    this.emit({ kind: 'scan-started' })
  }
  stopScan(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer)
    this.scanTimer = null; this.native.scan(false)
    const wasScanning = this.scanning; this.scanning = false
    if (wasScanning) this.emit({ kind: 'scan-stopped' })
  }
  async resolveDevices(addresses: { left: string; right: string; ring: string }): Promise<Record<string, string>> {
    await this.ensureReady()
    const result: Record<string, string> = {}
    for (const role of ['left', 'right', 'ring'] as const) {
      const address = addresses[role]
      if (!address) continue
      const live = this.devices.get(address)
      if (live && live.role !== role) throw new Error(`${address} advertises as ${live.role}, not ${role}. Check Configure devices.`)
      try {
        const saved = JSON.parse(ApplicationSettings.getString(`ios.ble.peripheral.${address}`, '{}'))
        if (saved.role === role && typeof saved.identifier === 'string') result[role] = saved.identifier
      } catch { /* A fresh scan can recover malformed settings. */ }
    }
    const missing = () => (['left', 'right'] as const).filter(role => !result[role])
    if (!missing().length && (!addresses.ring || result.ring)) return result
    await this.startScan(15_000)
    await new Promise<void>((resolve, reject) => {
      const off = this.onEvent(event => {
        if (event.kind === 'device') {
          const device = (event as { device: IosDevice }).device
          for (const role of ['left', 'right', 'ring'] as const) {
            if (addresses[role] === device.address && device.role === role) result[role] = device.identifier
          }
          if (!missing().length && (!addresses.ring || result.ring)) { off(); this.stopScan(); resolve() }
        } else if (event.kind === 'scan-stopped') {
          off()
          if (missing().length) reject(new Error(`Could not find the ${missing().join(' and ')} arm. Wake the glasses, disconnect other apps, and scan again.`))
          else resolve() // An optional missing ring must not block the glasses.
        }
      })
    })
    return result
  }
  private operation(identifier: string, call: (id: number) => void, timeoutMs = 10_000): Promise<ConnectionDetails> {
    const id = ++this.requestId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); this.native.disconnect(identifier)
        reject(new Error('Bluetooth operation timed out. Wake the device and try connecting again.'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { call(id) } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
  connect(identifier: string): Promise<ConnectionDetails> { return this.operation(identifier, id => this.native.connectRequestId(identifier, id), 20_000) }
  async subscribe(identifier: string, characteristic: string): Promise<void> {
    await this.operation(identifier, id => this.native.subscribeCharacteristicRequestId(identifier, characteristic, id))
  }
  async write(identifier: string, characteristic: string, bytes: Uint8Array): Promise<void> {
    const copy = new Uint8Array(bytes)
    const data = NSData.dataWithBytesLength(interop.handleof(copy.buffer), copy.byteLength)
    await this.operation(identifier, id => this.native.writeCharacteristicDataRequestId(identifier, characteristic, data, id))
  }
  disconnect(identifier: string): void { this.native.disconnect(identifier) }
  forget(address: string): void { ApplicationSettings.remove(`ios.ble.peripheral.${address}`); this.devices.delete(address) }
}
let instance: IosBluetooth | null = null
export function iosBluetooth(): IosBluetooth { return instance ??= new IosBluetooth() }
export { hexToBytes }
