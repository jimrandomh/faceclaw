/**
 * The Wear OS watch as an input device and status mirror for the glasses.
 *
 * Inbound, the watch sends ring-style gestures (tap, double-tap, hold,
 * swipe/crown scrolls, "Hey Even") which feed the exact synthetic-ring path
 * the phone UI's test buttons use, plus higher-level commands the ring has no
 * way to express: launch an app, switch or close a window, wake/sleep/lock
 * the display, send a spoken or typed query straight to the assistant, or
 * type text into the foreground app.
 *
 * Outbound, the dashboard state (connection, battery, screen, lock, open
 * windows, launchable apps) is mirrored into a Data Layer item so the watch
 * UI can show it and offer the right actions; assistant replies and alerts
 * stream to the watch as events so a query made from the wrist can be read
 * from the wrist.
 *
 * Transport is app/native/wear-bridge.ts (Java FaceclawWearBridge); the
 * message shapes are documented in wear/PROTOCOL.md.
 */
import { type AppDefinition } from "../apps/app-definition";
import { getInstalledEvenHubApps, installedEvenHubAppId } from "../apps/evenhub/installed-apps";
import { WEAR_PATHS, wearBridge, type WearMessage } from "../native/wear-bridge";
import {
  DISPLAY_MODE_VALUES,
  displayModeSetting,
  onAnySettingChanged,
  watchCanUnlockSetting,
  watchCrownClockwiseNextSetting,
  watchMirrorAssistantSetting,
  watchRemoteEnabledSetting,
} from "../ui/dashboard-settings";
import { shell, type AssistantActivityEvent } from "../ui/shell/shell";
import { voiceActivity } from "../ui/shell/voice-activity";
import { FACECLAW_VERSION } from "../version";

/** Protocol revision carried in the state item; bump on incompatible changes. */
export const WEAR_PROTOCOL_VERSION = 1;

export type WearRemoteInputKind =
  | "click"
  | "double-click"
  | "scroll-up"
  | "scroll-down"
  | "long-press"
  | "long-press-start"
  | "long-press-release"
  | "wakeword"
  | "swipe-left"
  | "swipe-right"
  | "swipe-up"
  | "swipe-down";

const INPUT_KINDS: readonly WearRemoteInputKind[] = [
  "click",
  "double-click",
  "scroll-up",
  "scroll-down",
  "long-press",
  "long-press-start",
  "long-press-release",
  "wakeword",
  "swipe-left",
  "swipe-right",
  "swipe-up",
  "swipe-down",
];

const COMMANDS = [
  "launch-app",
  "focus-window",
  "close-window",
  "sidebar",
  "wake",
  "sleep",
  "lock",
  "unlock",
  "connect",
  "disconnect",
  "close-assistant",
  "display-mode",
] as const;
type WearCommand = (typeof COMMANDS)[number];

const MAX_SCROLL_STEPS = 12;
const MAX_TEXT_LENGTH = 2000;
const STATE_PUBLISH_DEBOUNCE_MS = 150;
const STATE_REFRESH_INTERVAL_MS = 30_000;
const ASSISTANT_STREAM_MIN_INTERVAL_MS = 250;

/** What the dashboard controller lends the watch remote. */
export type WearRemoteHost = {
  /** The launcher-grid apps; installed EvenHub packages are added dynamically. */
  apps: readonly AppDefinition[];
  injectInput: (kind: WearRemoteInputKind) => Promise<void>;
  launchApp: (appId: string) => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  setGlassesLocked: (locked: boolean, reason: string) => void;
  requestShellRender: () => void;
  getState: () => {
    phase: string;
    status: string;
    glassesLocked: boolean;
    glassesWorn: boolean | null;
    silentMode: boolean;
    lastHeadsetBattery: number | null;
  };
  appendLog: (line: string) => void;
};

export class WearRemote {
  private readonly active: boolean;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private watchReachable = false;
  private watchName = "";
  // Assistant text streams as deltas many times a second; the watch gets a
  // snapshot every ASSISTANT_STREAM_MIN_INTERVAL_MS plus every phase change.
  private assistantStreamTimer: ReturnType<typeof setTimeout> | null = null;
  private assistantPendingText: string | null = null;
  private lastAssistantSentAtMs = 0;

