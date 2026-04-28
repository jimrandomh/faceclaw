import { ImageSource } from "@nativescript/core";
import { EventSourceType, EventSourceTypeName, OsEventTypeList, OsEventTypeName } from "./events";
import { loadDeviceAddresses } from "./device-addresses";
import { ensureBlePermissions, ensureVoicePermissions } from "./android-permissions";
import { FaceclawCommunicatorBridge, type FrameMetrics, type RawInputEvent } from "../native/faceclaw-communicator";
import { startForegroundNotification, stopForegroundNotification, updateForegroundNotification } from "../native/foreground-service";
import { mediaControllerBridge } from "../native/media-controller";
import { nightscoutBridge } from "../native/nightscout";
import { openEvenAppSettings, readEvenAppNotificationState } from "../native/even-app-conflict";
import { grayImageToPreviewSource } from "../native/gray-image-preview";
import { voiceControlBridge } from "../native/voice-control";
import {
  applyDashboardScreenTimeout,
  consumeDashboardTiledWakePaint,
  drawDashboard,
  getDashboardNightscoutSettings,
  getDashboardSystemCardName,
  isDashboardVoiceControlEnabled,
  noteDashboardPhoneTextInput,
  receiveInput,
  resetDashboardSleepTimerAndWake,
  setDashboardBatteryLevels,
  setDashboardActions,
  setDashboardNightscoutApiToken,
  setDashboardNightscoutSiteUrl,
  setDashboardSystemCardName,
  setDashboardVoiceControlEnabled,
} from "../ui/dashboard";

type ConnectionPhase = "disconnected" | "connecting" | "connected" | "disconnecting";
export type TextSettingEditorKind = "dashboard-name" | "nightscout-site-url" | "nightscout-api-token";

export type DashboardSnapshot = {
  phase: ConnectionPhase;
  status: string;
  log: string;
  displayPreview: ImageSource | null;
  systemCardName: string;
  editingSystemCardName: boolean;
  activeTextSettingEditorKind: TextSettingEditorKind | null;
  activeTextSettingTitle: string;
  activeTextSettingValue: string;
  evenAppConflictMessage: string;
  evenAppConflictWarningVisible: boolean;
};

type DashboardListener = (snapshot: DashboardSnapshot) => void;
type LogLevel = "debug"|"info"|"warn"|"error";

const CONTAINER_NAME = "dashboard";
const DASHBOARD_INTERVAL_MS = 60_000;
const SCREEN_TIMEOUT_CHECK_MS = 1_000;
const EVEN_APP_DETECTED_MESSAGE =
  "The Even Realities app appears to be running. If Faceclaw has trouble connecting, open its app settings and force stop it.";

function formatTimestamp(date: Date): string {
  return date.toISOString().slice(11, 23);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatTime24h(date: Date, includeSeconds: boolean): string {
  const hours = date.getHours();
  const minutes = pad2(date.getMinutes());
  const seconds = pad2(date.getSeconds());
  return includeSeconds
    ? `${hours}:${minutes}:${seconds}`
    : `${hours}:${minutes}`;
}

function formatUtcOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `UTC${sign}${pad2(hours)}:${pad2(minutes)}`;
}

function formatForStatus(date: Date): string {
  return formatTime24h(date, true);
}

function eventName(eventType: number): string {
  return OsEventTypeName[eventType] ?? `UNKNOWN_${eventType}`;
}

function sourceName(eventSource: number): string {
  return EventSourceTypeName[eventSource] ?? `SOURCE_${eventSource}`;
}

function normalizeContainerName(name: string): string {
  return name.replace(/[^\x20-\x7e]+/g, "");
}

function isDashboardContainerName(name: string): boolean {
  const normalized = normalizeContainerName(name);
  return normalized === CONTAINER_NAME || normalized.includes(CONTAINER_NAME);
}

class DashboardController {
  private phase: ConnectionPhase = "disconnected";
  private status = "Disconnected.";
  private log = "";
  private editingSystemCardName = false;
  private activeTextSettingEditorKind: TextSettingEditorKind | null = null;
  private evenNotificationActive = false;
  private evenAppConflictMessage = "";
  private displayPreview: ImageSource | null = null;
  private readonly listeners = new Set<DashboardListener>();

