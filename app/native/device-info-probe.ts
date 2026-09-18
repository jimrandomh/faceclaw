import { Utils } from "@nativescript/core";

import { type FirmwareInfo } from "../g2/firmware-compat";

declare const com: any;

export type DeviceInfo = FirmwareInfo;

export type DeviceInfoState = "connecting" | "authenticating" | "querying";

/**
 * TS wrapper around the native FaceclawDeviceInfoProbe — a one-shot,
 * stock-compatible connect + firmware/device-info read. `run()` resolves with
 * the firmware versions and the firmware-extension string, or rejects on failure.
 */
export class DeviceInfoProbe {
  private readonly probe: any;
  private readonly listenerProxy: any;
  private readonly logListeners = new Set<(line: string) => void>();
  private readonly stateListeners = new Set<(state: DeviceInfoState, detail: string) => void>();

  private settled = false;
  private resolveFn: ((info: DeviceInfo) => void) | null = null;
  private rejectFn: ((error: Error) => void) | null = null;

  constructor(rightAddress: string, leftAddress = "") {
    const context = Utils.android.getApplicationContext();
    if (!context) throw new Error("Android application context unavailable");

    this.probe = new com.faceclaw.app.FaceclawDeviceInfoProbe(context, rightAddress, leftAddress);
    this.listenerProxy = new com.faceclaw.app.FaceclawDeviceInfoProbeListener({
      onLog: (line: string) => this.emit(this.logListeners, String(line)),
      onState: (state: string, detail: string) =>
        this.emit(this.stateListeners, String(state) as DeviceInfoState, String(detail ?? "")),
      onResult: (leftVersion: string, rightVersion: string, extension: string) =>
        this.settle(null, {
          leftVersion: String(leftVersion),
          rightVersion: String(rightVersion),
          extension: String(extension),
        }),
      onError: (message: string) => this.settle(new Error(String(message)), null),
    });
    this.probe.setListener(this.listenerProxy);
  }

  onLog(listener: (line: string) => void): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  onStateChange(listener: (state: DeviceInfoState, detail: string) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  run(): Promise<DeviceInfo> {
    return new Promise<DeviceInfo>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
      this.probe.start();
    });
  }

  cancel(): void {
    try {
      this.probe.cancel();
    } catch {
      // ignore
    }
  }

  close(): void {
    try {
      this.probe.close();
    } catch {
      // ignore
    }
  }

  private settle(error: Error | null, info: DeviceInfo | null): void {
    if (this.settled) return;
    this.settled = true;
    this.close();
    if (error) {
      this.rejectFn?.(error);
    } else if (info) {
      this.resolveFn?.(info);
    }
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