  constructor(private readonly host: WearRemoteHost) {
    this.active = wearBridge.isAvailable();
    if (!this.active) {
      host.appendLog("watch: Google Play services unavailable; watch remote disabled");
      return;
    }
    wearBridge.onMessage((message) => {
      void this.handleMessage(message).catch((error) => {
        host.appendLog(`watch: ${message.path} failed: ${formatError(error)}`);
      });
    });
    wearBridge.onWatchConnection((connection) => {
      const changed = connection.reachable !== this.watchReachable || connection.watchName !== this.watchName;
      this.watchReachable = connection.reachable;
      this.watchName = connection.watchName;
      if (changed) {
        host.appendLog(
          connection.reachable ? `watch: ${connection.watchName || "watch"} reachable` : "watch: no watch reachable",
        );
      }
      // A watch that just came into range gets the current state at once.
      if (connection.reachable) this.publishNow(true);
    });
    shell.onAssistantActivity((event) => this.forwardAssistantActivity(event));
    shell.onAlertShown((text) => {
      if (this.watchReachable && watchMirrorAssistantSetting.get()) {
        wearBridge.sendEvent({ type: "alert", text });
      }
    });
    voiceActivity.subscribe(() => this.schedulePublish());
    onAnySettingChanged(() => this.schedulePublish());
    // Catch-all refresh for state the controller does not announce (cheap:
    // identical states are dropped on the Java side).
    setInterval(() => this.schedulePublish(), STATE_REFRESH_INTERVAL_MS);
    this.schedulePublish();
  }

  /** Whether a watch running the Faceclaw watch app is reachable right now. */
  isWatchReachable(): boolean {
    return this.watchReachable;
  }

  getWatchName(): string {
    return this.watchName;
  }

