import { iosBluetooth } from './ios-bluetooth'
import { kotlinListener } from './kotlin-listener.ios'
import type { FlashPromptBattery, FlashPromptState } from './flash-prompt-communicator'
export type { FlashPromptBattery, FlashPromptState } from './flash-prompt-communicator'

declare const FaceclawKitIosFlashPrompt: any, FaceclawKitFaceclawFlashPromptListener: any

function normalizePercent(value: number): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * iOS twin of the Android FlashPromptCommunicator wrapper over the shared Kotlin
 * FlashPromptFlow (FaceclawKitIosFlashPrompt): connects and authenticates both arms, shows
 * the pre-flash Yes/No page on the glasses (unless skipPrompt) and reads each arm's battery.
 */
export class FlashPromptCommunicator {
  private communicator: any = null
  private listenerProxy: object | null = null
  private readonly logListeners = new Set<(line: string) => void>()
  private readonly stateListeners = new Set<(state: FlashPromptState, detail: string) => void>()
  private readonly resultListeners = new Set<(approved: boolean) => void>()
  private readonly batteryListeners = new Set<(battery: FlashPromptBattery) => void>()
  private started = false
  private closed = false

  constructor(
    private readonly addresses: { right: string; left: string },
    private readonly warningText: string,
    private readonly options?: { skipPrompt?: boolean },
  ) {}

  onLog(listener: (line: string) => void): () => void {
    this.logListeners.add(listener)
    return () => this.logListeners.delete(listener)
  }

  onStateChange(listener: (state: FlashPromptState, detail: string) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  onBattery(listener: (battery: FlashPromptBattery) => void): () => void {
    this.batteryListeners.add(listener)
    return () => this.batteryListeners.delete(listener)
  }

  onResult(listener: (approved: boolean) => void): () => void {
    this.resultListeners.add(listener)
    return () => this.resultListeners.delete(listener)
  }

  start(): void {
    if (this.started) return
    this.started = true
    void this.run()
  }

  private async run(): Promise<void> {
    let identifiers: Record<string, string>
    try {
      this.emit(this.stateListeners, 'connecting', '')
      identifiers = await iosBluetooth().resolveDevices({ ...this.addresses, ring: '' })
    } catch (error) {
      if (!this.closed) this.emit(this.stateListeners, 'error', String((error as Error).message ?? error))
      return
    }
    if (this.closed) return
    this.communicator = FaceclawKitIosFlashPrompt.alloc().initWithRightAddressLeftAddressWarningTextSkipPrompt(
      identifiers.right ?? '', identifiers.left ?? '', this.warningText, Boolean(this.options?.skipPrompt))
    this.listenerProxy = kotlinListener(FaceclawKitFaceclawFlashPromptListener, {
      onLogLine: (line: string) => this.emit(this.logListeners, String(line ?? '')),
      onStateStateDetail: (state: string, detail: string) =>
        this.emit(this.stateListeners, String(state) as FlashPromptState, String(detail ?? '')),
      onBatteryRightPercentLeftPercent: (rightPercent: number, leftPercent: number) =>
        this.emit(this.batteryListeners, { right: normalizePercent(rightPercent), left: normalizePercent(leftPercent) }),
      onResultApproved: (approved: boolean) => this.emit(this.resultListeners, Boolean(approved)),
    })
    this.communicator.setListenerListener(this.listenerProxy)
    this.communicator.start()
  }

  cancel(): void {
    this.closed = true
    try { this.communicator?.cancel() } catch { /* ignore */ }
  }

  close(): void {
    this.closed = true
    try { this.communicator?.close() } catch { /* ignore */ }
  }

  private emit<A extends unknown[]>(listeners: Set<(...args: A) => void>, ...args: A): void {
    const snapshot = Array.from(listeners)
    setTimeout(() => { for (const listener of snapshot) listener(...args) }, 0)
  }
}