  private communicator: FaceclawCommunicatorBridge | null = null;
  private dashboardTimer: ReturnType<typeof setInterval> | null = null;
  private screenTimeoutTimer: ReturnType<typeof setInterval> | null = null;
  private offState: (() => void) | null = null;
  private offLog: (() => void) | null = null;
  private offRing: (() => void) | null = null;
  private offBattery: (() => void) | null = null;
  private offEvenAppConflict: (() => void) | null = null;
  private offFrameMetrics: (() => void) | null = null;
  private offMedia: (() => void) | null = null;
  private offNightscout: (() => void) | null = null;
  private offVoiceStatus: (() => void) | null = null;
  private offVoiceWakeWord: (() => void) | null = null;
  private lastInput = "waiting...";
  private lastSys = "none yet";
  private renderInProgress = false;
  private renderQueued = false;
  private queuedRenderReason: "initial" | "interval" = "interval";

  constructor() {
    setDashboardActions({
      disconnect: () => this.disconnect(),
      startSystemNameEdit: () => this.startSystemNameEdit(),
      endSystemNameEdit: () => this.endSystemNameEdit(),
      startNightscoutSiteUrlEdit: () => this.startNightscoutSiteUrlEdit(),
      startNightscoutApiTokenEdit: () => this.startNightscoutApiTokenEdit(),
      endTextSettingEdit: () => this.endTextSettingEdit(),
      setVoiceControlEnabled: (enabled) => this.setVoiceControlEnabled(enabled),
    });
  }

  subscribe(listener: DashboardListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): DashboardSnapshot {
    return {
      phase: this.phase,
      status: this.status,
      log: this.log,
      displayPreview: this.displayPreview,
      systemCardName: getDashboardSystemCardName(),
      editingSystemCardName: this.editingSystemCardName,
      activeTextSettingEditorKind: this.activeTextSettingEditorKind,
      activeTextSettingTitle: this.getActiveTextSettingTitle(),
      activeTextSettingValue: this.getActiveTextSettingValue(),
      evenAppConflictMessage: this.evenAppConflictMessage,
      evenAppConflictWarningVisible: this.evenAppConflictMessage.length > 0,
    };
  }

  refreshEvenAppStatus(): void {
    const state = readEvenAppNotificationState();
    const wasActive = this.evenNotificationActive;
    this.evenNotificationActive = state.evenNotificationActive;
    if (state.evenNotificationActive && !wasActive) {
      this.appendLog("Even app notification is active.");
    }
    if (state.evenNotificationActive && !this.evenAppConflictMessage) {
      this.evenAppConflictMessage = EVEN_APP_DETECTED_MESSAGE;
      this.emit();
    }
    if (!state.evenNotificationActive && this.evenAppConflictMessage) {
      this.evenAppConflictMessage = "";
      this.emit();
    }
  }

  openEvenAppSettings(): void {
    openEvenAppSettings();
  }

  setSystemCardName(name: string): void {
    const savedName = setDashboardSystemCardName(name);
    this.emit();
    if (this.phase === "connected" && this.communicator) {
      void this.requestRender("interval").catch((error) => {
        this.appendLog(`dashboard name update failed: ${this.formatError(error)}`);
      });
    } else {
      const image = drawDashboard();
      this.setDisplayPreview(grayImageToPreviewSource(image));
    }
    if (savedName !== name) {
      this.emit();
    }
  }

  setActiveTextSettingValue(value: string): void {
    noteDashboardPhoneTextInput();
    switch (this.activeTextSettingEditorKind) {
      case "dashboard-name":
        this.setSystemCardName(value);
        return;
      case "nightscout-site-url":
        setDashboardNightscoutSiteUrl(value);
        this.emit();
        this.previewOrRenderAfterTextSettingChange("nightscout site URL");
        return;
      case "nightscout-api-token":
        setDashboardNightscoutApiToken(value);
        this.emit();
        this.previewOrRenderAfterTextSettingChange("nightscout API token");
        return;
      default:
        return;
    }
  }

  endSystemNameEdit(): void {
    if (!this.editingSystemCardName) return;
    this.editingSystemCardName = false;
    if (this.activeTextSettingEditorKind === "dashboard-name") {
      this.activeTextSettingEditorKind = null;
    }
    this.emit();
  }

