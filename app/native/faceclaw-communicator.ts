import { Utils } from "@nativescript/core";

declare const com: any;

export type CommunicatorPhase =
  | "disconnected"
  | "connecting"
  | "connected"
  | "retrying"
  | "disconnecting";

export type CommunicatorState = {
  phase: CommunicatorPhase;
  status: string;
};

export type HeadsetBatteryState = {
  battery: number;
  chargingStatus: number;
};

export type RawInputEvent =
  | {
      kind: "list-click";
      containerName: string;
      eventType: number;
      eventSource: number;
      systemExitReasonCode: number;
    }
  | {
      kind: "text-click";
      containerName: string;
      eventType: number;
      eventSource: number;
      systemExitReasonCode: number;
    }
  | {
      kind: "sys-event";
      containerName: string;
      eventType: number;
      eventSource: number;
      systemExitReasonCode: number;
    };

function toJavaByteArray(bytes: Uint8Array): number[] {
  const out = Array.create("byte", bytes.length) as number[];
  for (let i = 0; i < bytes.length; i++) {
    const value = bytes[i]!;
    out[i] = value > 127 ? value - 256 : value;
  }
  return out;
}

export class FaceclawCommunicatorBridge {
  private readonly communicator: any;
  private readonly listenerProxy: any;
  private readonly logListeners = new Set<(line: string) => void>();
  private readonly stateListeners = new Set<(state: CommunicatorState) => void>();
  private readonly ringListeners = new Set<(event: RawInputEvent) => void>();
  private readonly batteryListeners = new Set<(state: HeadsetBatteryState) => void>();
  private readonly evenAppConflictListeners = new Set<(message: string) => void>();

  constructor(addresses: { right: string; left: string; ring?: string }) {
    const context = Utils.android.getApplicationContext();
    if (!context) throw new Error("Android application context unavailable");

    this.communicator = new com.faceclaw.app.FaceclawBleCommunicator(
      context,
      addresses.right,
      addresses.left,
      addresses.ring ?? "",
    );
    this.listenerProxy = new com.faceclaw.app.FaceclawBleCommunicatorListener({
      onLog: (line: string) => {
        for (const listener of this.logListeners) {
          listener(String(line));
        }
      },
      onStateChange: (phase: string, status: string) => {
        const state = {
          phase: String(phase) as CommunicatorPhase,
          status: String(status),
        };
        for (const listener of this.stateListeners) {
          listener(state);
        }
      },
      onRingEvent: (
        kind: string,
        containerName: string,
        eventType: number,
        eventSource: number,
        systemExitReasonCode: number,
      ) => {
        const event = {
          kind: String(kind) as RawInputEvent["kind"],
          containerName: String(containerName),
          eventType: Number(eventType),
          eventSource: Number(eventSource),
          systemExitReasonCode: Number(systemExitReasonCode),
        };
        for (const listener of this.ringListeners) {
          listener(event);
        }
      },
      onBatteryState: (headsetBattery: number, headsetCharging: number) => {
        const state = {
          battery: Number(headsetBattery),
          chargingStatus: Number(headsetCharging),
        };
        for (const listener of this.batteryListeners) {
          listener(state);
        }
      },
      onEvenAppConflict: (message: string) => {
        for (const listener of this.evenAppConflictListeners) {
          listener(String(message));
        }
      },
    });
    this.communicator.setListener(this.listenerProxy);
  }

  onLog(listener: (line: string) => void): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  onStateChange(listener: (state: CommunicatorState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onRingEvent(listener: (event: RawInputEvent) => void): () => void {
    this.ringListeners.add(listener);
    return () => this.ringListeners.delete(listener);
  }

  onBatteryState(listener: (state: HeadsetBatteryState) => void): () => void {
    this.batteryListeners.add(listener);
    return () => this.batteryListeners.delete(listener);
  }

  onEvenAppConflict(listener: (message: string) => void): () => void {
    this.evenAppConflictListeners.add(listener);
    return () => this.evenAppConflictListeners.delete(listener);
  }

  async start(): Promise<void> {
    this.communicator.start();
  }

  async submitDashboardImage(tileBmps: Uint8Array[], fingerprint: string): Promise<void> {
    if (tileBmps.length !== 4) {
      throw new Error(`expected 4 dashboard tiles, got ${tileBmps.length}`);
    }
    this.communicator.submitDashboardImage4(
      toJavaByteArray(tileBmps[0]!),
      toJavaByteArray(tileBmps[1]!),
      toJavaByteArray(tileBmps[2]!),
      toJavaByteArray(tileBmps[3]!),
      fingerprint,
    );
  }

  async disconnect(): Promise<void> {
    this.communicator.disconnect();
  }

  async sendShutdown(exitMode = 0): Promise<boolean> {
    return Boolean(this.communicator.sendShutdown(exitMode));
  }

  async close(): Promise<void> {
    this.communicator.close();
  }
}
