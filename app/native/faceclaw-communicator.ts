import { Utils } from "@nativescript/core";

declare const com: any;

const FRAME_METRICS_LISTENER_MIN_INTERVAL_MS = 5_000;

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

export type FrameMetrics = {
  paintMs: number;
  transmitMs: number;
  tileCount: number;
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

function nonNegativeNumber(value: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

export class FaceclawCommunicatorBridge {
  private readonly communicator: any;
  private readonly listenerProxy: any;
  private javaCallQueue: Promise<void> = Promise.resolve();
  private readonly frameMetricWaiters = new Set<(metrics: FrameMetrics) => void>();
  private readonly logListeners = new Set<(line: string) => void>();
  private readonly stateListeners = new Set<(state: CommunicatorState) => void>();
  private readonly ringListeners = new Set<(event: RawInputEvent) => void>();
  private readonly batteryListeners = new Set<(state: HeadsetBatteryState) => void>();
  private readonly evenAppConflictListeners = new Set<(message: string) => void>();
  private readonly frameMetricsListeners = new Set<(metrics: FrameMetrics) => void>();
  private lastFrameMetricsListenerEmitAtMs = 0;

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
        this.emitAsync(this.logListeners, String(line));
      },
      onStateChange: (phase: string, status: string) => {
        const state = {
          phase: String(phase) as CommunicatorPhase,
          status: String(status),
        };
        this.emitAsync(this.stateListeners, state);
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
        this.emitAsync(this.ringListeners, event);
      },
      onBatteryState: (headsetBattery: number, headsetCharging: number) => {
        const state = {
          battery: Number(headsetBattery),
          chargingStatus: Number(headsetCharging),
        };
        this.emitAsync(this.batteryListeners, state);
      },
      onEvenAppConflict: (message: string) => {
        this.emitAsync(this.evenAppConflictListeners, String(message));
      },
      onFrameMetrics: (paintMs: number, transmitMs: number, tileCount: number) => {
        const metrics = {
          paintMs: nonNegativeNumber(paintMs),
          transmitMs: nonNegativeNumber(transmitMs),
          tileCount: nonNegativeNumber(tileCount),
        };
        const waiters = Array.from(this.frameMetricWaiters);
        this.frameMetricWaiters.clear();
        for (const waiter of waiters) {
          setTimeout(() => waiter(metrics), 0);
        }
        const now = Date.now();
        if (
          this.lastFrameMetricsListenerEmitAtMs === 0 ||
          now - this.lastFrameMetricsListenerEmitAtMs >= FRAME_METRICS_LISTENER_MIN_INTERVAL_MS
        ) {
          this.lastFrameMetricsListenerEmitAtMs = now;
          this.emitAsync(this.frameMetricsListeners, metrics);
        }
      },
    });
    this.communicator.setListener(this.listenerProxy);
  }

  private emitAsync<T>(listeners: Set<(value: T) => void>, value: T): void {
    const snapshot = Array.from(listeners);
    setTimeout(() => {
      for (const listener of snapshot) {
        listener(value);
      }
    }, 0);
  }

  private enqueueJavaCall<T>(operation: () => T): Promise<T> {
    const run = () =>
      new Promise<T>((resolve, reject) => {
        setTimeout(() => {
          try {
            resolve(operation());
          } catch (error) {
            reject(error);
          }
        }, 0);
      });

    const result = this.javaCallQueue.then(run, run);
    this.javaCallQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private withNativeBridgeLock<T>(operation: string, callback: () => T): T {
    this.communicator.acquireNativeBridgeLock(operation);
    try {
      return callback();
    } finally {
      this.communicator.releaseNativeBridgeLock(operation);
    }
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

  onFrameMetrics(listener: (metrics: FrameMetrics) => void): () => void {
    this.frameMetricsListeners.add(listener);
    return () => this.frameMetricsListeners.delete(listener);
  }

  getNativeCommunicator(): any {
    return this.communicator;
  }

  waitForNextFrameMetrics(timeoutMs: number): Promise<FrameMetrics | null> {
    const delayMs = Math.max(1, Math.round(nonNegativeNumber(timeoutMs)));
    return new Promise((resolve) => {
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const complete = (metrics: FrameMetrics | null) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
        }
        this.frameMetricWaiters.delete(onMetrics);
        resolve(metrics);
      };
      const onMetrics = (metrics: FrameMetrics) => complete(metrics);
      this.frameMetricWaiters.add(onMetrics);
      timeoutHandle = setTimeout(() => complete(null), delayMs);
    });
  }

  async start(): Promise<void> {
    await this.enqueueJavaCall(() => this.communicator.start());
  }

  async submitDashboardImage(tileBmps: Uint8Array[], fingerprint: string, forceTiledCommit = false, paintMs = -1): Promise<void> {
    if (tileBmps.length !== 4) {
      throw new Error(`expected 4 dashboard tiles, got ${tileBmps.length}`);
    }
    const tileSnapshots = tileBmps.map((tile) => new Uint8Array(tile));
    await this.enqueueJavaCall(() => {
      this.withNativeBridgeLock("submitDashboardImage4 bridge arrays", () => {
        this.communicator.submitDashboardImage4(
          toJavaByteArray(tileSnapshots[0]!),
          toJavaByteArray(tileSnapshots[1]!),
          toJavaByteArray(tileSnapshots[2]!),
          toJavaByteArray(tileSnapshots[3]!),
          fingerprint,
          forceTiledCommit,
          Math.round(nonNegativeNumber(paintMs)),
        );
      });
    });
  }

  async createPreviewBitmap(colors: number[], width: number, height: number): Promise<any> {
    return this.enqueueJavaCall(() =>
      this.withNativeBridgeLock("createPreviewBitmap bridge", () =>
        this.communicator.createPreviewBitmap(colors, width, height),
      ),
    );
  }

  async createPreviewBitmapWithColorFactory(
    createColors: () => number[],
    width: number,
    height: number,
  ): Promise<any> {
    return this.enqueueJavaCall(() =>
      this.withNativeBridgeLock("createPreviewBitmap bridge colors", () =>
        this.communicator.createPreviewBitmap(createColors(), width, height),
      ),
    );
  }

  async disconnect(): Promise<void> {
    await this.enqueueJavaCall(() => this.communicator.disconnect());
  }

  async sendShutdown(exitMode = 0): Promise<boolean> {
    return this.enqueueJavaCall(() => Boolean(this.communicator.sendShutdown(exitMode)));
  }

  async close(): Promise<void> {
    await this.enqueueJavaCall(() => this.communicator.close());
  }
}
