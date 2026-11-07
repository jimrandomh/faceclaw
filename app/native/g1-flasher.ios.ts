import { Application } from '@nativescript/core'
import { parseG1FlashResult, type G1FlashResult } from '../g1/flash-plan'
import { iosBluetooth } from './ios-bluetooth'
import { kotlinListener } from './kotlin-listener.ios'
import type { G1FlasherOptions } from './g1-flasher'
export type { G1FlashMode, G1FlasherOptions } from './g1-flasher'

declare const FaceclawKitIosG1Flasher: any, FaceclawKitFaceclawFirmwareFlasherListener: any

/** CoreBluetooth has no way to remove a pairing; iOS Settings does it, and a stale one does no harm. */
export function forgetG1Pairing(_address: string): void {}

/**
 * iOS twin of the Android G1Flasher: the shared Kotlin G1ArmFlashFlow over a CoreBluetooth central. As with the G2's
 * flasher, the phone must stay in the foreground with the screen awake, and addresses are mapped to peripheral
 * identifiers first.
 */
export class G1Flasher {
  private flasher: any = null
  private listenerProxy: object | null = null
  private logListener: ((line: string) => void) | null = null
  private progressListener: ((bytesSent: number, bytesTotal: number) => void) | null = null
  private stateListener: ((state: string) => void) | null = null
  private previousIdle = false
  private cancelled = false
  private foregroundError = ''

  constructor(private readonly options: G1FlasherOptions) {}

  onLog(listener: (line: string) => void): void { this.logListener = listener }
  onProgress(listener: (bytesSent: number, bytesTotal: number) => void): void { this.progressListener = listener }
  onState(listener: (state: string) => void): void { this.stateListener = listener }

  private readonly backgrounded = () => {
    this.foregroundError = 'The install stopped because Faceclaw left the foreground. Return to Faceclaw and try again.'
    this.cancel()
  }

  run(): Promise<G1FlashResult> {
    this.previousIdle = UIApplication.sharedApplication.idleTimerDisabled
    UIApplication.sharedApplication.idleTimerDisabled = true
    Application.on(Application.suspendEvent, this.backgrounded)
    const restore = () => {
      Application.off(Application.suspendEvent, this.backgrounded)
      UIApplication.sharedApplication.idleTimerDisabled = this.previousIdle
    }
    return new Promise<G1FlashResult>((resolve, reject) => {
      const identifier = iosBluetooth().peripheralIdentifier(this.options.address, this.options.side)
      if (!identifier) throw new Error(`Could not find the ${this.options.side} arm. Keep the glasses in the case with the lid open.`)
      this.flasher = FaceclawKitIosG1Flasher.alloc().initWithAddressSideFirmwarePathModeConnectWindowMs(
        identifier, this.options.side, this.options.firmwarePath, this.options.mode, this.options.connectWindowMs)
      this.listenerProxy = kotlinListener(FaceclawKitFaceclawFirmwareFlasherListener, {
        onLogLine: (line: string) => this.logListener?.(String(line ?? '')),
        onProgressLensComponentIndexComponentCountBlockIndexBlockCountBytesSentBytesTotal: (
          _lens: string, _componentIndex: number, _componentCount: number, _blockIndex: number, _blockCount: number, sent: number, total: number,
        ) => this.progressListener?.(Number(sent), Number(total)),
        onStateStateDetail: (state: string) => this.stateListener?.(String(state)),
        onCompleteSuccessDetail: (success: boolean, detail: string) => {
          if (success) resolve(parseG1FlashResult(String(detail ?? '')))
          else reject(new Error(this.foregroundError || String(detail ?? '') || 'The install failed.'))
        },
      })
      this.flasher.setListenerListener(this.listenerProxy)
      if (this.cancelled) this.flasher.cancel()
      this.flasher.start()
    }).finally(restore)
  }

  cancel(): void {
    this.cancelled = true
    try { this.flasher?.cancel() } catch { /* ignore */ }
  }

  close(): void {
    this.cancel()
    try { this.flasher?.close() } catch { /* ignore */ }
  }
}
