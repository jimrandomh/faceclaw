import type { RingInput } from "../g2/ring-input";
import { File, knownFolders, path, type ImageSource } from "@nativescript/core";
import { type FirmwareInfo } from "../g2/firmware-compat";
import { type CompassEvent } from "./compass-types";
import { fromData, toData } from "./kotlin-data";
import { previewPixels } from "./ios-graphics";
import { iosBluetooth } from "./ios-bluetooth";

export type { FirmwareInfo };

// Kotlin/Native facades exported by FaceclawKit (see native/kotlin/shared/src/iosMain/.../ble).
declare const FaceclawKitIosGlassesSession: any;
declare const FaceclawKitIosProtocolPlatform: any;
declare const FaceclawKitFaceclawBleCommunicatorListener: any;
declare const FaceclawKitIosAncsListener: any;
declare const FaceclawKitIosAudioPacketListener: any;
declare const FaceclawKitFaceclawCompassListener: any;


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
  ringBattery?: number;
  ringChargingStatus?: number;
};

export type FrameMetrics = {
  paintMs: number;
  transmitMs: number;
  tileCount: number;
};

/** See the Android twin: compositor surface configuration in screen pixels. */
export type SurfaceOptions = {
  x: number;
  y: number;
  width: number;
  height: number;
  zOrder: number;
  transparency: "opaque" | "color-key";
};

export type RawInputEvent = { ringInput?: RingInput } & (
  | { kind: "list-click"; containerName: string; eventType: number; eventSource: number; systemExitReasonCode: number; frameId: number }
  | { kind: "text-click"; containerName: string; eventType: number; eventSource: number; systemExitReasonCode: number; frameId: number }
  | { kind: "sys-event"; containerName: string; eventType: number; eventSource: number; systemExitReasonCode: number; frameId: number }
  | { kind: "even-ai"; containerName: string; eventType: number; eventSource: number; systemExitReasonCode: number; frameId: number }
  | { kind: "watch-gesture"; containerName: string; eventType: number; eventSource: number; systemExitReasonCode: number; frameId: number }
  | { kind: "display-wake"; containerName: string; eventType: number; eventSource: number; systemExitReasonCode: number; frameId: number }
);

