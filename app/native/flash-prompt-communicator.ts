import { Utils } from "@nativescript/core";

declare const com: any;

export type FlashPromptState =
  | "connecting"
  | "connected"
  | "prompting"
  | "battery"
  | "result"
  | "cancelled"
  | "timeout"
  | "disconnected"
  | "error";

/** Per-arm battery percent; null when that arm didn't answer. */
export type FlashPromptBattery = { right: number | null; left: number | null };

function normalizePercent(value: number): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * TS wrapper around the native FaceclawFlashPromptCommunicator — the
 * stock-firmware-compatible BLE path that shows the pre-flash confirmation on
 * the glasses and reports the user's Yes/No choice. Separate from
 * FaceclawCommunicatorBridge on purpose (different, minimal protocol subset).
 *
 * Connects and authenticates both arms (so any OS pairing prompts happen up
 * front, before flashing), shows the prompt via the right arm (the lenses relay
 * messages between themselves, and acks/events always come from the right
 * arm), then reads each arm's battery. With `skipPrompt` the on-glasses
 * confirmation is omitted and only the battery is read.
 */
export class FlashPromptCommunicator {
  private readonly communicator: any;
  private readonly listenerProxy: any;
  private readonly logListeners = new Set<(line: string) => void>();
  private readonly stateListeners = new Set<(state: FlashPromptState, detail: string) => void>();
  private readonly resultListeners = new Set<(approved: boolean) => void>();
  private readonly batteryListeners = new Set<(battery: FlashPromptBattery) => void>();

  constructor(
    addresses: { right: string; left: string },
    warningText: string,
    options?: { skipPrompt?: boolean },
  ) {
    const context = Utils.android.getApplicationContext();
    if (!context) throw new Error("Android application context unavailable");

    this.communicator = new com.faceclaw.app.FaceclawFlashPromptCommunicator(
      context,
      addresses.right,
      addresses.left,
      warningText,
      Boolean(options?.skipPrompt),
    );
    this.listenerProxy = new com.faceclaw.app.FaceclawFlashPromptListener({
      onLog: (line: string) => this.emit(this.logListeners, String(line)),
      onState: (state: string, detail: string) =>
        this.emit(this.stateListeners, String(state) as FlashPromptState, String(detail ?? "")),
      onBattery: (rightPercent: number, leftPercent: number) =>
        this.emit(this.batteryListeners, {
          right: normalizePercent(rightPercent),
          left: normalizePercent(leftPercent),
        }),
      onResult: (approved: boolean) => this.emit(this.resultListeners, Boolean(approved)),
    });
    this.communicator.setListener(this.listenerProxy);
  }

  onLog(listener: (line: string) => void): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  onStateChange(listener: (state: FlashPromptState, detail: string) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onBattery(listener: (battery: FlashPromptBattery) => void): () => void {
    this.batteryListeners.add(listener);
    return () => this.batteryListeners.delete(listener);
  }

  onResult(listener: (approved: boolean) => void): () => void {
    this.resultListeners.add(listener);
    return () => this.resultListeners.delete(listener);
  }

  start(): void {
    this.communicator.start();
  }

  cancel(): void {
    this.communicator.cancel();
  }

  close(): void {
    this.communicator.close();
  }

  private emit<A extends unknown[]>(listeners: Set<(...args: A) => void>, ...args: A): void {
    const snapshot = Array.from(listeners);
    setTimeout(() => {
      for (const listener of snapshot) {
        listener(...args);
      }
    }, 0);
  }
}
