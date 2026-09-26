import { ApplicationSettings } from '@nativescript/core'
import { identifyIosPeripheral, type IosAdvertisement, type IosDevice } from '../g2/ios-peripheral-identity'
import { hexToBytes } from '../util/hex-util'
import { kotlinListener } from './kotlin-listener.ios'

declare const FaceclawKitIosBleCentral: any, FaceclawKitIosProtocolPlatform: any, FaceclawKitIosBleScanListener: any

/** CBManagerState raw values reported by the Kotlin central. */
export const BLE_STATE_UNSUPPORTED = 2, BLE_STATE_UNAUTHORIZED = 3, BLE_STATE_POWERED_OFF = 4, BLE_STATE_POWERED_ON = 5

export type BluetoothEvent =
  | { kind: 'state'; state: number; authorization: number }
  | { kind: 'advertisement'; identifier: string; name: string; manufacturerData: string; rssi: number; connectable: boolean }
  | { kind: 'device'; device: IosDevice }
  | { kind: 'scan-started' }
  | { kind: 'scan-stopped' }

/**
 * Scanning and MAC-address-to-identifier resolution over the shared Kotlin CoreBluetooth
 * central (FaceclawKitIosBleCentral). GATT sessions no longer pass through here: the
 * session and stock-firmware flows own their own Kotlin centrals. What stays in TypeScript
 * is the Even classification of advertisements and the persisted identifier map, which the
 * Android address model (MACs) needs on iOS.
 */
export class IosBluetooth {
  private readonly native = FaceclawKitIosBleCentral.alloc().initWithPlatform(FaceclawKitIosProtocolPlatform.shared)
  private readonly listeners = new Set<(event: BluetoothEvent) => void>()
  readonly devices = new Map<string, IosDevice>()
  private scanTimer: ReturnType<typeof setTimeout> | null = null
  private scanGeneration = 0
  private readonly scanListener: object
  state = 0
  authorization = 0
  scanning = false
  constructor() {
    this.scanListener = kotlinListener(FaceclawKitIosBleScanListener, {
      onBluetoothStateStateAuthorization: (state: number, authorization: number) => {
        this.state = Number(state); this.authorization = Number(authorization)
        this.emit({ kind: 'state', state: this.state, authorization: this.authorization })
      },
      onAdvertisementIdentifierNameManufacturerDataHexRssiConnectable: (identifier: string, name: string, manufacturerData: string, rssi: number, connectable: boolean) => {
        // The Kotlin central already merges split advertisements and bounds its cache.
        const raw: IosAdvertisement = { identifier: String(identifier), name: String(name ?? ''), manufacturerData: String(manufacturerData ?? ''), rssi: Number(rssi), connectable: connectable !== false }
        this.emit({ kind: 'advertisement', ...raw })
        const device = identifyIosPeripheral(raw)
        if (device) {
          this.devices.set(device.address, device)
          ApplicationSettings.setString(`ios.ble.peripheral.${device.address}`, JSON.stringify({ identifier: device.identifier, role: device.role }))
          this.emit({ kind: 'device', device })
        }
      },
    })
    this.native.setScanListenerListener(this.scanListener)
  }
  onEvent(listener: (event: BluetoothEvent) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener) }
  }
  private emit(event: BluetoothEvent): void { for (const listener of [...this.listeners]) listener(event) }
  /** Creates the central (first use shows the Bluetooth permission prompt) without blocking the JS thread. */
  private ensureCentral(): void {
    // A zero timeout returns immediately after creating the central; the state arrives
    // through the scan listener on the main queue.
    this.native.waitForPoweredOnTimeoutMs(0)
  }
  ensureReady(): Promise<void> {
    if (this.state === BLE_STATE_POWERED_ON) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); off(); error ? reject(error) : resolve() }
      const off = this.onEvent(event => {
        if (event.kind !== 'state') return
        if (event.state === BLE_STATE_POWERED_ON) finish()
        else if (event.state === BLE_STATE_UNSUPPORTED) finish(new Error('Bluetooth is unavailable on this device. Use the physical iPhone.'))
        else if (event.state === BLE_STATE_UNAUTHORIZED) finish(new Error('Allow Faceclaw to use Bluetooth in iPhone Settings.'))
        else if (event.state === BLE_STATE_POWERED_OFF) finish(new Error('Turn on Bluetooth, then try again.'))
      })
      const timer = setTimeout(() => finish(new Error('Waiting for Bluetooth permission timed out. Try again after allowing Bluetooth.')), 30_000)
      this.ensureCentral()
    })
  }
  async startScan(durationMs = 12_000): Promise<void> {
    this.stopScan()
    const generation = this.scanGeneration
    await this.ensureReady()
    if (generation !== this.scanGeneration) throw new Error('Bluetooth scan cancelled')
    this.scanning = true; this.native.startScan()
    this.scanTimer = setTimeout(() => this.stopScan(), durationMs)
    this.emit({ kind: 'scan-started' })
  }
  stopScan(): void {
    ++this.scanGeneration
    if (this.scanTimer) clearTimeout(this.scanTimer)
    this.scanTimer = null
    const wasScanning = this.scanning; this.scanning = false
    if (wasScanning) { this.native.stopScan(); this.emit({ kind: 'scan-stopped' }) }
  }
  /** Peripheral identifiers for the stored MAC addresses, scanning for any that are not remembered. */
  async resolveDevices(addresses: { left: string; right: string; ring: string }): Promise<Record<string, string>> {
    const generation = this.scanGeneration
    await this.ensureReady()
    if (generation !== this.scanGeneration) throw new Error('Bluetooth connection cancelled')
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
          const device = event.device
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
  forget(address: string): void { ApplicationSettings.remove(`ios.ble.peripheral.${address}`); this.devices.delete(address) }
}
let instance: IosBluetooth | null = null
export function iosBluetooth(): IosBluetooth { return instance ??= new IosBluetooth() }
export { hexToBytes }