function nonNegativeNumber(value: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

/** A 0..1 brightness factor as the compositor's 0..256 fixed-point form. */
export function dimFactor256(factor: number): number {
  return Math.round(Math.max(0, Math.min(1, factor)) * 256);
}

function timestamp(): string {
  const now = new Date();
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
}

export type PeripheralIdentifiers = { right: string; left: string; ring: string };

/**
 * Map the configured MAC addresses to CoreBluetooth identifiers through the scan
 * layer (app/native/ios-bluetooth.ts): the mapping a previous scan persisted, else a
 * fresh scan that classifies Even advertisements. The scan layer also owns Bluetooth
 * readiness (creating the central triggers the permission prompt on first use).
 */
export async function resolveIosPeripherals(addresses: { right: string; left: string; ring?: string }): Promise<PeripheralIdentifiers> {
  const resolved = await iosBluetooth().resolveDevices({ right: addresses.right, left: addresses.left, ring: addresses.ring ?? "" });
  return {
    right: String(resolved.right ?? "").toUpperCase(),
    left: String(resolved.left ?? "").toUpperCase(),
    ring: String(resolved.ring ?? "").toUpperCase(),
  };
}

/** Bluetooth powered on and authorized (prompts for permission the first time); rejects with the user-facing reason. */
export function ensureIosBluetoothReady(): Promise<void> {
  return iosBluetooth().ensureReady();
}

@NativeClass()
class SessionListener extends NSObject {
  static ObjCProtocols = [FaceclawKitFaceclawBleCommunicatorListener];
  bridge!: FaceclawCommunicatorBridge;
  onStateChangePhaseStatus(phase: string, status: string): void { this.bridge.handleStateChange(String(phase ?? ""), String(status ?? "")); }
  onRingEventKindContainerNameEventTypeEventSourceSystemExitReasonCodeFrameIdRingTickRingTypeRingAuxRingSpeed(
    kind: string, containerName: string, eventType: number, eventSource: number, systemExitReasonCode: number,
    frameId: number, ringTick: number, ringType: number, ringAux: number, ringSpeed: number,
  ): void {
    this.bridge.handleRingEvent(String(kind ?? ""), String(containerName ?? ""), Number(eventType), Number(eventSource),
      Number(systemExitReasonCode), Number(frameId), Number(ringTick), Number(ringType), Number(ringAux), Number(ringSpeed));
  }
  onBatteryStateHeadsetBatteryHeadsetChargingRingBatteryRingCharging(headsetBattery: number, headsetCharging: number, ringBattery: number, ringCharging: number): void {
    this.bridge.handleBatteryState(Number(headsetBattery), Number(headsetCharging), Number(ringBattery), Number(ringCharging));
  }
  onSilentModeSilent(silent: boolean): void { this.bridge.handleSilentMode(Boolean(silent)); }
  onWearStateWearing(wearing: boolean): void { this.bridge.handleWearState(Boolean(wearing)); }
  onPhoneLockStateLocked(locked: boolean): void { this.bridge.handlePhoneLockState(Boolean(locked)); }
  onEvenAppConflictMessage(message: string): void { this.bridge.handleEvenAppConflict(String(message ?? "")); }
  onFrameMetricsPaintMsTransmitMsTileCount(paintMs: number, transmitMs: number, tileCount: number): void {
    this.bridge.handleFrameMetrics(Number(paintMs), Number(transmitMs), Number(tileCount));
  }
  onFrameFinishedFrameIdOutcome(frameId: number, outcome: string): void { this.bridge.handleFrameFinished(Number(frameId), String(outcome ?? "")); }
  onFirmwareInfoLeftVersionRightVersionExtension(leftVersion: string, rightVersion: string, extension: string): void {
    this.bridge.handleFirmwareInfo(String(leftVersion ?? ""), String(rightVersion ?? ""), String(extension ?? ""));
  }
}

@NativeClass()
class AncsListener extends NSObject {
  static ObjCProtocols = [FaceclawKitIosAncsListener];
  bridge!: FaceclawCommunicatorBridge;
  onAncsAuthorizationAuthorized(authorized: boolean): void { this.bridge.handleAncsAuthorization(Boolean(authorized)); }
  onRelayFrameData(data: NSData): void { this.bridge.handleAncsRelayFrame(fromData(data)); }
}

@NativeClass()
class AudioPacketListener extends NSObject {
  static ObjCProtocols = [FaceclawKitIosAudioPacketListener];
  handler!: (packet: Uint8Array, arm: string, arrivalMs: number) => void;
  onAudioPacketDataArmArrivalMs(data: NSData, arm: string, arrivalMs: number): void {
    this.handler(fromData(data), String(arm ?? ""), Number(arrivalMs));
  }
}

@NativeClass()
class CompassListener extends NSObject {
  static ObjCProtocols = [FaceclawKitFaceclawCompassListener];
  handler!: (event: CompassEvent) => void;
  onCompassEventCommandHeadingDegreesMagneticAccuracyMagneticAnomaliesOrientationSourceDiagnosticFlagsSampleTimeMs(
    command: number, headingDegrees: number, magneticAccuracy: number, magneticAnomalies: number,
    orientationSource: number, diagnosticFlags: number, sampleTimeMs: number,
  ): void {
    this.handler({
      command: Number(command), headingDegrees: Number(headingDegrees),
      diagnostics: diagnosticFlags >= 0 ? {
        magneticAccuracy: Number(magneticAccuracy), magneticAnomalies: Number(magneticAnomalies),
        orientationSource: Number(orientationSource), flags: Number(diagnosticFlags), sampleTimeMs: Number(sampleTimeMs),
      } : undefined,
    });
  }
}

/**
 * The iOS twin of the Android communicator bridge: the same public API over
 * the shared Kotlin session (FaceclawKitIosGlassesSession, CoreBluetooth
 * underneath). Addresses are CoreBluetooth identifiers (resolveIosPeripherals
 * maps the configured MACs). Every Kotlin callback already arrives on the
 * main queue; listener fan-out is still deferred with setTimeout like on
 * Android so callers never re-enter the bridge from a Kotlin frame.
 */
export class FaceclawCommunicatorBridge {
  private readonly communicator: any;
  private readonly listenerProxy: SessionListener;
  private ancsProxy: AncsListener | null = null;
  private nativeCallQueue: Promise<void> = Promise.resolve();
  private queuedNativeCalls = 0;
  private readonly frameMetricWaiters = new Set<(metrics: FrameMetrics) => void>();
  private readonly finishedFrameOutcomes = new Map<number, string>();
  private readonly frameFinishedWaiters = new Map<number, Set<(outcome: string) => void>>();
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
  private readonly ancsAuthorizationListeners = new Set<(authorized: boolean) => void>();
  private readonly ancsRelayListeners = new Set<(frame: Uint8Array) => void>();
  private audioListener: AudioPacketListener | null = null;
  private microphoneWork: Promise<void> = Promise.resolve();
  private microphoneToken = 0;

  constructor(addresses: { right: string; left: string; ring?: string }) {
    this.communicator = FaceclawKitIosGlassesSession.alloc().initWithRightAddressLeftAddressRingAddress(
      String(addresses.right ?? "").toUpperCase(),
      String(addresses.left ?? "").toUpperCase(),
      String(addresses.ring ?? "").toUpperCase(),
    );
    this.listenerProxy = SessionListener.new() as SessionListener;
    this.listenerProxy.bridge = this;
    this.communicator.setListenerListener(this.listenerProxy);
  }

  // ----- Kotlin listener entry points (main queue) -----------------------------------

  /** @internal */
  handleStateChange(phase: string, status: string): void {
    this.emitAsync(this.stateListeners, { phase: phase as CommunicatorPhase, status });
  }

  /** @internal */
  handleRingEvent(kind: string, containerName: string, eventType: number, eventSource: number, systemExitReasonCode: number,
    frameId: number, ringTick: number, ringType: number, ringAux: number, ringSpeed: number): void {
    const event = {
      kind: kind as RawInputEvent["kind"], containerName, eventType, eventSource, systemExitReasonCode, frameId,
      ringInput: ringTick >= 0 ? { tick: ringTick, type: ringType, aux: ringAux, speed: ringSpeed } : undefined,
    } as RawInputEvent;
    this.emitAsync(this.ringListeners, event);
  }

  /** @internal */
  handleBatteryState(battery: number, chargingStatus: number, ringBattery: number, ringChargingStatus: number): void {
    this.emitAsync(this.batteryListeners, { battery, chargingStatus, ringBattery, ringChargingStatus });
  }

  /** @internal */
  handleSilentMode(silent: boolean): void { this.emitAsync(this.silentModeListeners, silent); }

  /** @internal */
  handleWearState(wearing: boolean): void {
    this.latestWearState = wearing;
    this.emitAsync(this.wearStateListeners, wearing);
  }

  /** @internal */
  handlePhoneLockState(locked: boolean): void {
    this.latestPhoneLockState = locked;
    this.emitAsync(this.phoneLockStateListeners, locked);
  }

  /** @internal */
  handleEvenAppConflict(message: string): void { this.emitAsync(this.evenAppConflictListeners, message); }

  /** @internal */
  handleFrameMetrics(paintMs: number, transmitMs: number, tileCount: number): void {
    const metrics = { paintMs: nonNegativeNumber(paintMs), transmitMs: nonNegativeNumber(transmitMs), tileCount: nonNegativeNumber(tileCount) };
    const waiters = Array.from(this.frameMetricWaiters);
    this.frameMetricWaiters.clear();
    for (const waiter of waiters) setTimeout(() => waiter(metrics), 0);
    this.emitAsync(this.frameMetricsListeners, metrics);
  }

  /** @internal */
  handleFrameFinished(frameId: number, outcome: string): void { this.recordFrameFinished(frameId, outcome); }

  /** @internal */
  handleFirmwareInfo(leftVersion: string, rightVersion: string, extension: string): void {
    this.emitAsync(this.firmwareInfoListeners, { leftVersion, rightVersion, extension });
  }

  /** @internal */
  handleAncsAuthorization(authorized: boolean): void { this.emitAsync(this.ancsAuthorizationListeners, authorized); }

  /** @internal */
  handleAncsRelayFrame(frame: Uint8Array): void { this.emitAsync(this.ancsRelayListeners, frame); }

  private emitAsync<T>(listeners: Set<(value: T) => void>, value: T): void {
    const snapshot = Array.from(listeners);
    setTimeout(() => {
      for (const listener of snapshot) listener(value);
    }, 0);
  }

  /** Same FIFO as the Android bridge: native calls stay ordered; the fast path skips a task hop when idle. */
  private enqueueNativeCall<T>(operation: () => T, inlineWhenIdle = false): Promise<T> {
    if (inlineWhenIdle && this.queuedNativeCalls === 0) {
      try {
        return Promise.resolve(operation());
      } catch (error) {
        return Promise.reject(error);
      }
    }
    this.queuedNativeCalls++;
    const run = () =>
      new Promise<T>((resolve, reject) => {
        setTimeout(() => {
          this.queuedNativeCalls--;
          try {
            resolve(operation());
          } catch (error) {
            reject(error);
          }
        }, 0);
      });
    const result = this.nativeCallQueue.then(run, run);
    this.nativeCallQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  // ----- listeners -------------------------------------------------------------------

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

  onSilentMode(listener: (silent: boolean) => void): () => void {
    this.silentModeListeners.add(listener);
    return () => this.silentModeListeners.delete(listener);
  }

  onWearState(listener: (wearing: boolean) => void): () => void {
    this.wearStateListeners.add(listener);
    if (this.latestWearState !== null) {
      const wearing = this.latestWearState;
      setTimeout(() => { if (this.wearStateListeners.has(listener)) listener(wearing); }, 0);
    }
    return () => this.wearStateListeners.delete(listener);
  }

  onPhoneLockState(listener: (locked: boolean) => void): () => void {
    this.phoneLockStateListeners.add(listener);
    if (this.latestPhoneLockState !== null) {
      const locked = this.latestPhoneLockState;
      setTimeout(() => { if (this.phoneLockStateListeners.has(listener)) listener(locked); }, 0);
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
      for (const waiter of waiters) setTimeout(() => waiter(outcome), 0);
    }
  }

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
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
        this.frameMetricWaiters.delete(onMetrics);
        resolve(metrics);
      };
      const onMetrics = (metrics: FrameMetrics) => complete(metrics);
      this.frameMetricWaiters.add(onMetrics);
      timeoutHandle = setTimeout(() => complete(null), delayMs);
    });
  }

  // ----- session ---------------------------------------------------------------------

  async start(): Promise<void> {
    await this.enqueueNativeCall(() => { this.communicator.start(); });
  }

  async setG2ScreenOn(screenOn: boolean): Promise<void> {
    await this.enqueueNativeCall(() => this.communicator.setG2ScreenOnScreenOn(Boolean(screenOn)));
  }

  async setFirmwareDebugFlags(enabled: boolean): Promise<void> {
    await this.enqueueNativeCall(() => this.communicator.setFirmwareDebugFlagsEnabled(Boolean(enabled)));
  }

  /** Set lens brightness: auto (ambient sensor) or an explicit 0-100 level. */
  async setBrightness(autoAdjust: boolean, level: number): Promise<void> {
    await this.enqueueNativeCall(() => this.communicator.setBrightnessAutoAdjustBrightnessLevel(Boolean(autoAdjust), Math.round(level)));
  }

  async enableWearDetectionAndRequestState(): Promise<void> {
    await this.enqueueNativeCall(() => this.communicator.enableWearDetectionAndRequestState());
  }

  isSessionReady(): boolean {
    return Boolean(this.communicator.isSessionReady());
  }

  /** The platform's lock/screen signal (the iOS host also observes protected data itself). */
  onPhoneLockSignal(): void {
    this.communicator.onPhoneLockSignal();
  }

  // ----- compositor ------------------------------------------------------------------

  async configureCompositorScreen(width: number, height: number): Promise<void> {
    await this.enqueueNativeCall(() => {
      this.communicator.configureCompositorScreenWidthHeight(Math.round(width), Math.round(height));
    });
  }

  /** Phone-UI preview of the current composited screen, or null if none yet. */
  getCompositePreview(green = false): ImageSource | null {
    const frame = this.communicator.previewComposite();
    if (!frame) return null;
    const width = Number(this.communicator.compositeWidth()), height = Number(this.communicator.compositeHeight());
    if (width <= 0 || height <= 0) return null;
    return previewPixels(fromData(frame.pixels), width, height, green);
  }

  /** Save the current composite as a 4-bit grayscale PNG under Documents; returns the path (empty if none). Cropping is not supported on iOS. */
  saveScreenshot(crop?: { x: number; y: number; width: number; height: number }): string {
    if (crop) return "";
    const png = this.communicator.screenshotPng();
    if (!png) return "";
    const target = path.join(knownFolders.documents().path, `screen-${timestamp()}.png`);
    File.fromPath(target).writeSync(png);
    return target;
  }

  /** Screen recording is not available on iOS yet. */
  startScreenRecording(): void {}

  recordScreenFrame(): void {}

  stopScreenRecording(): string { return ""; }

  async configureSurface(id: string, options: SurfaceOptions): Promise<void> {
    const transparency = options.transparency === "color-key" ? 1 : 0;
    await this.enqueueNativeCall(() => {
      this.communicator.configureSurfaceIdXYWidthHeightZOrderTransparency(
        id, Math.round(options.x), Math.round(options.y), Math.round(options.width), Math.round(options.height),
        Math.round(options.zOrder), transparency,
      );
    });
  }

  async removeSurface(id: string): Promise<void> {
    await this.enqueueNativeCall(() => { this.communicator.removeSurfaceId(id); });
  }

  async submitShellScene(bytes: Uint8Array, paintMs = 0, frameId = 0): Promise<void> {
    const snapshot = new Uint8Array(bytes);
    await this.enqueueNativeCall(() => this.communicator.submitShellSceneBytesPaintMsFrameId(toData(snapshot), Math.round(nonNegativeNumber(paintMs)), Math.round(nonNegativeNumber(frameId))), true);
  }

  async setUnderlayDim(belowZOrder: number, factor: number): Promise<void> {
    await this.enqueueNativeCall(() => {
      this.communicator.setUnderlayDimBelowZOrderFactor256(Math.round(belowZOrder), dimFactor256(factor));
    });
  }

  async setSurfaceVisible(id: string, visible: boolean): Promise<void> {
    await this.enqueueNativeCall(() => { this.communicator.setSurfaceVisibleIdVisible(id, Boolean(visible)); });
  }

  async setScreenBlanked(blanked: boolean): Promise<void> {
    await this.enqueueNativeCall(() => { this.communicator.setScreenBlankedBlanked(Boolean(blanked)); });
  }

  async submitSurfaceFrame(
    surfaceId: string,
    pixels8bpp: Uint8Array,
    rect: { x: number; y: number; width: number; height: number },
    fingerprint: string,
    paintMs = -1,
    frameId = 0,
    glyphs: ArrayBuffer | null = null,
  ): Promise<void> {
    const snapshot = new Uint8Array(pixels8bpp);
    const draws = glyphs ? toData(new Uint8Array(glyphs)) : null;
    await this.enqueueNativeCall(() => {
      this.communicator.submitSurfaceFramePixels8bppSurfaceIdRectXRectYRectWidthRectHeightContentFingerprintPaintMsFrameIdGlyphs(
        toData(snapshot), surfaceId, Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height),
        fingerprint, Math.round(nonNegativeNumber(paintMs)), Math.round(nonNegativeNumber(frameId)), draws,
      );
    }, true);
  }

  // ----- controls --------------------------------------------------------------------

  async disconnect(): Promise<void> {
    await this.enqueueNativeCall(() => this.communicator.disconnect());
  }

  async sendShutdown(exitMode = 0): Promise<boolean> {
    return this.enqueueNativeCall(() => Boolean(this.communicator.sendShutdownExitMode(exitMode)));
  }

  async sendCfwCleanup(): Promise<boolean> {
    return this.enqueueNativeCall(() => Boolean(this.communicator.sendCfwCleanup()));
  }

  async suspendEvenHubSession(): Promise<boolean> {
    return this.enqueueNativeCall(() => Boolean(this.communicator.suspendEvenHubSession()));
  }

  async resumeEvenHubSession(): Promise<boolean> {
    return this.enqueueNativeCall(() => Boolean(this.communicator.resumeEvenHubSession()));
  }

  async setFaceclawWakeLeaseEnabled(enabled: boolean): Promise<boolean> {
    return this.enqueueNativeCall(() => Boolean(this.communicator.setFaceclawWakeLeaseEnabledEnabled(Boolean(enabled))));
  }

  async awaitEvenHubSessionReady(timeoutMs: number): Promise<boolean> {
    return this.enqueueNativeCall(() => Boolean(this.communicator.awaitEvenHubSessionReadyTimeoutMs(Math.round(nonNegativeNumber(timeoutMs)))));
  }

  /** Play a CFW mode-5 kind-4 tone sequence (complete wire payload). */
  async playBuzzerSequence(payload: Uint8Array): Promise<void> {
    const snapshot = new Uint8Array(payload);
    await this.enqueueNativeCall(() => { this.communicator.playBuzzerSequencePayload(toData(snapshot)); });
  }

  async close(): Promise<void> {
    this.setAncsListeners(false);
    await this.enqueueNativeCall(() => this.communicator.close());
  }

  // ----- iOS extras: compass, microphone, iPhone notifications (ANCS) ----------------------

  /** CFW mode-10 compass on behalf of `owner`; the magnetometer runs while any owner wants it. */
  setCompassEnabled(enabled: boolean, owner = "compass"): void {
    this.communicator.setCompassEnabledForOwnerOwnerEnable(owner, Boolean(enabled));
  }

  /** Compass heading/calibration events, delivered on the main queue. */
  addCompassListener(listener: (event: CompassEvent) => void): () => void {
    const proxy = CompassListener.new() as CompassListener;
    proxy.handler = listener;
    this.communicator.addCompassListenerListener(proxy);
    return () => { this.communicator.removeCompassListenerListener(proxy); };
  }

  /**
   * Serialized glasses microphone enable/disable (the voice bridge's
   * IosMicrophoneSession contract). A release while an enable awaits its ACK
   * still wins: the token check drops the stale packets.
   */
  setMicrophone(enabled: boolean, listener?: (packet: Uint8Array) => void): Promise<void> {
    const token = ++this.microphoneToken;
    const work = this.microphoneWork.catch(() => {}).then(async () => {
      if (token !== this.microphoneToken) return;
      if (!enabled) {
        this.audioListener = null;
        await this.enqueueNativeCall(() => this.communicator.stopG2AudioCapture());
        return;
      }
      if (!this.isSessionReady()) throw new Error("Connect the glasses before starting voice input.");
      const proxy = AudioPacketListener.new() as AudioPacketListener;
      proxy.handler = (packet) => { if (token === this.microphoneToken && listener) listener(packet); };
      this.audioListener = proxy;
      const started = await this.enqueueNativeCall(() => Boolean(this.communicator.startG2AudioCaptureNsDataListener(proxy)));
      if (!started) {
        this.audioListener = null;
        throw new Error("The glasses did not enable their microphone. Reconnect and try again.");
      }
    });
    this.microphoneWork = work;
    return work;
  }

  /** Ask CoreBluetooth for ANCS on the right arm's next connection (call before start()). */
  setRequiresAncs(required: boolean): void {
    this.communicator.setRequiresAncsRequired(Boolean(required));
    this.setAncsListeners(required);
  }

  isAncsAuthorized(): boolean {
    return Boolean(this.communicator.isAncsAuthorized());
  }

  onAncsAuthorization(listener: (authorized: boolean) => void): () => void {
    this.ancsAuthorizationListeners.add(listener);
    return () => this.ancsAuthorizationListeners.delete(listener);
  }

  /** Relay frames ('A','N',...) received on the right arm, for the ANCS client. */
  onAncsRelayFrame(listener: (frame: Uint8Array) => void): () => void {
    this.ancsRelayListeners.add(listener);
    return () => this.ancsRelayListeners.delete(listener);
  }

  /** Queue one relay packet for the right arm; the Kotlin side writes it off the JS thread. */
  async writeRawToRight(packet: Uint8Array): Promise<void> {
    if (!this.isSessionReady()) throw new Error("Glasses are not connected.");
    const snapshot = new Uint8Array(packet);
    this.communicator.writeRawToRightPacket(toData(snapshot));
  }

  /** The right arm's usable write payload for relay packets (20 until connected). */
  rightWriteLimit(): number {
    return Number(this.communicator.rightWriteLimit()) || 20;
  }

  private setAncsListeners(install: boolean): void {
    if (install && !this.ancsProxy) {
      this.ancsProxy = AncsListener.new() as AncsListener;
      this.ancsProxy.bridge = this;
      this.communicator.setAncsListenerListener(this.ancsProxy);
    } else if (!install && this.ancsProxy) {
      this.communicator.setAncsListenerListener(null);
      this.ancsProxy = null;
    }
  }
}
