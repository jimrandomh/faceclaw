/**
 * The Meta Neural Band as an input device for the glasses. The band connects to the phone
 * directly (app/native/neural-band.ts over FaceclawNeuralBand.kt); its gestures go through the
 * same synthetic-input path as the watch remote, tagged as watch input, so the shell's spatial
 * (four-way) scheme applies: thumb swipes move in four directions instead of being folded into
 * a one-dimensional scroll.
 *
 * The mapping itself (neuralBandInputFor) is in neural-band-core.ts. A held pinch on either
 * finger is a long-press that lasts until the pinch lets go (the system menu); a held index
 * pinch that turned into the dial is not a hold (the native side never reports it).
 *
 * It is also the shell's handwriting source (Shell.startHandwritingInput): the band's own
 * handwriting model, switched on only while the Handwriting dialog is open.
 */
import { neuralBand, type NeuralBandEvent, type NeuralBandStatus } from "../native/neural-band";
import {
  neuralBandEnabledSetting,
  neuralBandHapticsSetting,
  neuralBandTwistScrollSetting,
  onAnySettingChanged,
} from "../ui/dashboard-settings";
import { type HandwritingListener, type HandwritingSource } from "../ui/shell/handwriting-input";
import { shell } from "../ui/shell/shell";
import { formatErrorMessage } from "../util/format-error";
import { handwritingDialogPhase, neuralBandBatteryLevel, neuralBandInputFor, suppressedWhileWriting } from "./neural-band-core";
import type { WearRemoteInputKind } from "./wear-remote";

export type NeuralBandRemoteHost = {
  injectInput: (kind: WearRemoteInputKind) => Promise<void>;
  /** Gestures have a display to act on: the glasses, or the phone's preview without them. */
  takesInput: () => boolean;
  appendLog: (line: string) => void;
  /** The band's level in shell.getBatteryLevels() changed: repaint the indicators that show it. */
  batteryChanged: () => void;
};

export class NeuralBandRemote implements HandwritingSource {
  readonly name = "Neural Band";
  /** The open Handwriting dialog, while the band's handwriting model is ours. */
  private handwritingListener: HandwritingListener | null = null;
  private lastCharacterAtMs = 0;
  /** Fingers whose pinch became a hold, so their release ends a long-press. */
  private readonly holding = new Set<number>();
  /** Gestures are delivered in order: a press must reach the shell before the click it began. */
  private queue: Promise<void> = Promise.resolve();
  private status: NeuralBandStatus = neuralBand.getStatus();
  private lastEnabled: boolean | null = null;
  private lastTwistScroll: boolean | null = null;
  private lastHaptics: boolean | null = null;

  constructor(private readonly host: NeuralBandRemoteHost) {
    if (!neuralBand.isSupported()) return;
    neuralBand.onEvent((event) => this.handleEvent(event));
    onAnySettingChanged(() => this.applySettings());
    this.applySettings();
  }

  getStatus(): NeuralBandStatus {
    return this.status;
  }

  /**
   * The handwriting source for the shell: the band, while it is connected and in use, unless
   * its firmware is known to have no handwriting (the phone's Neural Band page says so).
   */
  handwritingSource(): HandwritingSource | null {
    return this.status.state === "connected" && neuralBandEnabledSetting.get() && !this.status.handwritingUnsupported
      ? this : null;
  }

  start(listener: HandwritingListener): string | null {
    if (this.status.state !== "connected") return "Connect the Neural Band first.";
    try {
      neuralBand.setHandwriting(true);
    } catch (error) {
      return formatErrorMessage(error);
    }
    this.handwritingListener = listener;
    this.lastCharacterAtMs = 0;
    this.host.appendLog("Neural Band: handwriting on");
    return null;
  }

  setText(text: string): void {
    if (this.handwritingListener) neuralBand.setHandwritingText(text);
  }

  stop(): void {
    if (!this.handwritingListener) return;
    this.handwritingListener = null;
    this.host.appendLog("Neural Band: handwriting off");
    try {
      neuralBand.setHandwriting(false);
    } catch {
      // Disconnected meanwhile: the next connection puts the band's model back.
    }
  }

