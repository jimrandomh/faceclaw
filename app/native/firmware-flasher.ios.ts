import { Application } from '@nativescript/core'
import { StockConnection } from '../g2/stock-connection'
import { flashLensImage, validateFirmware } from '../g2/firmware-ota'
import { CFW_PATCH_SET } from '../g2/firmware/cfw-patches'
import { firmwareSha256, readFirmwareFile } from './firmware-files.ios'
import { iosBluetooth } from './ios-bluetooth'
import type { FlashState, FlashProgress } from './firmware-flasher'
export type { FlashState, FlashProgress } from './firmware-flasher'

export class FirmwareFlasher {
  private logs = new Set<(line: string) => void>()
  private states = new Set<(state: FlashState, detail: string) => void>()
  private progresses = new Set<(value: FlashProgress) => void>()
  private completes = new Set<(success: boolean, detail: string) => void>()
  private link = new StockConnection(iosBluetooth(), line => this.log(line))
  private started = false
  private cancelled = false
  private sleeps = new Set<() => void>()
  private foregroundError = ''
  constructor(private addresses: { right: string; left: string }, private path: string) {}
  onLog(fn: (line: string) => void): () => void { this.logs.add(fn); return () => this.logs.delete(fn) }
  onStateChange(fn: (state: FlashState, detail: string) => void): () => void { this.states.add(fn); return () => this.states.delete(fn) }
  onProgress(fn: (value: FlashProgress) => void): () => void { this.progresses.add(fn); return () => this.progresses.delete(fn) }
  onComplete(fn: (success: boolean, detail: string) => void): () => void { this.completes.add(fn); return () => this.completes.delete(fn) }
  private log(line: string): void { for (const fn of this.logs) fn(line) }
  private state(state: FlashState, detail = ''): void { for (const fn of this.states) fn(state, detail) }
  start(): void { if (!this.started) { this.started = true; void this.run() } }
  private readonly backgrounded = () => {
    this.foregroundError = 'Flashing was interrupted because Faceclaw left the foreground. Keep both lenses charged, return to Faceclaw, and retry both lenses.'
    this.cancel()
  }
  private async run(): Promise<void> {
    const previousIdle = UIApplication.sharedApplication.idleTimerDisabled
    UIApplication.sharedApplication.idleTimerDisabled = true
    Application.on(Application.suspendEvent, this.backgrounded)
    let success = false, detail = ''
    try {
      this.link.check()
      if (UIApplication.sharedApplication.applicationState !== UIApplicationState.Active) throw new Error('Keep Faceclaw open on the iPhone while flashing.')
      this.state('validating')
      const image = readFirmwareFile(this.path)
      const hash = firmwareSha256(image.buffer)
      if (![CFW_PATCH_SET.outputSha256, CFW_PATCH_SET.baseSha256].includes(hash)) throw new Error('Prepared firmware failed SHA-256 verification. Prepare the firmware again before flashing.')
      const segments = validateFirmware(image)
      await this.link.resolve({ ...this.addresses, ring: '' })
      for (const role of ['left', 'right']) {
        if (role === 'right') {
          this.state('rebooting', 'Left lens done. Both lenses reboot briefly; reconnecting for the right lens.')
          await this.delay(5000)
        }
        this.state('connecting', role)
        const deadline = Date.now() + (role === 'left' ? 30_000 : 120_000)
        for (;;) {
          try { await this.link.connect(role, true); await this.link.authenticate(role); break }
          catch (error) { this.link.check(); this.link.disconnect(role); if (Date.now() >= deadline) throw error; await this.delay(2500) }
        }
        await this.delay(2500)
        this.state('flashing', role)
        await flashLensImage(this.link, role, image, segments, value => { for (const fn of this.progresses) fn(value) }, line => this.log(line), ms => this.delay(ms))
        this.link.disconnect(role)
      }
      success = true; detail = 'Both lenses flashed. Your glasses are rebooting.'
    } catch (error) {
      detail = this.foregroundError || (this.cancelled ? 'Cancelled. Retry with both lenses powered on to complete installation.' : String((error as Error).message ?? error))
    } finally {
      Application.off(Application.suspendEvent, this.backgrounded)
      UIApplication.sharedApplication.idleTimerDisabled = previousIdle
      this.link.close()
    }
    this.state(success ? 'done' : 'error', detail)
    for (const fn of this.completes) fn(success, detail)
  }
  private delay(ms: number): Promise<void> {
    this.link.check()
    return new Promise((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); this.sleeps.delete(cancel); reject(new Error('Cancelled.')) }
      const timer = setTimeout(() => { this.sleeps.delete(cancel); resolve() }, ms)
      this.sleeps.add(cancel)
    })
  }
  cancel(): void { this.cancelled = true; this.link.close(); for (const cancel of [...this.sleeps]) cancel() }
  close(): void { this.cancel() }
}
