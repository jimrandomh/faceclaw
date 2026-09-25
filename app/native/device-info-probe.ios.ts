import { iosBluetooth } from './ios-bluetooth'
import { kotlinListener } from './kotlin-listener.ios'
import type { DeviceInfo, DeviceInfoState } from './device-info-probe'
export type { DeviceInfo, DeviceInfoState } from './device-info-probe'

declare const FaceclawKitIosDeviceInfoProbe: any, FaceclawKitFaceclawDeviceInfoProbeListener: any

/**
 * iOS twin of the Android DeviceInfoProbe wrapper: the shared Kotlin DeviceInfoProbeFlow
 * runs over a CoreBluetooth central (FaceclawKitIosDeviceInfoProbe); TypeScript only maps
 * the stored MAC addresses to peripheral identifiers first. Callbacks arrive on the main
 * queue and are fanned out asynchronously like the Android wrapper does.
 */
export class DeviceInfoProbe {
  private probe: any = null
  private listenerProxy: object | null = null
  private readonly logListeners = new Set<(line: string) => void>()
  private readonly stateListeners = new Set<(state: DeviceInfoState, detail: string) => void>()
  private settled = false
  private cancelled = false
  private resolveFn: ((info: DeviceInfo) => void) | null = null
  private rejectFn: ((error: Error) => void) | null = null

  constructor(private readonly rightAddress: string, private readonly leftAddress = '') {}

  onLog(listener: (line: string) => void): () => void {
    this.logListeners.add(listener)
    return () => this.logListeners.delete(listener)
  }

  onStateChange(listener: (state: DeviceInfoState, detail: string) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  run(): Promise<DeviceInfo> {
    return new Promise<DeviceInfo>((resolve, reject) => {
      this.resolveFn = resolve
      this.rejectFn = reject
      void this.start()
    })
  }

  private async start(): Promise<void> {
    let identifiers: Record<string, string>
    try {
      this.emit(this.stateListeners, 'connecting', 'right')
      identifiers = await iosBluetooth().resolveDevices({ right: this.rightAddress, left: this.leftAddress, ring: '' })
    } catch (error) {
      this.settle(error instanceof Error ? error : new Error(String(error)), null)
      return
    }
    if (this.cancelled) { this.settle(new Error('Cancelled.'), null); return }
    this.probe = FaceclawKitIosDeviceInfoProbe.alloc().initWithRightAddressLeftAddress(identifiers.right ?? '', identifiers.left ?? '')
    this.listenerProxy = kotlinListener(FaceclawKitFaceclawDeviceInfoProbeListener, {
      onLogLine: (line: string) => this.emit(this.logListeners, String(line ?? '')),
      onStateStateDetail: (state: string, detail: string) =>
        this.emit(this.stateListeners, String(state) as DeviceInfoState, String(detail ?? '')),
      onResultLeftVersionRightVersionExtension: (leftVersion: string, rightVersion: string, extension: string) =>
        this.settle(null, { leftVersion: String(leftVersion ?? ''), rightVersion: String(rightVersion ?? ''), extension: String(extension ?? '') }),
      onErrorMessage: (message: string) => this.settle(new Error(String(message ?? '')), null),
    })
    this.probe.setListenerListener(this.listenerProxy)
    this.probe.start()
  }

  cancel(): void {
    this.cancelled = true
    try { this.probe?.cancel() } catch { /* ignore */ }
  }

  close(): void {
    this.cancelled = true
    try { this.probe?.close() } catch { /* ignore */ }
  }

  private settle(error: Error | null, info: DeviceInfo | null): void {
    if (this.settled) return
    this.settled = true
    this.close()
    if (error) this.rejectFn?.(error)
    else if (info) this.resolveFn?.(info)
  }

  private emit<A extends unknown[]>(listeners: Set<(...args: A) => void>, ...args: A): void {
    const snapshot = Array.from(listeners)
    setTimeout(() => { for (const listener of snapshot) listener(...args) }, 0)
  }
}
