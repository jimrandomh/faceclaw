import { ImageSource, Utils } from "@nativescript/core";
import * as frameTimings from "./frame-timings";

declare const com: any;

const PREVIEW_BRIGHTEN_GAMMA = 0.7;

export type CommunicatorPhase =
  | "disconnected"
  | "connecting"
  | "connected"
  | "charging"
  | "retrying"
  | "unpaired"
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

export type FirmwareInfo = {
  leftVersion: string;
  rightVersion: string;
  capabilities: string;
};

/**
 * Compositor surface configuration. Position/size are in screen pixels;
 * surfaces composite in ascending zOrder onto a black background. A
 * "color-key" surface treats pixel value 0 as transparent and 1 as black
 * (painters must clamp intentional black to 1); "opaque" surfaces cover
 * their whole rect.
 */
export type SurfaceOptions = {
  x: number;
  y: number;
  width: number;
  height: number;
  zOrder: number;
  transparency: "opaque" | "color-key";
};

export type RawInputEvent =
  | {
      kind: "list-click";
      containerName: string;
      eventType: number;
      eventSource: number;
      systemExitReasonCode: number;
      frameId: number;
    }
  | {
      kind: "text-click";
      containerName: string;
      eventType: number;
      eventSource: number;
      systemExitReasonCode: number;
      frameId: number;
    }
  | {
      kind: "sys-event";
      containerName: string;
      eventType: number;
      eventSource: number;
      systemExitReasonCode: number;
      frameId: number;
    }
  | {
      /**
       * Stock Even AI app (sid 0x07), not EvenHub. `eventType` carries
       * eEvenAIStatus -- see EvenAIStatus in app/g2/events.ts. The only one we
       * act on is EVEN_AI_WAKE_UP, i.e. the "Hey Even" wakeword.
       */
      kind: "even-ai";
      containerName: string;
      eventType: number;
      eventSource: number;
      systemExitReasonCode: number;
      frameId: number;
    }
  | {
      /**
       * Synthetic directional gesture from the Wear OS remote; `eventType` is
       * a WatchGestureType (app/g2/events.ts). Never produced by Java.
       */
      kind: "watch-gesture";
      containerName: string;
      eventType: number;
      eventSource: number;
      systemExitReasonCode: number;
      frameId: number;
    }
  | {
      /**
       * Stock display-lifecycle wake observed after a ring or arm double tap
       * while Faceclaw's EvenHub page is suspended.
       */
      kind: "display-wake";
      containerName: string;
      eventType: number;
      eventSource: number;
      systemExitReasonCode: number;
      frameId: number;
    };

