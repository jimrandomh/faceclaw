import { Utils } from "@nativescript/core";

declare const com: any;

import type { FlashState, FlashProgress } from "../g2/firmware-types";
export type { FlashState, FlashProgress } from "../g2/firmware-types";

/**
 * TS wrapper around the native FaceclawFirmwareFlasher — streams a verified
 * custom-firmware image to both lenses over the stock OTA BLE protocol.
 */
export class FirmwareFlasher {
  private readonly flasher: any;
  private readonly listenerProxy: any;
  private readonly logListeners = new Set<(line: string) => void>();
  private readonly progressListeners = new Set<(progress: FlashProgress) => void>();
  private readonly stateListeners = new Set<(state: FlashState, detail: string) => void>();
  private readonly completeListeners = new Set<(success: boolean, detail: string) => void>();

  constructor(addresses: { right: string; left: string }, firmwarePath: string) {
    const context = Utils.android.getApplicationContext();
    if (!context) throw new Error("Android application context unavailable");

    this.flasher = new com.faceclaw.app.FaceclawFirmwareFlasher(
      context,
      addresses.right,
      addresses.left,
      firmwarePath,
    );
    this.listenerProxy = new com.faceclaw.app.FaceclawFirmwareFlasherListener({
      onLog: (line: string) => this.emit(this.logListeners, String(line)),
      onProgress: (
        lens: string,
        componentIndex: number,
        componentCount: number,
        blockIndex: number,
        blockCount: number,
        bytesSent: number,
        bytesTotal: number,
      ) =>
        this.emit(this.progressListeners, {
          lens: String(lens),
          componentIndex: Number(componentIndex),
          componentCount: Number(componentCount),
          blockIndex: Number(blockIndex),
          blockCount: Number(blockCount),
          bytesSent: Number(bytesSent),
          bytesTotal: Number(bytesTotal),
        }),
      onState: (state: string, detail: string) =>
        this.emit(this.stateListeners, String(state) as FlashState, String(detail ?? "")),
      onComplete: (success: boolean, detail: string) =>
        this.emit(this.completeListeners, Boolean(success), String(detail ?? "")),
    });
    this.flasher.setListener(this.listenerProxy);
  }

  onLog(listener: (line: string) => void): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  onProgress(listener: (progress: FlashProgress) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  onStateChange(listener: (state: FlashState, detail: string) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onComplete(listener: (success: boolean, detail: string) => void): () => void {
    this.completeListeners.add(listener);
    return () => this.completeListeners.delete(listener);
  }

  start(): void {
    this.flasher.start();
  }

  cancel(): void {
    this.flasher.cancel();
  }

  close(): void {
    this.flasher.close();
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