  /** Mirror the dashboard state to the watch soon; coalesces bursts. */
  schedulePublish(): void {
    if (!this.active || this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.publishNow(false);
    }, STATE_PUBLISH_DEBOUNCE_MS);
  }

  private publishNow(force: boolean): void {
    if (!this.active) return;
    try {
      wearBridge.publishState(this.buildState(), force);
    } catch (error) {
      this.host.appendLog(`watch: state publish failed: ${formatError(error)}`);
    }
  }

  private buildState(): Record<string, unknown> {
    const state = this.host.getState();
    const battery = shell.getBatteryLevels();
    const foregroundId = shell.foregroundWindow()?.windowId ?? null;
    const foreground = shell.getForegroundApp();
    return {
      protocol: WEAR_PROTOCOL_VERSION,
      version: FACECLAW_VERSION,
      phase: state.phase,
      status: state.status,
      connected: state.phase === "connected" || state.phase === "charging",
      screenOn: shell.isScreenOn(),
      locked: state.glassesLocked,
      worn: state.glassesWorn,
      listening: voiceActivity.isActive(),
      battery: state.lastHeadsetBattery,
      charging: state.phase === "charging" || battery.headsetCharging === true,
      silentMode: state.silentMode,
      foreground: foreground ? { appId: foreground.appId, title: foreground.title } : null,
      windows: shell.getWindows().map((window) => ({
        windowId: window.windowId,
        title: window.title,
        appId: window.appId,
        focused: window.windowId === foregroundId,
        closeable: window.closeable,
        acceptsText: typeof window.receiveTextInput === "function",
      })),
      apps: this.listApps(),
      displayMode: displayModeSetting.get(),
      remoteEnabled: watchRemoteEnabledSetting.get(),
      crownClockwiseNext: watchCrownClockwiseNextSetting.get(),
      canUnlock: watchCanUnlockSetting.get(),
      mirrorAssistant: watchMirrorAssistantSetting.get(),
      assistantAvailable: shell.isAssistantAvailable(),
    };
  }

  /** Launchable apps, matching the launcher grid and the apps.launch tool. */
  private listApps(): Array<{ appId: string; title: string }> {
    const apps = this.host.apps.map((app) => ({ appId: app.appId, title: app.title }));
    for (const installed of getInstalledEvenHubApps()) {
      apps.push({ appId: installedEvenHubAppId(installed.packageId), title: installed.name });
    }
    return apps;
  }

  private async handleMessage(message: WearMessage): Promise<void> {
    const seq = readNumber(message.payload.seq, 0);
    const ack = (ok: boolean, text = "") => wearBridge.sendAck(message.nodeId, seq, ok, text);

    if (message.path === WEAR_PATHS.stateRequest) {
      this.publishNow(true);
      ack(true);
      return;
    }
    if (!watchRemoteEnabledSetting.get()) {
      ack(false, "Watch control is turned off in Faceclaw's Settings > Watch.");
      return;
    }

    switch (message.path) {
      case WEAR_PATHS.input:
        await this.handleInput(message.payload, ack);
        return;
      case WEAR_PATHS.command:
        await this.handleCommand(message.payload, ack);
        return;
      case WEAR_PATHS.assistant: {
        const text = readText(message.payload.text);
        if (!text) {
          ack(false, "Nothing to send.");
          return;
        }
        if (!shell.isAssistantAvailable()) {
          ack(false, "Set up the assistant in Faceclaw's Settings first.");
          return;
        }
        this.host.appendLog(`watch: assistant query (${text.length} chars)`);
        shell.sendToAssistant(text);
        ack(true);
        return;
      }
      case WEAR_PATHS.text: {
        const text = readText(message.payload.text);
        if (!text) {
          ack(false, "Nothing to type.");
          return;
        }
        const window = shell.foregroundWindow();
        if (!window?.receiveTextInput) {
          ack(false, `${window ? window.title : "The current app"} does not accept typed text.`);
          return;
        }
        if (!shell.isScreenOn()) shell.wake("window");
        this.host.appendLog(`watch: typed ${text.length} chars into ${window.title}`);
        shell.sendTextToForegroundWindow(text);
        ack(true);
        return;
      }
      default:
        ack(false, `Unknown message: ${message.path}`);
    }
  }

  private async handleInput(payload: Record<string, unknown>, ack: (ok: boolean, text?: string) => void): Promise<void> {
    const gesture = String(payload.gesture ?? "");
    if (!(INPUT_KINDS as readonly string[]).includes(gesture)) {
      ack(false, `Unknown gesture: ${gesture}`);
      return;
    }
    const kind = gesture as WearRemoteInputKind;
    const state = this.host.getState();
    if (state.phase !== "connected" && state.phase !== "charging") {
      ack(false, "The glasses are not connected.");
      return;
    }
    // The lock and a dark display only yield to a double-click, exactly as
    // the ring does (handled inside the controller).
    const repeatable = kind === "scroll-up" || kind === "scroll-down" || kind === "swipe-up" || kind === "swipe-down";
    const steps = repeatable ? Math.min(MAX_SCROLL_STEPS, Math.max(1, Math.round(readNumber(payload.steps, 1)))) : 1;
    for (let i = 0; i < steps; i++) {
      await this.host.injectInput(kind);
    }
    ack(true);
  }

  private async handleCommand(payload: Record<string, unknown>, ack: (ok: boolean, text?: string) => void): Promise<void> {
    const command = String(payload.command ?? "");
    if (!(COMMANDS as readonly string[]).includes(command)) {
      ack(false, `Unknown command: ${command}`);
      return;
    }
    const state = this.host.getState();
    const connected = state.phase === "connected" || state.phase === "charging";
    this.host.appendLog(`watch: ${command}`);
    switch (command as WearCommand) {
      case "connect":
        if (connected) {
          ack(true, "Already connected.");
          return;
        }
        ack(true, "Connecting...");
        await this.host.connect();
        return;
      case "disconnect":
        if (!connected && state.phase === "disconnected") {
          ack(true, "Already disconnected.");
          return;
        }
        ack(true, "Disconnecting...");
        await this.host.disconnect();
        return;
      default:
        break;
    }
    if (!connected) {
      ack(false, "The glasses are not connected.");
      return;
    }
    if (payload.source === "gesture" && !shell.isScreenOn()) {
      ack(true);
      return;
    }
    if (state.glassesLocked && command !== "unlock" && command !== "lock") {
      ack(false, "The glasses are locked.");
      return;
    }
    switch (command as WearCommand) {
      case "launch-app": {
        const appId = String(payload.appId ?? "").trim();
        const app = this.listApps().find((entry) => entry.appId === appId);
        if (!app) {
          ack(false, `Unknown app: ${appId}`);
          return;
        }
        shell.wake("window");
        await this.host.launchApp(appId);
        this.schedulePublish();
        ack(true, `Opened ${app.title}.`);
        return;
      }
      case "focus-window": {
        const windowId = String(payload.windowId ?? "").trim();
        const window = shell.getWindows().find((entry) => entry.windowId === windowId);
        if (!window) {
          ack(false, "That window is no longer open.");
          return;
        }
        shell.wake("window");
        shell.focusWindow(windowId);
        this.host.requestShellRender();
        this.schedulePublish();
        ack(true);
        return;
      }
      case "close-window": {
        const windowId = String(payload.windowId ?? "").trim();
        const window = shell.getWindows().find((entry) => entry.windowId === windowId);
        if (!window) {
          ack(false, "That window is no longer open.");
          return;
        }
        if (!window.closeable) {
          ack(false, `${window.title} cannot be closed.`);
          return;
        }
        shell.closeWindow(windowId);
        this.host.requestShellRender();
        this.schedulePublish();
        ack(true, `Closed ${window.title}.`);
        return;
      }
      case "sidebar":
        shell.wake("sidebar");
        shell.yieldFocusToSidebar();
        this.host.requestShellRender();
        ack(true);
        return;
      case "wake":
        if (!shell.wake("sidebar")) {
          ack(true, "The display is already on.");
          return;
        }
        this.host.requestShellRender();
        ack(true);
        return;
      case "sleep":
        if (!shell.isScreenOn()) {
          ack(true, "The display is already off.");
          return;
        }
        shell.sleep();
        ack(true);
        return;
      case "lock":
        this.host.setGlassesLocked(true, "locked from the watch");
        this.schedulePublish();
        ack(true);
        return;
      case "unlock":
        if (!watchCanUnlockSetting.get()) {
          ack(false, "Unlocking from the watch is turned off in Settings > Watch.");
          return;
        }
        this.host.setGlassesLocked(false, "unlocked from the watch");
        this.schedulePublish();
        ack(true);
        return;
      case "close-assistant":
        // Idempotent: closing an assistant that isn't open still succeeds,
        // but tell the watch which of the two happened.
        ack(true, shell.closeAssistant() ? "" : "The assistant was not open.");
        return;
      case "display-mode": {
        const value = String(payload.value ?? "");
        if (!(DISPLAY_MODE_VALUES as readonly string[]).includes(value)) {
          ack(false, `Unknown display mode: ${value}`);
          return;
        }
        displayModeSetting.set(value as (typeof DISPLAY_MODE_VALUES)[number]);
        this.schedulePublish();
        ack(true, `Display mode: ${value}`);
        return;
      }
      default:
        ack(false, `Unhandled command: ${command}`);
    }
  }

  private forwardAssistantActivity(event: AssistantActivityEvent): void {
    if (!watchMirrorAssistantSetting.get()) return;
    // No watch to mirror to: sending anyway is not free — with no known
    // watch nodes the Java side runs a capability lookup per event, which a
    // streaming reply would repeat several times a second.
    if (!this.watchReachable) return;
    if (event.phase === "streaming") {
      // Coalesce: the newest text wins, sent no more often than the interval.
      this.assistantPendingText = event.text;
      if (this.assistantStreamTimer) return;
      const wait = Math.max(0, ASSISTANT_STREAM_MIN_INTERVAL_MS - (Date.now() - this.lastAssistantSentAtMs));
      this.assistantStreamTimer = setTimeout(() => {
        this.assistantStreamTimer = null;
        if (this.assistantPendingText === null) return;
        this.sendAssistantEvent("streaming", this.assistantPendingText);
        this.assistantPendingText = null;
      }, wait);
      return;
    }
    // A phase change supersedes any queued stream snapshot.
    if (this.assistantStreamTimer) {
      clearTimeout(this.assistantStreamTimer);
      this.assistantStreamTimer = null;
    }
    this.assistantPendingText = null;
    this.sendAssistantEvent(event.phase, event.text);
    this.schedulePublish();
  }

  private sendAssistantEvent(phase: AssistantActivityEvent["phase"], text: string): void {
    this.lastAssistantSentAtMs = Date.now();
    wearBridge.sendEvent({ type: "assistant", phase, text });
  }
}

function readNumber(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function readText(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").trim().slice(0, MAX_TEXT_LENGTH);
}

function formatError(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}