  async connect(): Promise<void> {
    if (this.phase !== "disconnected") return;

    const addresses = loadDeviceAddresses();
    if (!addresses.right || !addresses.left) {
      const message = "Configure both left and right arm MAC addresses before connecting.";
      this.setPhase("disconnected");
      this.setStatus(`Failed: ${message}`);
      this.appendLog(`error: ${message}`);
      throw new Error(message);
    }
    this.log = "";
    this.lastInput = "waiting...";
    this.lastSys = "none yet";
    resetDashboardSleepTimerAndWake();
    this.refreshEvenAppStatus();
    this.setPhase("connecting");
    this.setStatus("Connecting to the glasses...");
    this.appendLog(
      `Using configured arms: R=${addresses.right} L=${addresses.left}${addresses.ring ? ` ring=${addresses.ring}` : ""}`,
    );

    let communicator: FaceclawCommunicatorBridge | null = null;

    try {
      await ensureBlePermissions();
      startForegroundNotification("Connecting to the glasses");
      communicator = new FaceclawCommunicatorBridge({
        right: addresses.right,
        left: addresses.left,
        ring: addresses.ring,
      });
      this.communicator = communicator;
      this.offLog = communicator.onLog((line) => {
        this.appendLog(line);
      });
      this.offState = communicator.onStateChange((state) => {
        const mappedPhase =
          state.phase === "connected"
            ? "connected"
            : state.phase === "disconnecting"
              ? "disconnecting"
              : state.phase === "disconnected"
                ? "disconnected"
                : "connecting";
        this.setPhase(mappedPhase);
        this.setStatus(state.status);
      });
      this.offRing = communicator.onRingEvent((event) => {
        void this.handleInputEvent(event).catch((error) => {
          const message = this.formatError(error);
          this.appendLog(`input handler failed: ${message}`);
        });
      });
      this.offBattery = communicator.onBatteryState((state) => {
        setDashboardBatteryLevels({
          headset: state.battery,
          headsetCharging: state.chargingStatus > 0,
        });
        if (this.phase === "connected" && this.communicator) {
          void this.requestRender("interval").catch((error) => {
            const message = this.formatError(error);
            this.appendLog(`battery update failed: ${message}`);
          });
        }
      });
      this.offEvenAppConflict = communicator.onEvenAppConflict((message) => {
        this.refreshEvenAppStatus();
        if (!this.evenNotificationActive) {
          this.appendLog(`Even app conflict suspected, but notification was not active: ${message}`);
          return;
        }
        this.evenAppConflictMessage = message;
        this.appendLog(message);
        this.emit();
      });
      this.offFrameMetrics = communicator.onFrameMetrics((metrics) => {
        if (this.phase === "connected") {
          this.setStatus(`Connected. Last frame: ${this.formatFrameMetrics(metrics)}.`);
        }
      });
      this.offMedia = mediaControllerBridge.onStateChange(() => {
        if (this.phase === "connected" && this.communicator) {
          void this.requestRender("interval").catch((error) => {
            const message = this.formatError(error);
            this.appendLog(`media update failed: ${message}`);
          });
        }
      });
      this.offNightscout = nightscoutBridge.onStateChange(() => {
        if (this.phase === "connected" && this.communicator) {
          void this.requestRender("interval").catch((error) => {
            const message = this.formatError(error);
            this.appendLog(`nightscout update failed: ${message}`);
          });
        }
      });
      this.offVoiceStatus = voiceControlBridge.onStatus((state) => {
        this.appendLog(state.status);
      });
      this.offVoiceWakeWord = voiceControlBridge.onWakeWord((keyword) => {
        void this.handleWakeWord(keyword).catch((error) => {
          this.appendLog(`wake-word handler failed: ${this.formatError(error)}`);
        });
      });

      await mediaControllerBridge.start();
      await nightscoutBridge.start();
      await communicator.start();
      await this.requestRender("initial");
      this.startVoiceControlIfEnabled();
      this.dashboardTimer = setInterval(() => {
        void this.requestRender("interval").catch((error) => {
          const message = this.formatError(error);
          this.setStatus(`Dashboard update failed: ${message}`);
          this.appendLog(`dashboard update failed: ${message}`);
        });
      }, DASHBOARD_INTERVAL_MS);
      this.screenTimeoutTimer = setInterval(() => {
        if (this.phase !== "connected" || !this.communicator) return;
        if (!applyDashboardScreenTimeout()) return;
        this.endTextSettingEdit();
        void this.requestRender("interval").catch((error) => {
          const message = this.formatError(error);
          this.appendLog(`screen timeout render failed: ${message}`);
        });
      }, SCREEN_TIMEOUT_CHECK_MS);
    } catch (error) {
      const message = this.formatError(error);
      this.offState?.();
      this.offState = null;
      this.offLog?.();
      this.offLog = null;
      this.offRing?.();
      this.offRing = null;
      this.offBattery?.();
      this.offBattery = null;
      this.offEvenAppConflict?.();
      this.offEvenAppConflict = null;
      this.offFrameMetrics?.();
      this.offFrameMetrics = null;
      this.offMedia?.();
      this.offMedia = null;
      this.offNightscout?.();
      this.offNightscout = null;
      this.offVoiceStatus?.();
      this.offVoiceStatus = null;
      this.offVoiceWakeWord?.();
      this.offVoiceWakeWord = null;
      await mediaControllerBridge.stop().catch(() => {});
      await nightscoutBridge.stop().catch(() => {});
      voiceControlBridge.stop();
      if (communicator) {
        await communicator.close().catch(() => {});
      }
      this.communicator = null;
      this.clearDashboardTimer();
      stopForegroundNotification();
      this.setPhase("disconnected");
      this.setStatus(`Failed: ${message}`);
      this.appendLog(`error: ${message}`);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.phase === "disconnected" || this.phase === "disconnecting") return;

    this.setPhase("disconnecting");
    this.setStatus("Disconnecting...");
    this.clearDashboardTimer();
    this.offState?.();
    this.offState = null;
    this.offLog?.();
    this.offLog = null;
    this.offRing?.();
    this.offRing = null;
    this.offBattery?.();
    this.offBattery = null;
    this.offEvenAppConflict?.();
    this.offEvenAppConflict = null;
    this.offFrameMetrics?.();
    this.offFrameMetrics = null;
    this.offMedia?.();
    this.offMedia = null;
    this.offNightscout?.();
    this.offNightscout = null;
    this.offVoiceStatus?.();
    this.offVoiceStatus = null;
    this.offVoiceWakeWord?.();
    this.offVoiceWakeWord = null;

    const communicator = this.communicator;
    this.communicator = null;

    try {
      const shutdownAcked = await communicator?.sendShutdown(0).catch((error) => {
        this.appendLog(`shutdown command failed: ${this.formatError(error)}`);
        return false;
      });
      if (shutdownAcked === true) {
        this.appendLog("Shutdown command completed.");
      } else if (communicator) {
        this.appendLog("Shutdown command did not complete before disconnect.");
      }
      await mediaControllerBridge.stop().catch(() => {});
      await nightscoutBridge.stop().catch(() => {});
      voiceControlBridge.stop();
      await communicator?.close().catch(() => {});
    } finally {
      stopForegroundNotification();
      this.setPhase("disconnected");
      this.setStatus("Disconnected.");
      this.appendLog("Disconnected from the glasses.");
    }
  }

