import { Utils } from "@nativescript/core";

import { parseG1FlashResult, type G1FlashResult, type G1Side } from "../g1/flash-plan";

declare const com: any;

/** "restore": Even's firmware back on an arm running g1v0, both of its images. */
export type G1FlashMode = "stock" | "update" | "probe" | "restore";

export type G1FlasherOptions = {
  address: string;
  side: G1Side;
  /** The application core's image. */
  firmwarePath: string;
  /** A restore's network-core image. */
  netCorePath?: string;
  mode: G1FlashMode;
  /** How long to keep trying to reach the arm and pair with it. */
  connectWindowMs: number;
};

/** Removes the phone's pairing with an address, which the glasses no longer use or no longer share. False: this phone can't. */
export function forgetG1Pairing(address: string): boolean {
  const context = Utils.android.getApplicationContext();
  if (!context) return false;
  com.faceclaw.app.FaceclawG1Flasher.forgetPairing(context, address);
  return true;
}

/** TS wrapper around FaceclawG1Flasher: one arm's install, its restore to Even's firmware, or a question about what it runs. */
export class G1Flasher {
  private readonly flasher: any;
  private readonly listenerProxy: any;
  private logListener: ((line: string) => void) | null = null;
  private progressListener: ((bytesSent: number, bytesTotal: number) => void) | null = null;
  private stateListener: ((state: string) => void) | null = null;
  private completion: ((success: boolean, detail: string) => void) | null = null;

  constructor(options: G1FlasherOptions) {
    const context = Utils.android.getApplicationContext();
    if (!context) throw new Error("Android application context unavailable");
    this.flasher = new com.faceclaw.app.FaceclawG1Flasher(
      context, options.address, options.side, options.firmwarePath, options.netCorePath ?? "", options.mode, options.connectWindowMs,
    );
    this.listenerProxy = new com.faceclaw.app.FaceclawFirmwareFlasherListener({
      onLog: (line: string) => this.logListener?.(String(line)),
      onProgress: (_lens: string, _component: number, _components: number, _block: number, _blocks: number, sent: number, total: number) =>
        this.progressListener?.(Number(sent), Number(total)),
      onState: (state: string) => this.stateListener?.(String(state)),
      onComplete: (success: boolean, detail: string) => this.completion?.(Boolean(success), String(detail ?? "")),
    });
    this.flasher.setListener(this.listenerProxy);
  }

  onLog(listener: (line: string) => void): void {
    this.logListener = listener;
  }

  onProgress(listener: (bytesSent: number, bytesTotal: number) => void): void {
    this.progressListener = listener;
  }

  onState(listener: (state: string) => void): void {
    this.stateListener = listener;
  }

  run(): Promise<G1FlashResult> {
    return new Promise((resolve, reject) => {
      this.completion = (success, detail) => {
        this.completion = null;
        if (success) resolve(parseG1FlashResult(detail));
        else reject(new Error(detail || "The install failed."));
      };
      this.flasher.start();
    });
  }

  cancel(): void {
    this.flasher.cancel();
  }

  close(): void {
    this.flasher.close();
  }
}