function nonNegativeNumber(value: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

export class FaceclawCommunicatorBridge {
  private readonly communicator: any;
  private readonly listenerProxy: any;
  private javaCallQueue: Promise<void> = Promise.resolve();
  /** Calls waiting on javaCallQueue; 0 means enqueueJavaCall's fast path is safe. */
  private queuedJavaCalls = 0;
  private readonly frameMetricWaiters = new Set<(metrics: FrameMetrics) => void>();
  // Recent frame-finished outcomes from the Java side, so waitForFrameFinished
  // does not race against finishes that land before the wait starts.
  private readonly finishedFrameOutcomes = new Map<number, string>();
  private readonly frameFinishedWaiters = new Map<number, Set<(outcome: string) => void>>();
  private readonly logListeners = new Set<(line: string) => void>();
  private readonly stateListeners = new Set<(state: CommunicatorState) => void>();
  private readonly ringListeners = new Set<(event: RawInputEvent) => void>();
  private readonly batteryListeners = new Set<(state: HeadsetBatteryState) => void>();
  private readonly silentModeListeners = new Set<(silent: boolean) => void>();
  private readonly wearStateListeners = new Set<(wearing: boolean) => void>();
  private readonly phoneLockStateListeners = new Set<(locked: boolean) => void>();
  private latestWearState: boolean | null = null;
  private latestPhoneLockState: boolean | null = null;
  private readonly evenAppConflictListeners = new Set<(message: string) => void>();
  private readonly frameMetricsListeners = new Set<(metrics: FrameMetrics) => void>();
  private readonly firmwareInfoListeners = new Set<(info: FirmwareInfo) => void>();

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
        frameId: number,
      ) => {
        const event = {
          kind: String(kind) as RawInputEvent["kind"],
          containerName: String(containerName),
          eventType: Number(eventType),
          eventSource: Number(eventSource),
          systemExitReasonCode: Number(systemExitReasonCode),
          frameId: Number(frameId),
        };
        frameTimings.logFrame(event.frameId, "input event received on JS side");
        this.emitAsync(this.ringListeners, event);
      },
      onBatteryState: (headsetBattery: number, headsetCharging: number) => {
        const state = {
          battery: Number(headsetBattery),
          chargingStatus: Number(headsetCharging),
        };
        this.emitAsync(this.batteryListeners, state);
      },
      onSilentMode: (silent: boolean) => {
        this.emitAsync(this.silentModeListeners, Boolean(silent));
      },
      onWearState: (wearing: boolean) => {
        this.latestWearState = Boolean(wearing);
        this.emitAsync(this.wearStateListeners, this.latestWearState);
      },
      onPhoneLockState: (locked: boolean) => {
        this.latestPhoneLockState = Boolean(locked);
        this.emitAsync(this.phoneLockStateListeners, this.latestPhoneLockState);
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
        this.emitAsync(this.frameMetricsListeners, metrics);
      },
      onFrameFinished: (frameId: number, outcome: string) => {
        this.recordFrameFinished(Number(frameId), String(outcome));
      },
      onFirmwareInfo: (leftVersion: string, rightVersion: string, capabilities: string) => {
        const info = {
          leftVersion: String(leftVersion),
          rightVersion: String(rightVersion),
          capabilities: String(capabilities),
        };
        this.emitAsync(this.firmwareInfoListeners, info);
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

  /**
   * Run a Java call, ordered against every other call made through here.
   *
   * inlineWhenIdle runs the call on the spot when nothing is queued ahead of
   * it. Ordering still holds — the fast path only fires when no earlier call
   * is waiting — and it skips a task-queue hop that measured ~18ms on device
   * (the gap between "span submit start" and the Java side's own log line in
   * the frame timings), which is pure latency on a call the caller is already
   * awaiting. Off by default: a call that might block for a while should keep
   * yielding to the main looper first.
   */
  private enqueueJavaCall<T>(operation: () => T, inlineWhenIdle = false): Promise<T> {
    if (inlineWhenIdle && this.queuedJavaCalls === 0) {
      try {
        return Promise.resolve(operation());
      } catch (error) {
        return Promise.reject(error);
      }
    }
    this.queuedJavaCalls++;
    const run = () =>
      new Promise<T>((resolve, reject) => {
        setTimeout(() => {
          this.queuedJavaCalls--;
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

  /**
   * Silent mode, toggled on the glasses by long-pressing both touchpads. While
   * it is on the firmware ignores all input and blanks the display.
   */
  onSilentMode(listener: (silent: boolean) => void): () => void {
    this.silentModeListeners.add(listener);
    return () => this.silentModeListeners.delete(listener);
  }

  onWearState(listener: (wearing: boolean) => void): () => void {
    this.wearStateListeners.add(listener);
    if (this.latestWearState !== null) {
      const wearing = this.latestWearState;
      setTimeout(() => {
        if (this.wearStateListeners.has(listener)) listener(wearing);
      }, 0);
    }
    return () => this.wearStateListeners.delete(listener);
  }

  onPhoneLockState(listener: (locked: boolean) => void): () => void {
    this.phoneLockStateListeners.add(listener);
    if (this.latestPhoneLockState !== null) {
      const locked = this.latestPhoneLockState;
      setTimeout(() => {
        if (this.phoneLockStateListeners.has(listener)) listener(locked);
      }, 0);
    }
    return () => this.phoneLockStateListeners.delete(listener);
  }

  onEvenAppConflict(listener: (message: string) => void): () => void {
    this.evenAppConflictListeners.add(listener);
    return () => this.evenAppConflictListeners.delete(listener);
  }

  onFrameMetrics(listener: (metrics: FrameMetrics) => void): () => void {
    this.frameMetricsListeners.add(listener);
    return () => this.frameMetricsListeners.delete(listener);
  }

  onFirmwareInfo(listener: (info: FirmwareInfo) => void): () => void {
    this.firmwareInfoListeners.add(listener);
    return () => this.firmwareInfoListeners.delete(listener);
  }

  getNativeCommunicator(): any {
    return this.communicator;
  }

  private recordFrameFinished(frameId: number, outcome: string): void {
    if (!Number.isFinite(frameId) || frameId <= 0) return;
    this.finishedFrameOutcomes.set(frameId, outcome);
    while (this.finishedFrameOutcomes.size > 128) {
      const oldest = this.finishedFrameOutcomes.keys().next().value;
      if (oldest === undefined) break;
      this.finishedFrameOutcomes.delete(oldest);
    }
    const waiters = this.frameFinishedWaiters.get(frameId);
    if (waiters) {
      this.frameFinishedWaiters.delete(frameId);
      for (const waiter of waiters) {
        setTimeout(() => waiter(outcome), 0);
      }
    }
  }

  /**
   * Resolve with the frame's outcome once the Java side finishes it (sent,
   * discarded, or timed out), or with null after timeoutMs. Used as transmit
   * backpressure: unlike waiting for frame metrics, this also resolves when a
   * frame is discarded (e.g. deduped as unchanged), so no-op renders do not
   * stall the render loop.
   */
  waitForFrameFinished(frameId: number, timeoutMs: number): Promise<string | null> {
    const known = this.finishedFrameOutcomes.get(frameId);
    if (known !== undefined) return Promise.resolve(known);
    if (frameId <= 0) return Promise.resolve(null);
    const delayMs = Math.max(1, Math.round(nonNegativeNumber(timeoutMs)));
    return new Promise((resolve) => {
      let settled = false;
      const onFinished = (outcome: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        resolve(outcome);
      };
      let waiters = this.frameFinishedWaiters.get(frameId);
      if (!waiters) {
        waiters = new Set();
        this.frameFinishedWaiters.set(frameId, waiters);
      }
      waiters.add(onFinished);
      const timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        const pending = this.frameFinishedWaiters.get(frameId);
        if (pending) {
          pending.delete(onFinished);
          if (pending.size === 0) this.frameFinishedWaiters.delete(frameId);
        }
        resolve(null);
      }, delayMs);
    });
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

  async setG2ScreenOn(screenOn: boolean): Promise<void> {
    await this.enqueueJavaCall(() => this.communicator.setG2ScreenOn(Boolean(screenOn)));
  }

  async setFirmwareDebugFlags(enabled: boolean): Promise<void> {
    await this.enqueueJavaCall(() => this.communicator.setFirmwareDebugFlags(Boolean(enabled)));
  }

  /** Set lens brightness: auto (ambient sensor) or an explicit 0-100 level. */
  async setBrightness(autoAdjust: boolean, level: number): Promise<void> {
    await this.enqueueJavaCall(() => this.communicator.setBrightness(Boolean(autoAdjust), Math.round(level)));
  }

  async enableWearDetectionAndRequestState(): Promise<void> {
    await this.enqueueJavaCall(() => this.communicator.enableWearDetectionAndRequestState());
  }

  /** Set the compositor's output frame size. Call before configuring surfaces. */
  async configureCompositorScreen(width: number, height: number): Promise<void> {
    await this.enqueueJavaCall(() => {
      this.communicator.configureCompositorScreen(Math.round(width), Math.round(height));
    });
  }

  /**
   * Phone-UI preview of the current composited screen, or null if none yet.
   * `green` tints it green-on-black (the Preview color setting) instead of
   * grayscale.
   */
  getCompositePreview(green = false): ImageSource | null {
    if (!global.isAndroid) return null;
    const bitmap = this.communicator.getCompositePreviewBitmap(PREVIEW_BRIGHTEN_GAMMA, green);
    return bitmap ? new ImageSource(bitmap) : null;
  }

  /** Save the current composite as a 4-bit grayscale PNG; returns the path (empty if none). */
  saveScreenshot(crop?: { x: number; y: number; width: number; height: number }): string {
    if (!global.isAndroid) return "";
    if (!crop) return String(this.communicator.saveCompositePngScreenshot());
    return String(
      this.communicator.saveCompositePngScreenshot(
        Math.round(crop.x),
        Math.round(crop.y),
        Math.round(crop.width),
        Math.round(crop.height),
      ),
    );
  }

  /** Begin collecting composite frames for an animated-GIF screen recording. */
  startScreenRecording(): void {
    if (!global.isAndroid) return;
    this.communicator.startScreenRecording();
  }

  /** Capture the current composite into the active recording; no-op when idle. */
  recordScreenFrame(): void {
    if (!global.isAndroid) return;
    this.communicator.recordScreenFrame();
  }

  /** Finish the recording and save the animated GIF; returns the path (empty if no frames). */
  stopScreenRecording(): string {
    if (!global.isAndroid) return "";
    return String(this.communicator.stopScreenRecording());
  }

  /**
   * Create or reconfigure a compositor surface. Geometry changes take effect
   * when the next frame is submitted.
   */
  async configureSurface(id: string, options: SurfaceOptions): Promise<void> {
    const transparency = options.transparency === "color-key" ? 1 : 0;
    await this.enqueueJavaCall(() => {
      this.communicator.configureSurface(
        id,
        Math.round(options.x),
        Math.round(options.y),
        Math.round(options.width),
        Math.round(options.height),
        Math.round(options.zOrder),
        transparency,
      );
    });
  }

  async removeSurface(id: string): Promise<void> {
    await this.enqueueJavaCall(() => {
      this.communicator.removeSurface(id);
    });
  }

  /** Show or hide a compositor surface; takes effect at the next composite. */
  async setSurfaceVisible(id: string, visible: boolean): Promise<void> {
    await this.enqueueJavaCall(() => {
      this.communicator.setSurfaceVisible(id, Boolean(visible));
    });
  }

  /**
   * Blank (screen off) or unblank the composited output; retained surface
   * state survives, so unblanking restores the screen without repaints.
   */
  async setScreenBlanked(blanked: boolean): Promise<void> {
    await this.enqueueJavaCall(() => {
      this.communicator.setScreenBlanked(Boolean(blanked));
    });
  }

  /**
   * Apply an update covering rect (in surface-local coordinates) to a surface
   * and submit the recomposited screen to the glasses. pixels8bpp holds
   * rect.width*rect.height bytes, row-major; fingerprint identifies the
   * surface's full content after the update.
   */
  async submitSurfaceFrame(
    surfaceId: string,
    pixels8bpp: Uint8Array,
    rect: { x: number; y: number; width: number; height: number },
    fingerprint: string,
    paintMs = -1,
    frameId = 0,
    /**
     * The frame's glyph draws in surface coordinates (see
     * graphics/glyph-wire.ts prepareFrameGlyphs); lets the texture-cache
     * pipeline ship text as on-glasses cached draws instead of pixels.
     */
    glyphs: ArrayBuffer | null = null,
  ): Promise<void> {
    // Snapshot because the Java call is deferred; the buffer is passed as an
    // ArrayBuffer, which NativeScript marshals to a ByteBuffer without the
    // ~150ms per-element copy a byte[] parameter would need.
    const snapshot = new Uint8Array(pixels8bpp);
    // inlineWhenIdle: this is the frame path, the Java side of it measures
    // ~5ms (composite + pack), and the caller awaits it either way.
    await this.enqueueJavaCall(() => {
      this.communicator.submitSurfaceFrame(
        snapshot.buffer,
        surfaceId,
        Math.round(rect.x),
        Math.round(rect.y),
        Math.round(rect.width),
        Math.round(rect.height),
        fingerprint,
        Math.round(nonNegativeNumber(paintMs)),
        Math.round(nonNegativeNumber(frameId)),
        glyphs,
      );
    }, true);
  }

  async disconnect(): Promise<void> {
    await this.enqueueJavaCall(() => this.communicator.disconnect());
  }

  async sendShutdown(exitMode = 0): Promise<boolean> {
    return this.enqueueJavaCall(() => Boolean(this.communicator.sendShutdown(exitMode)));
  }

  /**
   * Ask CFW mode 11 to release all custom-session state. On success this must
   * remain the final Faceclaw message before close(); false requests the legacy
   * shutdown/release fallback for older firmware.
   */
  async sendCfwCleanup(): Promise<boolean> {
    return this.enqueueJavaCall(() => Boolean(this.communicator.sendCfwCleanup()));
  }

  /**
   * End only the EvenHub page/session, leaving both arm BLE connections and
   * their async notification subscriptions alive.
   */
  async suspendEvenHubSession(): Promise<boolean> {
    return this.enqueueJavaCall(() => Boolean(this.communicator.suspendEvenHubSession()));
  }

  /**
   * Re-enable the EvenHub page lifecycle. The retained compositor frame is
   * sent after the layout and image path have been recreated.
   */
  async resumeEvenHubSession(): Promise<boolean> {
    return this.enqueueJavaCall(() => Boolean(this.communicator.resumeEvenHubSession()));
  }

  /**
   * Own CFW's fail-open stock-wake policy while Faceclaw handles wakewords or
   * suspends EvenHub with the screen off. Returns after both arm writes complete.
   */
  async setFaceclawWakeLeaseEnabled(enabled: boolean): Promise<boolean> {
    return this.enqueueJavaCall(() =>
      Boolean(this.communicator.setFaceclawWakeLeaseEnabled(enabled)),
    );
  }

  /**
   * Resolve only once the recreated layout and retained frame
   * are visible. CFW's deferred-dashboard READY is emitted from this barrier.
   */
  async awaitEvenHubSessionReady(timeoutMs: number): Promise<boolean> {
    return this.enqueueJavaCall(() =>
      Boolean(this.communicator.awaitEvenHubSessionReady(Math.round(nonNegativeNumber(timeoutMs)))),
    );
  }

  /** Play a CFW mode-5 kind-4 tone sequence (complete wire payload). */
  async playBuzzerSequence(payload: Uint8Array): Promise<void> {
    const snapshot = new Uint8Array(payload);
    await this.enqueueJavaCall(() => {
      this.communicator.playBuzzerSequence(snapshot.buffer);
    });
  }

  async close(): Promise<void> {
    await this.enqueueJavaCall(() => this.communicator.close());
  }
}