  /** Push changed settings to the band, and connect or disconnect it to match "enabled". */
  private applySettings(): void {
    const twist = neuralBandTwistScrollSetting.get();
    if (twist !== this.lastTwistScroll) {
      this.lastTwistScroll = twist;
      neuralBand.setTwistScroll(twist);
    }
    const haptics = neuralBandHapticsSetting.get();
    if (haptics !== this.lastHaptics) {
      this.lastHaptics = haptics;
      neuralBand.setGestureHaptics(haptics);
    }
    const enabled = neuralBandEnabledSetting.get();
    if (enabled !== this.lastEnabled) {
      this.lastEnabled = enabled;
      if (enabled) neuralBand.connect();
      else neuralBand.disconnect();
    }
  }

  private handleEvent(event: NeuralBandEvent): void {
    switch (event.type) {
      case "status": {
        const { type: _type, ...status } = event;
        const previous = this.status;
        this.status = status;
        if (previous.state !== status.state) {
          this.host.appendLog(`Neural Band: ${status.state}${status.message ? ` (${status.message})` : ""}`);
          if (status.state !== "connected") this.releaseHolds();
        }
        this.updateBattery(status);
        return;
      }
      case "log":
        this.host.appendLog(event.text);
        return;
      case "gesture":
        this.handleGesture(event.gesture, event.finger);
        return;
      case "handwriting":
        // What someone writes is never logged.
        if (!this.handwritingListener) return;
        this.lastCharacterAtMs = Date.now();
        this.handwritingListener.text(event.text);
        return;
      case "handwriting-state": {
        if (event.problem) this.host.appendLog(`Neural Band: handwriting ${event.phase}: ${event.problem}`);
        const listener = this.handwritingListener;
        if (!listener) return;
        const dialog = handwritingDialogPhase(event.phase, event.problem);
        listener.phase(dialog.phase, dialog.message);
        // The band ended it on its own (a refused setting, silence, a dropped link).
        if (dialog.phase === "stopped") this.handwritingListener = null;
        return;
      }
      default:
        return;
    }
  }

  private handleGesture(gesture: string, finger: number | undefined): void {
    if (!neuralBandEnabledSetting.get()) return;
    if (suppressedWhileWriting(gesture, this.handwritingListener !== null, Date.now() - this.lastCharacterAtMs)) return;
    if (gesture === "hold" && finger !== undefined) {
      if (!this.takesInput()) return;
      this.holding.add(finger);
      this.inject("long-press-start");
      return;
    }
    if (gesture === "release") {
      // A release always ends its hold, even if the display went away meanwhile.
      if (finger !== undefined && this.holding.delete(finger)) this.inject("long-press-release");
      return;
    }
    const kind = neuralBandInputFor(gesture, finger);
    if (kind && this.takesInput()) this.inject(kind);
  }

  /**
   * The band's level in the shell's battery levels, beside the glasses', ring's and watch's
   * (top bar, Glanceboard, phone). Like the watch's, it exists only while the band is there.
   */
  private updateBattery(status: NeuralBandStatus): void {
    const { band, bandCharging } = neuralBandBatteryLevel(status);
    const current = shell.getBatteryLevels();
    if (current.band === band && current.bandCharging === bandCharging) return;
    const wasKnown = current.band !== null;
    shell.setBatteryLevels({ band, bandCharging });
    if (band !== null) this.host.appendLog(`Neural Band: battery ${band}%${bandCharging ? " (charging)" : ""}`);
    else if (wasKnown) this.host.appendLog("Neural Band: battery unknown");
    this.host.batteryChanged();
  }

  private releaseHolds(): void {
    for (const _finger of this.holding) this.inject("long-press-release");
    this.holding.clear();
  }

  private takesInput(): boolean {
    return this.host.takesInput();
  }

  private inject(kind: WearRemoteInputKind): void {
    this.queue = this.queue
      .then(() => this.host.injectInput(kind))
      .catch((error) => this.host.appendLog(`Neural Band: ${kind} failed: ${(error as Error)?.message ?? String(error)}`));
  }
}
