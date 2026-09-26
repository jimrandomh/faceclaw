import { Application } from '@nativescript/core'
import { CFW_PATCH_SET } from '../g2/firmware/cfw-patches'
import { firmwareSha256, readFirmwareFile } from './firmware-files.ios'
import { iosBluetooth } from './ios-bluetooth'
import { kotlinListener } from './kotlin-listener.ios'
import type { FlashState, FlashProgress } from '../g2/firmware-types'
export type { FlashState, FlashProgress } from '../g2/firmware-types'

declare const FaceclawKitIosFirmwareFlasher: any, FaceclawKitFaceclawFirmwareFlasherListener: any

/**
 * iOS twin of the Android FirmwareFlasher wrapper. The OTA transfer itself is the shared
 * Kotlin OtaFlashFlow over a CoreBluetooth central (FaceclawKitIosFirmwareFlasher); this
 * wrapper keeps the iOS-only policy around it: the image must still hash to the prepared
 * custom (or pinned stock) firmware, the phone must stay in the foreground with the screen
 * awake, and MAC addresses are mapped to peripheral identifiers first.
 */
export class FirmwareFlasher {
  private flasher: any = null
  private listenerProxy: object | null = null
  private readonly logListeners = new Set<(line: string) => void>()
  private readonly progressListeners = new Set<(progress: FlashProgress) => void>()
  private readonly stateListeners = new Set<(state: FlashState, detail: string) => void>()
  private readonly completeListeners = new Set<(success: boolean, detail: string) => void>()
  private started = false
  private finished = false
  private cancelled = false
  private foregroundError = ''
  private previousIdle = false

  constructor(private readonly addresses: { right: string; left: string }, private readonly path: string) {}

  onLog(listener: (line: string) => void): () => void {
    this.logListeners.add(listener)
    return () => this.logListeners.delete(listener)
  }

  onProgress(listener: (progress: FlashProgress) => void): () => void {
    this.progressListeners.add(listener)
    return () => this.progressListeners.delete(listener)
  }

  onStateChange(listener: (state: FlashState, detail: string) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  onComplete(listener: (success: boolean, detail: string) => void): () => void {
    this.completeListeners.add(listener)
    return () => this.completeListeners.delete(listener)
  }

  start(): void {
    if (this.started) return
    this.started = true
    void this.run()
  }

  private readonly backgrounded = () => {
    this.foregroundError = 'Flashing was interrupted because Faceclaw left the foreground. Keep both lenses charged, return to Faceclaw, and retry both lenses.'
    this.cancel()
  }

  private async run(): Promise<void> {
    this.previousIdle = UIApplication.sharedApplication.idleTimerDisabled
    UIApplication.sharedApplication.idleTimerDisabled = true
    Application.on(Application.suspendEvent, this.backgrounded)
    try {
      if (UIApplication.sharedApplication.applicationState !== UIApplicationState.Active) throw new Error('Keep Faceclaw open on the iPhone while flashing.')
      this.emit(this.stateListeners, 'validating', '')
      const image = readFirmwareFile(this.path)
      const hash = firmwareSha256(image.buffer)
      if (![CFW_PATCH_SET.outputSha256, CFW_PATCH_SET.baseSha256].includes(hash)) throw new Error('Prepared firmware failed SHA-256 verification. Prepare the firmware again before flashing.')
      const identifiers = await iosBluetooth().resolveDevices({ ...this.addresses, ring: '' })
      if (this.cancelled) throw new Error('Cancelled.')
      this.flasher = FaceclawKitIosFirmwareFlasher.alloc().initWithRightAddressLeftAddressFirmwarePath(identifiers.right ?? '', identifiers.left ?? '', this.path)
      this.listenerProxy = kotlinListener(FaceclawKitFaceclawFirmwareFlasherListener, {
        onLogLine: (line: string) => this.emit(this.logListeners, String(line ?? '')),
        onProgressLensComponentIndexComponentCountBlockIndexBlockCountBytesSentBytesTotal: (
          lens: string, componentIndex: number, componentCount: number, blockIndex: number, blockCount: number, bytesSent: number, bytesTotal: number,
        ) => this.emit(this.progressListeners, {
          lens: String(lens ?? ''), componentIndex: Number(componentIndex), componentCount: Number(componentCount),
          blockIndex: Number(blockIndex), blockCount: Number(blockCount), bytesSent: Number(bytesSent), bytesTotal: Number(bytesTotal),
        }),
        onStateStateDetail: (state: string, detail: string) => {
          // The terminal state is reported by finish() so a foreground/cancel reason can replace the detail.
          const name = String(state) as FlashState
          if (name !== 'done' && name !== 'error') this.emit(this.stateListeners, name, String(detail ?? ''))
        },
        onCompleteSuccessDetail: (success: boolean, detail: string) => this.finish(Boolean(success), String(detail ?? '')),
      })
      this.flasher.setListenerListener(this.listenerProxy)
      this.flasher.start()
    } catch (error) {
      this.finish(false, String((error as Error).message ?? error))
    }
  }

  private finish(success: boolean, detail: string): void {
    if (this.finished) return
    this.finished = true
    Application.off(Application.suspendEvent, this.backgrounded)
    UIApplication.sharedApplication.idleTimerDisabled = this.previousIdle
    try { this.flasher?.close() } catch { /* ignore */ }
    const message = success ? detail
      : this.foregroundError || (this.cancelled ? 'Cancelled. Retry with both lenses powered on to complete installation.' : detail)
    this.emit(this.stateListeners, success ? 'done' : 'error', message)
    this.emit(this.completeListeners, success, message)
  }

  cancel(): void {
    this.cancelled = true
    try { this.flasher?.cancel() } catch { /* ignore */ }
    // Before the Kotlin flow exists (validation, address resolution) nothing will report completion.
    if (!this.flasher) this.finish(false, 'Cancelled.')
  }

  close(): void { this.cancel() }

  private emit<A extends unknown[]>(listeners: Set<(...args: A) => void>, ...args: A): void {
    const snapshot = Array.from(listeners)
    setTimeout(() => { for (const listener of snapshot) listener(...args) }, 0)
  }
}