  async injectSyntheticRingInput(kind: "click" | "double-click" | "scroll-up" | "scroll-down"): Promise<void> {
    const event = this.buildSyntheticRingInput(kind);
    await this.handleInputEvent(event);
  }

  private startSystemNameEdit(): void {
    this.editingSystemCardName = true;
    this.activeTextSettingEditorKind = "dashboard-name";
    this.emit();
  }

  private startNightscoutSiteUrlEdit(): void {
    this.editingSystemCardName = false;
    this.activeTextSettingEditorKind = "nightscout-site-url";
    this.emit();
  }

  private startNightscoutApiTokenEdit(): void {
    this.editingSystemCardName = false;
    this.activeTextSettingEditorKind = "nightscout-api-token";
    this.emit();
  }

  private async setVoiceControlEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      try {
        await ensureVoicePermissions();
      } catch (error) {
        this.appendLog(`voice control permission failed: ${this.formatError(error)}`);
        return;
      }
    }

    setDashboardVoiceControlEnabled(enabled);
    this.appendLog(`Voice control ${enabled ? "enabled" : "disabled"}.`);
    if (enabled) {
      this.startVoiceControlIfEnabled();
    } else {
      voiceControlBridge.stop();
    }
    if (this.phase === "connected" && this.communicator) {
      await this.requestRender("interval").catch((error) => {
        this.appendLog(`voice setting render failed: ${this.formatError(error)}`);
      });
    }
  }

  private endTextSettingEdit(): void {
    const finishedKind = this.activeTextSettingEditorKind;
    this.editingSystemCardName = false;
    this.activeTextSettingEditorKind = null;
    this.emit();
    if (finishedKind === "nightscout-site-url" || finishedKind === "nightscout-api-token") {
      void this.refreshNightscoutAfterSettingsChange();
    }
  }

  private getActiveTextSettingTitle(): string {
    switch (this.activeTextSettingEditorKind) {
      case "dashboard-name":
        return "Dashboard name";
      case "nightscout-site-url":
        return "Nightscout site URL";
      case "nightscout-api-token":
        return "Nightscout API token";
      default:
        return "";
    }
  }

  private getActiveTextSettingValue(): string {
    const nightscoutSettings = getDashboardNightscoutSettings();
    switch (this.activeTextSettingEditorKind) {
      case "dashboard-name":
        return getDashboardSystemCardName();
      case "nightscout-site-url":
        return nightscoutSettings.siteUrl;
      case "nightscout-api-token":
        return nightscoutSettings.apiToken;
      default:
        return "";
    }
  }

  private async refreshNightscoutAfterSettingsChange(): Promise<void> {
    await nightscoutBridge.refreshNow().catch((error) => {
      this.appendLog(`nightscout settings refresh failed: ${this.formatError(error)}`);
    });
    if (this.phase === "connected" && this.communicator) {
      await this.requestRender("interval").catch((error) => {
        this.appendLog(`nightscout settings render failed: ${this.formatError(error)}`);
      });
    } else {
      const image = drawDashboard();
      this.setDisplayPreview(grayImageToPreviewSource(image));
    }
  }

  private previewOrRenderAfterTextSettingChange(label: string): void {
    if (this.phase === "connected" && this.communicator) {
      void this.requestRender("interval").catch((error) => {
        this.appendLog(`${label} update failed: ${this.formatError(error)}`);
      });
      return;
    }
    const image = drawDashboard();
    this.setDisplayPreview(grayImageToPreviewSource(image));
  }

  private async requestRender(reason: "initial" | "interval"): Promise<void> {
    this.queuedRenderReason = this.queuedRenderReason === "initial" ? "initial" : reason;
    if (this.renderInProgress) {
      this.renderQueued = true;
      return;
    }

    this.renderInProgress = true;
    try {
      do {
        const nextReason = this.queuedRenderReason;
        this.renderQueued = false;
        this.queuedRenderReason = "interval";
        await this.renderDashboard(nextReason);
      } while (this.renderQueued);
    } finally {
      this.renderInProgress = false;
    }
  }

  private async renderDashboard(reason: "initial" | "interval"): Promise<void> {
    const paintStartedAtMs = Date.now();
    const image = drawDashboard();
    const paintMs = Date.now() - paintStartedAtMs;
    const forceTiledCommit = consumeDashboardTiledWakePaint();
    const fingerprint = image.fingerprint();
    const tiles = image.toEvenHubTiles().map((tile) => tile.bmp);
    if (this.communicator) {
      await this.communicator.submitDashboardImage(tiles, fingerprint, forceTiledCommit, paintMs);
    }
    this.setDisplayPreview(grayImageToPreviewSource(image));

    if (this.phase === "connected") {
      updateForegroundNotification(`Connected`);
    }
    this.appendLog(`${reason === "initial" ? "initial" : "scheduled"} dashboard image queued`);
  }

  private async handleInputEvent(event: RawInputEvent): Promise<void> {
    await receiveInput(event);

    if (event.kind === "sys-event") {
      this.lastSys = `${sourceName(event.eventSource)}/${eventName(event.eventType)}`;
      this.appendLog(`sys-event ${this.lastSys}`);

      if (
        event.eventType === OsEventTypeList.FOREGROUND_EXIT_EVENT ||
        event.eventType === OsEventTypeList.ABNORMAL_EXIT_EVENT ||
        event.eventType === OsEventTypeList.SYSTEM_EXIT_EVENT
      ) {
        this.appendLog("display state invalidated by firmware exit event");
      }

      if (event.eventSource === EventSourceType.TOUCH_EVENT_FROM_RING) {
        this.lastInput = eventName(event.eventType);
      }
      await this.requestRender("interval");
      return;
    }

    if (event.kind === "text-click" && isDashboardContainerName(event.containerName)) {
      if (
        event.eventType === OsEventTypeList.SCROLL_TOP_EVENT ||
        event.eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT
      ) {
        this.lastSys = `TEXT/${eventName(event.eventType)}`;
        this.lastInput = `TEXT_${eventName(event.eventType)}`;
        this.appendLog(`text-event ${this.lastSys}`);
        await this.requestRender("interval");
      }
    }
  }

  private async handleWakeWord(keyword: string): Promise<void> {
    const normalized = keyword.trim();
    if (normalized.length === 0) return;
    this.appendLog(`wake-word detected: ${normalized}`);
    const changed = resetDashboardSleepTimerAndWake();
    if (this.phase === "connected" && this.communicator) {
      if (changed) {
        await this.requestRender("initial");
      }
      return;
    }
    if (changed) {
      const image = drawDashboard();
      this.setDisplayPreview(grayImageToPreviewSource(image));
    }
  }

  private startVoiceControlIfEnabled(): void {
    if (!this.communicator) return;
    if (!isDashboardVoiceControlEnabled()) return;
    if (this.phase === "connected") {
      updateForegroundNotification("Connected");
    }
    voiceControlBridge.start();
  }

  private clearDashboardTimer(): void {
    if (this.dashboardTimer) {
      clearInterval(this.dashboardTimer);
      this.dashboardTimer = null;
    }
    if (this.screenTimeoutTimer) {
      clearInterval(this.screenTimeoutTimer);
      this.screenTimeoutTimer = null;
    }
  }

  private setPhase(phase: ConnectionPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit();
  }

  private setStatus(status: string): void {
    if (this.status === status) return;
    this.status = status;
    this.emit();
  }

  private formatFrameMetrics(metrics: FrameMetrics): string {
    return `paint=${Math.round(metrics.paintMs)}ms, transmit=${Math.round(metrics.transmitMs)}ms, tiles=${Math.round(metrics.tileCount)}`;
  }

  private appendLog(line: string): void {
    const stamped = `[${formatTimestamp(new Date())}] ${line}`;
    this.log = this.log ? `${this.log}\n${stamped}` : stamped;
    console.log(stamped);
    this.emit();
  }

  private setDisplayPreview(preview: ImageSource | null): void {
    if (this.displayPreview === preview) return;
    this.displayPreview = preview;
    this.emit();
  }

  private formatError(error: unknown): string {
    const raw = (error as Error)?.message ?? String(error);
    const sanitized = raw.replace(/[\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim();
    if (sanitized.length <= 240) return sanitized;
    return `${sanitized.slice(0, 237)}...`;
  }

  private buildSyntheticRingInput(kind: "click" | "double-click" | "scroll-up" | "scroll-down"): RawInputEvent {
    switch (kind) {
      case "click":
        return {
          kind: "sys-event",
          containerName: CONTAINER_NAME,
          eventType: OsEventTypeList.CLICK_EVENT,
          eventSource: EventSourceType.TOUCH_EVENT_FROM_RING,
          systemExitReasonCode: 0,
        };
      case "double-click":
        return {
          kind: "sys-event",
          containerName: CONTAINER_NAME,
          eventType: OsEventTypeList.DOUBLE_CLICK_EVENT,
          eventSource: EventSourceType.TOUCH_EVENT_FROM_RING,
          systemExitReasonCode: 0,
        };
      case "scroll-up":
        return {
          kind: "text-click",
          containerName: CONTAINER_NAME,
          eventType: OsEventTypeList.SCROLL_TOP_EVENT,
          eventSource: EventSourceType.TOUCH_EVENT_FROM_RING,
          systemExitReasonCode: 0,
        };
      case "scroll-down":
      default:
        return {
          kind: "text-click",
          containerName: CONTAINER_NAME,
          eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT,
          eventSource: EventSourceType.TOUCH_EVENT_FROM_RING,
          systemExitReasonCode: 0,
        };
    }
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

export const dashboardController = new DashboardController();
