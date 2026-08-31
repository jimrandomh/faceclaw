import { Application, ImageSource } from "@nativescript/core";
import { EvenAIStatus, EvenAIStatusName, EventSourceType, EventSourceTypeName, OsEventTypeList, OsEventTypeName, WatchGestureType, WatchGestureTypeName } from "./events";
import { isValidMacAddress, loadDeviceAddresses } from "./device-addresses";
import {
  ensureBlePermissions,
  ensureVoicePermissions,
  hasMicrophonePermission,
  requestMicrophonePermission,
} from "./android-permissions";
import { FaceclawCommunicatorBridge, type RawInputEvent } from "../native/faceclaw-communicator";
import * as frameTimings from "../native/frame-timings";
import { startForegroundNotification, stopForegroundNotification, updateForegroundNotification } from "../native/foreground-service";
import { mediaControllerBridge } from "../native/media-controller";
import { nightscoutBridge } from "../native/nightscout-bridge";
import { onAndroidNotificationPosted } from "../native/notification-icons";
import { openEvenAppSettings, readEvenAppNotificationState } from "../native/even-app-conflict";
import { grayImageToPreviewSource } from "../native/gray-image-preview";
import { firmwareIncompatibilityMessage } from "./firmware-compat";
import { hasExtractedEvenHubFonts } from "./firmware-builder";
import { resumeAutoReconnect, suppressAutoReconnect } from "./reconnect-policy";
import { WearRemote, type WearRemoteInputKind } from "./wear-remote";

/** Who a synthetic (non-firmware) input stands for. */
type SyntheticInputOrigin = "ring" | "watch";

/** Gestures the phone's mirror view reports (see handleMirrorTouch). */
export type MirrorTouchKind =
  | "tap"
  | "double-tap"
  | "long-press"
  | "swipe-up"
  | "swipe-down"
  | "swipe-left"
  | "swipe-right";

const MIRROR_TOUCH_GESTURES: Record<Exclude<MirrorTouchKind, "tap">, WearRemoteInputKind> = {
  "double-tap": "double-click",
  "long-press": "long-press",
  "swipe-up": "swipe-up",
  "swipe-down": "swipe-down",
  "swipe-left": "swipe-left",
  "swipe-right": "swipe-right",
};
import { findSoundEffect, playSoundEffect } from "../ui/sound-effects";
import { isWelcomeSoundPending, setWelcomeSoundPending } from "../phone-ui/onboarding-state";
import { beginRenderPass, endRenderPass } from "../util/render-freshness";
import { voiceControlBridge } from "../native/voice-control";
import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../graphics/image";
import { flattenPlanesWithDraws, planesFingerprint, type Plane } from "../graphics/plane";
import { prepareFrameDraws } from "../graphics/glyph-wire";
import { getDefaultMediumFont } from "../graphics/ui-fonts";
import { wrapText } from "../graphics/textwrap";
import { rawInputEventToInputEvent, shell, type ShellInputOutcome } from "../ui/shell/shell";
import { registerSystemTools } from "../assistant/system-tools";
import { registerNavigateTools } from "../assistant/navigate-tools";
import { registerRoamTools } from "../assistant/roam-tools";
import { assistantBridge } from "../assistant/bridge-client";
import { registerWindowTools } from "../assistant/window-tools";
import { registerTimerTools } from "../assistant/timer-tools";
import { WorkerAppHost } from "../ui/shell/worker-window";
import { ALL_APPS } from "../apps/all-apps";
import { type AppContext, type AppDefinition, type AppLaunchParams, type TextEditorHost } from "../apps/app-definition";
import { type InProcessAppOptions, type InProcessWindow } from "../ui/shell/in-process-window";
import { loadPersistedOpenApps, savePersistedOpenApps } from "../ui/shell/open-apps-persistence";
import { appViewportRect, SIDEBAR_WIDTH, sidebarStripVisible, type WindowHeightMode } from "../ui/shell/geometry";
import { type LayerActions, type TextSettingsEditToggle } from "../ui/layers";
import { assistantAllowProactiveSetting, assistantBackendSetting, assistantBridgeHostSetting, assistantBridgePortSetting, assistantBridgeTokenSetting, brightnessSetting, brightnessSettingToLevel, displayModeSetting, elevenLabsApiKeySetting, getStringSettingById, openAiApiKeySetting, nightscoutApiTokenSetting, firmwareDebugFlagsSetting, lockScreenEnabledSetting, nightscoutSiteUrlSetting, onAnySettingChanged, previewColorSetting, ringConnectionModeSetting, saveVoiceRecordingsSetting, sonioxApiKeySetting, screenTimeoutSetting, screenTimeoutSettingToMs, suspendEvenHubWhenScreenOffSetting, verticalPositionSetting, voiceProviderSetting, wakeWordActionSetting, type ConfigSettingString } from "../ui/dashboard-settings";
import { isIgnoringBatteryOptimizations, requestIgnoreBatteryOptimizations } from "../native/battery-optimization";
import {
  getInstalledEvenHubAppById,
  installedEvenHubPackageId,
  uninstallEvenHubPackage,
} from "../apps/evenhub/installed-apps";
import { closeRunningPackage, launchInstalledPackage } from "../apps/evenhub/manager";
import { wearerVerificationOptions } from "../apps/microphones/speakers";
import { micSession } from "../apps/microphones/mic-session";
import { glassesDisplayLabel } from "./glasses-display-state";
import { PreviewDisplayTarget, type DisplayTarget } from "../native/preview-display";
import { isPreviewOnlyMode } from "../phone-ui/onboarding-state";

type ConnectionPhase = "disconnected" | "connecting" | "connected" | "charging" | "disconnecting";

export type DashboardSnapshot = {
  phase: ConnectionPhase;
  status: string;
  displayPreview: ImageSource | null;
  /**
   * When non-empty, the phone UI shows this instead of the display preview:
   * the preview would be a black rectangle indistinguishable from dead
   * glasses, and this says which harmless thing is actually going on.
   */
  displayPreviewMessage: string;
  activeTextSettingId: string | null;
  activeTextEditorTitle: string;
  activeTextSettingTitle: string;
  activeTextSettingValue: string;
  activeTextSettingInputKind: "text" | "email" | "password";
  secondaryTextSettingId: string | null;
  secondaryTextSettingTitle: string;
  secondaryTextSettingValue: string;
  secondaryTextSettingInputKind: "text" | "email" | "password";
  activeTextEditorToggleLabel: string;
  activeTextEditorToggleValue: boolean;
  activeTextEditorToggleVisible: boolean;
  evenAppConflictMessage: string;
  evenAppConflictWarningVisible: boolean;
  firmwareWarningMessage: string;
  firmwareWarningVisible: boolean;
  screenRecordingActive: boolean;
  batteryOptimizationWarningVisible: boolean;
  fontsMissingWarningVisible: boolean;
  /**
   * True while the headless preview display is standing in for a glasses
   * connection (preview-only mode): the mirror is live and interactive, but
   * nothing is paired, so "Disconnected" would be the wrong label.
   */
  previewMode: boolean;
};

type DashboardListener = (snapshot: DashboardSnapshot) => void;

// The shell chrome (sidebar + top bar + overlays) composites above all app
// window surfaces with color-key transparency.
const SHELL_SURFACE_ID = "shell";
const LOCK_SCREEN_SURFACE_ID = "lock-screen";
const LOCK_SCREEN_MESSAGE = "Glasses locked; unlock the phone to unlock the glasses.";
// Top-bar clock refresh; the phone-side preview polls the Java composite so
// it reflects every app (including worker apps the TS side never renders).
const SHELL_REFRESH_INTERVAL_MS = 60_000;
// Safety-net poll only; the preview is event-driven (every composited frame
// schedules a refresh), so this just covers anything that slips through.
const PREVIEW_INTERVAL_MS = 1_000;
const SCREEN_TIMEOUT_CHECK_MS = 1_000;
const EVENHUB_SCREEN_OFF_SUSPEND_DELAY_MS = 5_000;
const EVENHUB_WAKE_READY_TIMEOUT_MS = 4_500;
const FOREGROUND_NOTIFICATION_MIN_UPDATE_MS = 30_000;
const FRAME_TRANSMIT_BACKPRESSURE_TIMEOUT_MS = 6_000;
// Preview refresh floor. Refreshes are scheduled per composited frame with a
// trailing update, so the mirror tracks the glasses within this bound instead
// of the old 1s poll (which lagged up to two polls behind).
const CONNECTED_PREVIEW_MIN_UPDATE_MS = 150;
// The GIF recorder keeps its old cadence; per-frame captures would balloon it.
const RECORDING_MIN_CAPTURE_MS = 1_000;
// Below this, a disconnect is more likely a flat battery than a BLE problem.
const LOW_BATTERY_PERCENT = 5;
const EVEN_APP_DETECTED_MESSAGE =
  "The Even Realities app appears to be running. If Faceclaw has trouble connecting, open its app settings and force stop it.";

// The launcher grid's app list; also fixes the app ids apps.launch accepts.
const LAUNCHABLE_APPS = ALL_APPS.filter((app) => app.showInLauncher !== false);

function createInitialDisplayPreview(): ImageSource | null {
  return grayImageToPreviewSource(new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0));
}

function createLockScreenImage(): GrayImage {
  const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
  const font = getDefaultMediumFont();
  const boxWidth = 480;
  const boxHeight = 150;
  const boxX = Math.round((G2_LENS_WIDTH - boxWidth) / 2);
  const boxY = Math.round((G2_LENS_HEIGHT - boxHeight) / 2);
  image.drawRoundedRect(boxX, boxY, boxWidth, boxHeight, 150, 12);
  const lines = wrapText(font, LOCK_SCREEN_MESSAGE, boxWidth - 64);
  const textHeight = lines.length * font.lineHeight;
  const firstY = boxY + Math.round((boxHeight - textHeight) / 2);
  lines.forEach((line, index) => {
    const x = Math.round((G2_LENS_WIDTH - font.measureText(line)) / 2);
    image.drawText(font, x, firstY + index * font.lineHeight, line, 230);
  });
  return image;
}

function formatTimestamp(date: Date): string {
  return date.toISOString().slice(11, 23);
}

function eventName(eventType: number): string {
  return OsEventTypeName[eventType] ?? `UNKNOWN_${eventType}`;
}

/**
 * Event-type label for logs. "even-ai" frames carry eEvenAIStatus, not an
 * OsEventTypeList value, so naming them with the OS table would be wrong
 * (status 1 would read as "SCROLL_TOP_EVENT").
 */
function eventLabel(kind: string, eventType: number): string {
  if (kind === "even-ai") {
    return EvenAIStatusName[eventType] ?? `EVEN_AI_UNKNOWN_${eventType}`;
  }
  if (kind === "watch-gesture") {
    return WatchGestureTypeName[eventType] ?? `WATCH_UNKNOWN_${eventType}`;
  }
  return eventName(eventType);
}

function sourceName(eventSource: number): string {
  return EventSourceTypeName[eventSource] ?? `SOURCE_${eventSource}`;
}

class DashboardController {
  private phase: ConnectionPhase = "disconnected";
  private status = "Disconnected.";
  private activeTextSettings: ConfigSettingString[] = [];
  private activeTextEditorTitle = "";
  private activeTextEditorOnFinish: (() => void) | null = null;
  private activeTextEditorToggle: TextSettingsEditToggle | null = null;
  private evenNotificationActive = false;
  private evenAppConflictMessage = "";
  private firmwareWarningMessage = "";
  private batteryOptimizationWarningVisible = false;
  private fontsMissingWarningVisible = false;
  // Sticky positive: the extracted-font file doesn't vanish mid-session, so a
  // successful check spares later refreshes the file read and JSON parse.
  private extractedFontsConfirmed = false;
  private screenRecordingActive = false;
  private displayPreview: ImageSource | null = createInitialDisplayPreview();
  private silentMode = false;
  // Brightness value last pushed to the glasses; see pushBrightness.
  private lastPushedBrightness: string | null = null;
  // Last battery level the glasses reported, kept across disconnects so a
  // drop-off right after a low reading can be explained as a flat battery.
  private lastHeadsetBattery: number | null = null;
  private readonly listeners = new Set<DashboardListener>();
  // Set at connect time from the persisted flag; the one-time post-onboarding
  // welcome sound plays on the first rendered frame (proof the session is warm).
  private welcomeSoundArmed = false;

  private communicator: FaceclawCommunicatorBridge | null = null;
  // Headless stand-in for the compositor when no glasses are paired
  // (preview-only mode); a real connection always outranks it. See `display`.
  private previewTarget: PreviewDisplayTarget | null = null;
  private shellRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private previewTimer: ReturnType<typeof setInterval> | null = null;
  private screenTimeoutTimer: ReturnType<typeof setInterval> | null = null;
  private evenHubSuspendTimer: ReturnType<typeof setTimeout> | null = null;
  private evenHubSessionSuspended = false;
  private evenHubResumePromise: Promise<boolean> | null = null;
  private faceclawWakeLeaseSupported = false;
  private faceclawWakeLeaseState: boolean | null = null;
  private wearNotifySupported = false;
  private glassesWorn: boolean | null = null;
  private phoneLocked = false;
  private glassesLocked = false;
  // Wear OS watch remote; constructed last so it sees a fully wired shell.
  private wearRemote: WearRemote | null = null;
  private lockSurfaceConfigured = false;
  private lastLockScreenEnabled = lockScreenEnabledSetting.get();
  private offState: (() => void) | null = null;
  private offLog: (() => void) | null = null;
  private offRing: (() => void) | null = null;
  private offBattery: (() => void) | null = null;
  private offSilentMode: (() => void) | null = null;
  private offWearState: (() => void) | null = null;
  private offPhoneLockState: (() => void) | null = null;
  private offEvenAppConflict: (() => void) | null = null;
  private offFrameMetrics: (() => void) | null = null;
  private offFirmwareInfo: (() => void) | null = null;
  private offVoiceStatus: (() => void) | null = null;
  private offAndroidNotification: (() => void) | null = null;
  private lastInput = "waiting...";
  private lastSys = "none yet";
  private shellRenderInProgress = false;
  private shellRenderQueued = false;
  /** Input frame that requested the next shell render; see requestShellRender. */
  private pendingShellRenderCauseFrameId = 0;
  private nextShellRenderWantsFreshData = false;
  // One shared worker per app hosts all its windows; spawned on first launch.
  private readonly appHosts = new Map<string, WorkerAppHost>();
  // The window hosting the on-glasses text-setting editor (the Settings app
  // registers itself); edit flows from the phone UI reach it through this.
  private textEditorHost: TextEditorHost | null = null;
  // Other in-process singleton apps, keyed by windowId.
  private readonly inProcessApps = new Map<string, InProcessWindow>();
  private sharedActions!: Omit<LayerActions, "requestRender">;
  private lastForegroundNotificationUpdateAtMs = 0;
  private lastConnectedPreviewUpdateAtMs = 0;
  // Saving the open-app list is gated until the one-time restore has run, so
  // the boot-time registry (just the launcher) never clobbers the saved list.
  private openAppsRestored = false;
  private suppressOpenAppsPersist = false;
  // connect() is a long sequence of awaits against this.communicator; the
  // incompatible-firmware disconnect must not tear that communicator down
  // underneath it, so it waits for this to clear.
  private connectRunning = false;
  private incompatibleDisconnectPending = false;
  private unpairedDisconnectPending = false;

  constructor() {
    const sharedActions = {
      disconnect: () => this.disconnect(),
      startTextSettingEdit: (setting: ConfigSettingString) => this.startTextSettingEdit(setting),
      startTextSettingsEdit: (
        settings: readonly ConfigSettingString[],
        title: string,
        onFinish?: () => void,
        toggle?: TextSettingsEditToggle,
      ) => this.startTextSettingsEdit(settings, title, onFinish, toggle),
      endTextSettingEdit: () => this.endTextSettingEdit(),
      startVoiceCapture: () => this.startVoiceCapture(),
      stopVoiceCapture: () => this.stopVoiceCapture(),
      startContinuousVoiceCapture: () => this.startContinuousVoiceCapture(),
      stopContinuousVoiceCapture: () => this.stopContinuousVoiceCapture(),
      playBuzzerSequence: (payload: Uint8Array) => this.playBuzzerSequence(payload),
    };
    this.sharedActions = sharedActions;
    // The always-available assistant tools (calendar, media, notifications,
    // glasses state) register once at startup, independent of any connection.
    registerSystemTools();
    // nav.* tools launch the Navigate app on demand, so they need launchApp.
    registerNavigateTools((appId) => this.launchApp(appId));
    // roam.* tools launch the Roam app on demand likewise.
    registerRoamTools((appId) => this.launchApp(appId));
    // timer.* tools launch the Timer app on demand likewise.
    registerTimerTools((appId) => this.launchApp(appId));
    // apps.* tools mirror the launcher grid and sidebar (launch, focus, close).
    registerWindowTools({
      apps: LAUNCHABLE_APPS,
      launchApp: (appId) => this.launchApp(appId),
      requestShellRender: () => this.requestShellRender(),
    });
    shell.configure({
      actions: {
        ...sharedActions,
        // Shell overlays (voice dialog, long-press menu) live on the shell
        // surface, so their repaints go through the shell render path.
        requestRender: () => this.requestShellRender(),
      },
      getScreenTimeoutMs: () => screenTimeoutSettingToMs(screenTimeoutSetting.get()),
      requestShellRender: () => this.requestShellRender(),
      prepareVoiceCapture: () => this.prepareVoiceCapture(),
      onWindowsChanged: () => {
        this.persistOpenApps();
        // The foreground title is mirrored on both remote-control faces.
        this.emit();
      },
      onScreenStateChanged: (on) => {
        this.handleScreenStateChanged(on);
        if (on) this.requestShellRender();
        this.emit();
      },
    });
    // Boot hooks register windows that exist from startup (the launcher,
    // pinned first in the sidebar and the boot foreground).
    for (const app of ALL_APPS) {
      app.boot?.(this.buildAppContext(app));
    }
    this.offAndroidNotification = onAndroidNotificationPosted((notificationKey) => {
      void this.handleAndroidNotificationPosted(notificationKey).catch((error) => {
        this.appendLog(`notification wake failed: ${this.formatError(error)}`);
      });
    });
    // Settings toggled from the glasses can change what the phone UI shows
    // (e.g. the text-setting editor), so re-emit the snapshot on any change.
    onAnySettingChanged(() => {
      this.emit();
      // Apply a firmware-debug-flags toggle live while connected (Java dedups).
      this.pushFirmwareDebugFlags();
      this.pushBrightness();
      this.syncEvenHubScreenOffSetting();
      this.applyVerticalPositionIfChanged();
      this.applyDisplayModeIfChanged();
      this.syncAssistantBridgeIfChanged();
      this.syncLockScreenSettingIfChanged();
      // A Preview color change should show on the mirror at once, not at the
      // next composited frame (cheap: floor-limited, dedup'd on the Java side).
      this.schedulePreviewUpdate();
    });
    // Connect to the external agent bridge at boot if configured; the
    // connection stays up (with re-dial) so proactive tool calls work
    // outside voice turns.
    this.syncAssistantBridge();
    // The watch drives the same synthetic-input path as the phone UI's test
    // buttons, plus app/window/lock commands; it mirrors the state below.
    this.wearRemote = new WearRemote({
      apps: LAUNCHABLE_APPS,
      injectInput: (kind) => this.injectSyntheticRingInput(kind, "watch"),
      launchApp: (appId) => this.launchApp(appId),
      connect: () => this.connect(),
      disconnect: () => this.disconnect(),
      setGlassesLocked: (locked, reason) => this.setGlassesLocked(locked, reason),
      requestShellRender: () => this.requestShellRender(),
      getState: () => ({
        phase: this.phase,
        status: this.status,
        glassesLocked: this.glassesLocked,
        glassesWorn: this.glassesWorn,
        silentMode: this.silentMode,
        lastHeadsetBattery: this.lastHeadsetBattery,
      }),
      appendLog: (line) => this.appendLog(line),
    });
  }

  // Bridge settings changes re-dial the connection; unrelated setting changes
  // must not, so the config it was last started with is tracked.
  private lastBridgeConfigKey = "";

  private bridgeConfigKey(): string {
    return JSON.stringify([
      assistantBackendSetting.get(),
      assistantBridgeHostSetting.get().trim(),
      assistantBridgePortSetting.get().trim(),
      assistantBridgeTokenSetting.get(),
    ]);
  }

  private syncAssistantBridgeIfChanged(): void {
    if (this.bridgeConfigKey() === this.lastBridgeConfigKey) return;
    this.syncAssistantBridge();
  }

  private syncAssistantBridge(): void {
    this.lastBridgeConfigKey = this.bridgeConfigKey();
    const host = assistantBridgeHostSetting.get().trim();
    const token = assistantBridgeTokenSetting.get();
    if (assistantBackendSetting.get() !== "external" || !host || !token) {
      assistantBridge.stop();
      return;
    }
    assistantBridge.configure({
      host,
      port: parseInt(assistantBridgePortSetting.get(), 10) || 8790,
      token,
      deviceName: "faceclaw",
      allowProactive: () => assistantAllowProactiveSetting.get(),
    });
  }

  // Vertical-position changes move every window surface (and the chrome that
  // aligns with them); the value is tracked so unrelated setting changes
  // don't trigger a full reposition.
  private lastVerticalPosition = verticalPositionSetting.get();

  private lastDisplayMode = displayModeSetting.get();

  /**
   * Display mode changed (Settings > Display, or the phone page's picker):
   * every window's viewport size changes. In-process windows re-measure in
   * place; worker windows get their canvas once at open, so they are closed
   * and launched again at the new size.
   */
  private applyDisplayModeIfChanged(): void {
    const mode = displayModeSetting.get();
    if (mode === this.lastDisplayMode) return;
    this.lastDisplayMode = mode;
    this.appendLog(`display mode: ${mode}`);
    const foregroundWindowId = shell.foregroundWindow()?.windowId;
    void (async () => {
      const relaunch: string[] = [];
      for (const window of Array.from(shell.getWindows())) {
        if (window.relayout) {
          window.relayout();
          await this.configureWindowSurface(
            window.surfaceId,
            window.windowId === foregroundWindowId,
            window.heightMode,
          );
        } else if (window.closeable) {
          relaunch.push(window.appId);
          shell.closeWindow(window.windowId);
        }
      }
      for (const appId of relaunch) {
        await this.launchApp(appId);
      }
      if (foregroundWindowId && shell.getWindows().some((w) => w.windowId === foregroundWindowId)) {
        shell.focusWindow(foregroundWindowId);
      }
      shell.foregroundWindow()?.requestRender();
      this.requestShellRender();
    })().catch((error) => {
      this.appendLog(`display mode change failed: ${this.formatError(error)}`);
    });
  }

  private applyVerticalPositionIfChanged(): void {
    const position = verticalPositionSetting.get();
    if (position === this.lastVerticalPosition) return;
    this.lastVerticalPosition = position;
    const foregroundWindowId = shell.foregroundWindow()?.windowId;
    void (async () => {
      for (const window of shell.getWindows()) {
        await this.configureWindowSurface(
          window.surfaceId,
          window.windowId === foregroundWindowId,
          window.heightMode,
        );
      }
      // Repaint after the surfaces have moved: window content is unchanged
      // but the moved surfaces need a recomposite, and the chrome band moved.
      shell.foregroundWindow()?.requestRender();
      this.requestShellRender();
    })().catch((error) => {
      this.appendLog(`vertical reposition failed: ${this.formatError(error)}`);
    });
  }

  private handleScreenStateChanged(on: boolean): void {
    if (on) {
      this.cancelEvenHubSuspendTimer();
      void this.ensureEvenHubSessionActive().catch((error) => {
        this.appendLog(`screen wake failed: ${this.formatError(error)}`);
      });
      return;
    }

    const communicator = this.communicator;
    if (communicator) {
      // Blanking is a compositor-level flag so worker-window surfaces go dark
      // too; retained state survives while the EvenHub page is absent.
      void (async () => {
        await communicator.setScreenBlanked(true);
        await communicator.setG2ScreenOn(false);
      })().catch((error) => {
        this.appendLog(`screen sleep failed: ${this.formatError(error)}`);
      });
      this.scheduleEvenHubSuspend();
      return;
    }
    const preview = this.previewTarget;
    if (!preview) return;
    // Preview mode: the mirror goes dark like the lens would; retained
    // surfaces survive for the next wake.
    void preview
      .setScreenBlanked(true)
      .then(() => this.schedulePreviewUpdate())
      .catch((error) => {
        this.appendLog(`preview screen sleep failed: ${this.formatError(error)}`);
      });
  }

  private syncLockScreenSettingIfChanged(): void {
    const enabled = lockScreenEnabledSetting.get();
    if (enabled === this.lastLockScreenEnabled) return;
    this.lastLockScreenEnabled = enabled;
    if (!enabled) {
      this.setGlassesLocked(false, "lock screen disabled");
      return;
    }
    if (this.phoneLocked && this.glassesWorn === false) {
      this.setGlassesLocked(true, "lock screen enabled while glasses are off-head");
    }
    this.ensureWearStateTracking();
  }

  private handleWearState(wearing: boolean): void {
    this.glassesWorn = wearing;
    this.appendLog(wearing ? "glasses wear state: ON_HEAD" : "glasses wear state: OFF_HEAD");
    this.wearRemote?.schedulePublish();
    if (!wearing && this.phoneLocked && lockScreenEnabledSetting.get()) {
      this.setGlassesLocked(true, "glasses removed while phone locked");
    }
  }

  private handlePhoneLockState(locked: boolean): void {
    if (locked === this.phoneLocked) return;
    this.phoneLocked = locked;
    this.appendLog(`phone lock state: ${locked ? "locked" : "unlocked"}`);
    if (!locked) {
      this.setGlassesLocked(false, "phone unlocked");
    } else if (this.glassesWorn === false && lockScreenEnabledSetting.get()) {
      this.setGlassesLocked(true, "phone locked while glasses are off-head");
    }
  }

  private setGlassesLocked(locked: boolean, reason: string): void {
    if (locked === this.glassesLocked) return;
    this.glassesLocked = locked;
    this.appendLog(`glasses ${locked ? "locked" : "unlocked"}: ${reason}`);
    this.wearRemote?.schedulePublish();
    void this.syncLockSurface().catch((error) => {
      this.appendLog(`lock screen update failed: ${this.formatError(error)}`);
    });
  }

  private ensureWearStateTracking(): void {
    const communicator = this.communicator;
    if (
      !lockScreenEnabledSetting.get() ||
      !this.wearNotifySupported ||
      this.phase !== "connected" ||
      !communicator
    ) {
      return;
    }
    void communicator.enableWearDetectionAndRequestState().catch((error) => {
      this.appendLog(`wear detector setup failed: ${this.formatError(error)}`);
    });
  }

  private async configureLockSurface(communicator: FaceclawCommunicatorBridge): Promise<void> {
    await communicator.configureSurface(LOCK_SCREEN_SURFACE_ID, {
      x: 0,
      y: 0,
      width: G2_LENS_WIDTH,
      height: G2_LENS_HEIGHT,
      zOrder: 1000,
      transparency: "opaque",
    });
    await communicator.setSurfaceVisible(LOCK_SCREEN_SURFACE_ID, false);
    const image = createLockScreenImage();
    await communicator.submitSurfaceFrame(
      LOCK_SCREEN_SURFACE_ID,
      image.to8bppBuffer(),
      { x: 0, y: 0, width: image.width, height: image.height },
      image.fingerprint(),
    );
    if (this.communicator === communicator) {
      this.lockSurfaceConfigured = true;
    }
  }

  private async syncLockSurface(): Promise<void> {
    const communicator = this.communicator;
    if (!communicator || !this.lockSurfaceConfigured) return;
    await communicator.setSurfaceVisible(LOCK_SCREEN_SURFACE_ID, this.glassesLocked);
    this.updateCompositePreview();
  }

  /**
   * The single wake barrier for every source: restore the EvenHub lifecycle,
   * unblank the retained compositor, and resolve only after that frame is
   * visible. Concurrent display-wake, shell, and wakeword callbacks share the
   * same operation.
   */
  /**
   * frameId (0 when the caller has none) attributes the barrier's four
   * round trips to the input frame waiting on them; a wake barrier is the
   * largest single input-to-display term there is, so knowing which step
   * owns the second matters. Callers that join an in-flight barrier share
   * the first caller's spans.
   */
  private ensureEvenHubSessionActive(frameId = 0): Promise<boolean> {
    if (this.evenHubResumePromise) return this.evenHubResumePromise;
    const communicator = this.communicator;
    if (!communicator) {
      // Preview mode has no plugin session to restore; waking is just
      // unblanking the headless compositor so the mirror lights back up.
      const preview = this.previewTarget;
      if (!preview) return Promise.resolve(false);
      return preview.setScreenBlanked(false).then(() => {
        this.schedulePreviewUpdate();
        return true;
      });
    }
    if (this.phase === "charging" || this.phase === "disconnected") {
      return Promise.resolve(false);
    }

    const operation = (async () => {
      await frameTimings.spanAsync(frameId, "wake:screen-on", () => communicator.setG2ScreenOn(true));
      const resumed = await frameTimings.spanAsync(frameId, "wake:resume-session", () =>
        communicator.resumeEvenHubSession(),
      );
      if (!resumed) {
        return false;
      }
      // Resume first: setScreenBlanked(false) then recomposites retained state
      // as the desired first frame for the fresh layout.
      await frameTimings.spanAsync(frameId, "wake:unblank", () => communicator.setScreenBlanked(false));
      const ready = await frameTimings.spanAsync(frameId, "wake:await-ready", () =>
        communicator.awaitEvenHubSessionReady(EVENHUB_WAKE_READY_TIMEOUT_MS),
      );
      if (ready && this.communicator === communicator) {
        this.evenHubSessionSuspended = false;
      }
      return ready;
    })();
    this.evenHubResumePromise = operation;
    const clearOperation = () => {
      if (this.evenHubResumePromise === operation) {
        this.evenHubResumePromise = null;
      }
    };
    void operation.then(clearOperation, clearOperation);
    return operation;
  }

  private desiredFaceclawWakeLeaseState(): boolean {
    // The same firmware lease owns two stock wake paths: deferred dashboard
    // launch while EvenHub is suspended, and suppression of the stock Even AI
    // foreground app when Faceclaw handles the glasses wakeword. Without the
    // latter, Even AI displaces EvenHub before our first wake frame can ACK.
    return (
      this.faceclawWakeLeaseSupported &&
      (suspendEvenHubWhenScreenOffSetting.get() || wakeWordActionSetting.get() !== "off")
    );
  }

  private async syncFaceclawWakeLease(
    communicator = this.communicator,
    force = false,
  ): Promise<boolean> {
    if (!communicator || communicator !== this.communicator) return false;
    const enabled = this.desiredFaceclawWakeLeaseState();
    if (!force && this.faceclawWakeLeaseState === enabled) return true;
    const applied = await communicator.setFaceclawWakeLeaseEnabled(enabled);
    if (this.communicator === communicator) {
      this.faceclawWakeLeaseState = applied || !enabled ? enabled : null;
    }
    return applied;
  }

  private syncEvenHubScreenOffSetting(): void {
    void this.syncFaceclawWakeLease().catch((error) => {
      this.appendLog(`wake takeover lease sync failed: ${this.formatError(error)}`);
    });
    if (suspendEvenHubWhenScreenOffSetting.get() && !shell.isScreenOn()) {
      this.scheduleEvenHubSuspend();
      return;
    }

    this.cancelEvenHubSuspendTimer();
    if (!this.evenHubSessionSuspended) return;

    // Turning the experiment off restores the legacy all-black page even if
    // the screen remains asleep.
    const communicator = this.communicator;
    if (!communicator) return;
    void communicator
      .resumeEvenHubSession()
      .then((resumed) => {
        if (resumed && this.communicator === communicator) {
          this.evenHubSessionSuspended = false;
        }
      })
      .catch((error) => {
        this.appendLog(`EvenHub resume failed: ${this.formatError(error)}`);
      });
  }

  private scheduleEvenHubSuspend(): void {
    this.cancelEvenHubSuspendTimer();
    if (
      !suspendEvenHubWhenScreenOffSetting.get() ||
      shell.isScreenOn() ||
      this.phase !== "connected" ||
      !this.communicator ||
      this.evenHubSessionSuspended
    ) {
      return;
    }

    const communicator = this.communicator;
    this.evenHubSuspendTimer = setTimeout(() => {
      this.evenHubSuspendTimer = null;
      if (
        !suspendEvenHubWhenScreenOffSetting.get() ||
        shell.isScreenOn() ||
        this.phase !== "connected" ||
        this.communicator !== communicator
      ) {
        return;
      }

      if (voiceControlBridge.isCaptureHeld()) {
        // Ending the plugin task ends the mic with it, so a live capture (the
        // Transcribe window, typically) outranks the screen-off power save.
        // Check before the lease refresh below, which costs a BLE message.
        this.scheduleEvenHubSuspend();
        return;
      }

      void (async () => {
        if (this.faceclawWakeLeaseSupported) {
          // Refresh immediately before teardown so the first suspended wake
          // cannot race an old lease's expiry.
          const leaseReady = await this.syncFaceclawWakeLease(communicator, true);
          if (!leaseReady) {
            this.appendLog("EvenHub suspend deferred; wake takeover lease was not delivered");
            this.scheduleEvenHubSuspend();
            return;
          }
        }
        if (
          !suspendEvenHubWhenScreenOffSetting.get() ||
          shell.isScreenOn() ||
          this.phase !== "connected" ||
          this.communicator !== communicator
        ) {
          return;
        }
        this.evenHubSessionSuspended = true;
        return communicator.suspendEvenHubSession();
      })()
        .then((suspended) => {
          if (suspended === undefined) return;
          if (suspended) {
            // A capture that raced the suspend lost its mic with the plugin
            // task; park it for the resume path.
            voiceControlBridge.handleSessionEnded();
            this.appendLog("EvenHub session suspended while screen is off");
            return;
          }
          if (this.communicator !== communicator || shell.isScreenOn()) return;
          this.evenHubSessionSuspended = false;
          this.scheduleEvenHubSuspend();
        })
        .catch((error) => {
          if (this.communicator === communicator) {
            this.evenHubSessionSuspended = false;
            this.appendLog(`EvenHub suspend failed: ${this.formatError(error)}`);
            this.scheduleEvenHubSuspend();
          }
        });
    }, EVENHUB_SCREEN_OFF_SUSPEND_DELAY_MS);
  }

  private cancelEvenHubSuspendTimer(): void {
    if (this.evenHubSuspendTimer === null) return;
    clearTimeout(this.evenHubSuspendTimer);
    this.evenHubSuspendTimer = null;
  }

  private pushFirmwareDebugFlags(): void {
    if (!this.communicator) return;
    void this.communicator
      .setFirmwareDebugFlags(firmwareDebugFlagsSetting.get())
      .catch(() => {});
  }

  /**
   * Push the brightness setting to the glasses. Deduped TS-side (the change
   * listener fires for every setting, and each push queues a real BLE
   * message); `force` skips the dedup so a fresh connection always gets the
   * configured value regardless of what the firmware restored.
   */
  private pushBrightness(force = false): void {
    if (!this.communicator) return;
    const value = brightnessSetting.get();
    if (!force && value === this.lastPushedBrightness) return;
    this.lastPushedBrightness = value;
    const level = brightnessSettingToLevel(value);
    void this.communicator.setBrightness(level === null, level ?? 0).catch(() => {});
  }

  /** Save the occupied part of the composited screen as a 4-bit grayscale PNG. */
  saveScreenshot(): string {
    const path = this.display?.saveScreenshot(shell.screenshotCropRect()) ?? "";
    this.appendLog(path ? `screenshot saved: ${path}` : "screenshot skipped: no display");
    return path;
  }

  /**
   * Begin collecting composited frames for an animated-GIF screen recording.
   * Frames are captured at the same points the phone-side preview is
   * refreshed, so the recording matches what the phone display showed.
   */
  startScreenRecording(): void {
    if (this.screenRecordingActive) return;
    const display = this.display;
    if (!display) {
      this.appendLog("screen recording skipped: no display");
      return;
    }
    display.startScreenRecording();
    // Capture the starting frame immediately rather than waiting for the
    // next preview flush.
    display.recordScreenFrame();
    this.screenRecordingActive = true;
    this.appendLog("screen recording started");
    this.emit();
  }

  /** Finish the recording and save it as an animated GIF; returns the path or "". */
  stopScreenRecording(): string {
    if (!this.screenRecordingActive) return "";
    this.screenRecordingActive = false;
    let path = "";
    try {
      path = this.display?.stopScreenRecording() ?? "";
    } finally {
      this.emit();
    }
    this.appendLog(path ? `screen recording saved: ${path}` : "screen recording discarded: no frames");
    return path;
  }

  subscribe(listener: DashboardListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): DashboardSnapshot {
    const primaryTextSetting = this.activeTextSettings[0] ?? null;
    const secondaryTextSetting = this.activeTextSettings[1] ?? null;
    return {
      phase: this.phase,
      status: this.status,
      displayPreview: this.displayPreview,
      displayPreviewMessage: this.displayPreviewMessage(),
      activeTextSettingId: primaryTextSetting?.id ?? null,
      activeTextEditorTitle: this.activeTextEditorTitle,
      activeTextSettingTitle: primaryTextSetting?.editorTitle ?? "",
      activeTextSettingValue: primaryTextSetting?.get() ?? "",
      activeTextSettingInputKind: primaryTextSetting?.inputKind ?? "text",
      secondaryTextSettingId: secondaryTextSetting?.id ?? null,
      secondaryTextSettingTitle: secondaryTextSetting?.editorTitle ?? "",
      secondaryTextSettingValue: secondaryTextSetting?.get() ?? "",
      secondaryTextSettingInputKind: secondaryTextSetting?.inputKind ?? "text",
      activeTextEditorToggleLabel: this.activeTextEditorToggle?.label ?? "",
      activeTextEditorToggleValue: this.activeTextEditorToggle?.setting.get() ?? false,
      activeTextEditorToggleVisible: this.activeTextEditorToggle !== null,
      evenAppConflictMessage: this.evenAppConflictMessage,
      evenAppConflictWarningVisible: this.evenAppConflictMessage.length > 0,
      firmwareWarningMessage: this.firmwareWarningMessage,
      firmwareWarningVisible: this.firmwareWarningMessage.length > 0,
      screenRecordingActive: this.screenRecordingActive,
      batteryOptimizationWarningVisible: this.batteryOptimizationWarningVisible,
      fontsMissingWarningVisible: this.fontsMissingWarningVisible,
      previewMode: this.isPreviewDisplayActive(),
    };
  }

  /**
   * Message to show in place of the display preview, or "" to show the preview.
   *
   * These states look identical to a dead pair of glasses from the phone side:
   * charging and silent mode both make the display unavailable while BLE stays
   * up, and a battery that just ran out simply stops answering.
   */
  private displayPreviewMessage(): string {
    if (this.phase === "charging") {
      return this.glassesDisplayLabel();
    }
    if (this.silentMode && this.phase === "connected") {
      return "Connected (Silent mode enabled)";
    }
    // The preview compositor keeps the mirror live (including as a black
    // frame while the simulated screen is off), so never cover it.
    if (this.isPreviewDisplayActive()) {
      return "";
    }
    const connectionFailing = this.phase === "disconnected" || this.phase === "connecting";
    if (
      connectionFailing &&
      this.lastHeadsetBattery !== null &&
      this.lastHeadsetBattery < LOW_BATTERY_PERCENT
    ) {
      return "Disconnected (low battery)";
    }
    return "";
  }

  /** What occupies the foreground-title line on the watch-style controls. */
  glassesDisplayLabel(): string {
    return glassesDisplayLabel({
      phase: this.phase,
      silentMode: this.silentMode,
      screenOn: shell.isScreenOn(),
      battery: this.lastHeadsetBattery,
      foregroundTitle: shell.getForegroundApp()?.title ?? null,
      previewMode: this.isPreviewDisplayActive(),
    });
  }

  /**
   * Re-check the Doze exemption (cheap system call, but cached so snapshot()
   * stays trivial). Called on connect, page load, and after the user answers
   * the system exemption dialog.
   */
  refreshBatteryOptimizationStatus(): void {
    const warningVisible = !isIgnoringBatteryOptimizations();
    if (warningVisible !== this.batteryOptimizationWarningVisible) {
      this.batteryOptimizationWarningVisible = warningVisible;
      this.emit();
    }
  }

  requestBatteryOptimizationExemption(): void {
    requestIgnoreBatteryOptimizations();
    // The system dialog is asynchronous and there is no result callback from
    // this context; poll briefly so the banner clears once granted.
    let checksLeft = 12;
    const poll = setInterval(() => {
      this.refreshBatteryOptimizationStatus();
      if (!this.batteryOptimizationWarningVisible || --checksLeft <= 0) {
        clearInterval(poll);
      }
    }, 5_000);
  }

  /**
   * Warn when glasses are paired but the phone-side G2 fonts were never
   * extracted (the onboarding flash flow normally extracts them, but a dev
   * install or an imported config can arrive paired without them). Preview-only
   * users have no addresses configured and are never warned.
   */
  refreshEvenHubFontStatus(): void {
    const addresses = loadDeviceAddresses();
    const paired = isValidMacAddress(addresses.right) && isValidMacAddress(addresses.left);
    if (paired && !this.extractedFontsConfirmed) {
      this.extractedFontsConfirmed = hasExtractedEvenHubFonts();
    }
    const warningVisible = paired && !this.extractedFontsConfirmed;
    if (warningVisible !== this.fontsMissingWarningVisible) {
      this.fontsMissingWarningVisible = warningVisible;
      this.emit();
    }
  }

  refreshEvenAppStatus(): void {
    this.refreshBatteryOptimizationStatus();
    this.refreshEvenHubFontStatus();
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

  setActiveTextSettingValue(value: string, settingId?: string): void {
    shell.noteUserActivity();
    const setting = settingId
      ? this.activeTextSettings.find((candidate) => candidate.id === settingId) ?? null
      : this.activeTextSettings[0] ?? null;
    if (!setting) return;
    if (setting.get() === value) return;
    setting.set(value);
    // Deliberately do NOT emit() here. The phone TextField is the source of
    // truth while typing; echoing activeTextSettingValue back into its two-way
    // binding on every keystroke drops fast/pasted characters (observed: a
    // 51-char API key stored as its first 46 chars). Just refresh the preview.
    this.previewOrRenderAfterTextSettingChange();
  }

  setActiveTextEditorToggleValue(value: boolean): void {
    if (!this.activeTextEditorToggle || this.activeTextEditorToggle.setting.get() === value) return;
    this.activeTextEditorToggle.setting.set(value);
    this.emit();
  }

  /**
   * Where composited frames go and where the phone mirror, screenshots, and
   * recordings come from: the live glasses connection when there is one,
   * otherwise the headless preview compositor (preview-only mode), otherwise
   * nothing (frames are discarded).
   */
  private get display(): DisplayTarget | null {
    return this.communicator ?? this.previewTarget;
  }

  private isPreviewDisplayActive(): boolean {
    return this.communicator === null && this.previewTarget !== null;
  }

  /**
   * Bring up the headless preview display for preview-only mode (onboarding's
   * "Preview Only" path): the same shell/app/compositor pipeline as a live
   * session minus the BLE transport, so the phone mirror and its touch/watch
   * controls work with no glasses paired. Idempotent; called from the main
   * page alongside autoConnect. A real connection outranks it — connect()
   * tears it down before creating the communicator.
   */
  async ensurePreviewDisplay(): Promise<void> {
    if (!isPreviewOnlyMode()) return;
    if (this.communicator || this.previewTarget || this.connectRunning) return;
    const target = new PreviewDisplayTarget();
    // Published before the awaits below so a second call (or connect()) sees
    // it; the target's calls all complete in microtasks, so the screen size
    // is in place before any real render can reach the compositor.
    this.previewTarget = target;
    try {
      await target.configureCompositorScreen(G2_LENS_WIDTH, G2_LENS_HEIGHT);
      await target.configureSurface(SHELL_SURFACE_ID, {
        x: 0,
        y: 0,
        width: G2_LENS_WIDTH,
        height: G2_LENS_HEIGHT,
        zOrder: 1,
        transparency: "color-key",
      });
      const foregroundWindowId = shell.foregroundWindow()?.windowId;
      for (const window of shell.getWindows()) {
        await this.configureWindowSurface(
          window.surfaceId,
          window.windowId === foregroundWindowId,
          window.heightMode,
          target,
        );
      }
    } catch (error) {
      if (this.previewTarget === target) this.previewTarget = null;
      this.appendLog(`preview display setup failed: ${this.formatError(error)}`);
      return;
    }
    // Workers find the compositor through its Java static; the per-frame
    // callback keeps the mirror current (the connected path gets the same
    // from Java's frame metrics).
    target.activate(() => this.schedulePreviewUpdate());
    this.setStatus("Preview mode (no glasses paired).");
    this.appendLog("Preview-only display active; frames render to the phone mirror only.");
    shell.foregroundWindow()?.requestRender();
    this.requestShellRender();
    // The same recurring upkeep a live session gets: top-bar clock refresh,
    // the preview safety-net poll, and the screen timeout (a timed-out
    // preview screen wakes on double-tap, like the glasses would).
    this.shellRefreshTimer = setInterval(() => {
      this.requestShellRender();
      this.updateCompositePreview();
    }, SHELL_REFRESH_INTERVAL_MS);
    this.previewTimer = setInterval(() => this.updateCompositePreview(), PREVIEW_INTERVAL_MS);
    this.screenTimeoutTimer = setInterval(() => {
      if (!this.isPreviewDisplayActive()) return;
      if (!shell.applyScreenTimeout()) return;
      this.endTextSettingEdit();
      this.requestShellRender();
    }, SCREEN_TIMEOUT_CHECK_MS);
    this.emit();
  }

  /** Drop the headless preview display (a real connection is taking over). */
  private teardownPreviewDisplay(): void {
    const target = this.previewTarget;
    if (!target) return;
    this.previewTarget = null;
    target.release();
    this.clearDashboardTimer();
    this.appendLog("Preview-only display released.");
  }

  async connect(): Promise<void> {
    if (this.phase !== "disconnected") return;
    // Connecting is the explicit way out of the manual-disconnected state.
    resumeAutoReconnect();

    const addresses = loadDeviceAddresses();
    if (!addresses.right || !addresses.left) {
      const message = "Configure both left and right arm MAC addresses before connecting.";
      this.setPhase("disconnected");
      this.setStatus(`Failed: ${message}`);
      this.appendLog(`error: ${message}`);
      throw new Error(message);
    }
    // Glasses are configured, so the real pipeline owns the display from here
    // (also frees the preview timers for connect() to replace).
    this.teardownPreviewDisplay();
    this.lastInput = "waiting...";
    this.lastSys = "none yet";
    this.welcomeSoundArmed = isWelcomeSoundPending();
    this.firmwareWarningMessage = "";
    this.glassesWorn = null;
    this.glassesLocked = false;
    this.refreshBatteryOptimizationStatus();
    this.refreshEvenAppStatus();
    this.setPhase("connecting");
    this.setStatus("Connecting to the glasses...");
    // "Only via glasses" (the default) means the phone never opens its own
    // link to the ring: the glasses relay its gestures to us anyway, and the
    // direct link is currently unreliable. An empty address disables every
    // direct-ring code path in the communicator.
    const ringAddress = ringConnectionModeSetting.get() === "direct" ? addresses.ring : "";
    this.appendLog(
      `Using configured arms: R=${addresses.right} L=${addresses.left}${ringAddress ? ` ring=${ringAddress}` : ""}`,
    );

    let communicator: FaceclawCommunicatorBridge | null = null;
    this.faceclawWakeLeaseSupported = false;
    this.faceclawWakeLeaseState = null;
    this.wearNotifySupported = false;
    this.lockSurfaceConfigured = false;
    this.evenHubResumePromise = null;
    this.connectRunning = true;

    try {
      await ensureBlePermissions();
      startForegroundNotification("Connecting to the glasses");
      communicator = new FaceclawCommunicatorBridge({
        right: addresses.right,
        left: addresses.left,
        ring: ringAddress,
      });
      this.communicator = communicator;
      this.offLog = communicator.onLog((line) => {
        this.appendLog(line);
      });
      this.offState = communicator.onStateChange((state) => {
        if (state.phase === "unpaired") {
          // Java parked its retry loop: an arm's Android bond is gone, so
          // every redial would fail the same way until the user re-pairs.
          // Tear down into the manual-disconnected state and keep the
          // re-pair instruction as the visible status.
          this.scheduleUnpairedDisconnect(state.status);
          return;
        }
        const mappedPhase =
          state.phase === "connected"
            ? "connected"
            : state.phase === "charging"
              ? "charging"
              : state.phase === "disconnecting"
                ? "disconnecting"
                : state.phase === "disconnected"
                  ? "disconnected"
                  : "connecting";
        if (mappedPhase === "charging" && this.phase !== "charging") {
          // Nobody is wearing the glasses; drop the G2-screen wakelock so the
          // phone can sleep normally while they charge.
          void this.communicator?.setG2ScreenOn(false).catch(() => {});
        }
        if (mappedPhase === "connected" && this.phase !== "connected") {
          // A transport reconnect starts with a live EvenHub lifecycle again;
          // if the shell is asleep, begin a fresh five-second grace period.
          this.evenHubSessionSuspended = false;
          // Firmware leases are volatile, and the Java transport may have been
          // rebuilt underneath this long-lived controller. Do not let a cached
          // TypeScript value suppress re-acquisition on the new session.
          this.faceclawWakeLeaseState = null;
          // Push the CFW firmware-debug-flags overlay preference; Java emits the
          // mode-7 control message once the dashboard container is warmed up.
          this.pushFirmwareDebugFlags();
          this.pushBrightness(true);
        }
        if (mappedPhase !== "connected") {
          // A wear snapshot is session-scoped. CFW reports a fresh value when
          // the transport comes back, so do not make lock decisions from a
          // stale pre-disconnect value in the meantime.
          this.glassesWorn = null;
          // The mic enable was session-scoped too: park any live capture so
          // the next session restarts it, instead of leaving a holder that
          // makes every later request think the mic is already running.
          voiceControlBridge.handleSessionEnded();
        }
        this.setPhase(mappedPhase);
        this.setStatus(state.status);
        if (mappedPhase === "connected") {
          this.syncEvenHubScreenOffSetting();
          this.ensureWearStateTracking();
        } else if (mappedPhase !== "charging") {
          this.cancelEvenHubSuspendTimer();
          this.evenHubSessionSuspended = false;
        }
      });
      this.offRing = communicator.onRingEvent((event) => {
        void this.handleInputEvent(event).catch((error) => {
          const message = this.formatError(error);
          this.appendLog(`input handler failed: ${message}`);
        });
      });
      this.offSilentMode = communicator.onSilentMode((silent) => {
        if (this.silentMode === silent) return;
        this.silentMode = silent;
        this.emit();
      });
      this.offWearState = communicator.onWearState((wearing) => {
        this.handleWearState(wearing);
      });
      this.offPhoneLockState = communicator.onPhoneLockState((locked) => {
        this.handlePhoneLockState(locked);
      });
      this.offBattery = communicator.onBatteryState((state) => {
        // An unavailable reading must not erase the useful last-known value,
        // especially while the glasses remain reachable in their case.
        const hasBatteryLevel = Number.isInteger(state.battery) && state.battery >= 0 && state.battery <= 100;
        if (hasBatteryLevel) this.lastHeadsetBattery = state.battery;
        shell.setBatteryLevels({
          headset: hasBatteryLevel ? state.battery : this.lastHeadsetBattery,
          headsetCharging: state.chargingStatus > 0,
        });
        if ((this.phase === "connected" || this.phase === "charging") && this.communicator) {
          // Repaint the top bar (battery indicators live in the shell chrome).
          this.requestShellRender();
        }
        // Battery belongs in the charging stand-in on the phone as well as in
        // the watch state, so refresh both consumers on every report.
        this.emit();
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
      this.offFrameMetrics = communicator.onFrameMetrics(() => {
        // Every composited frame refreshes the phone-side mirror (bounded by
        // CONNECTED_PREVIEW_MIN_UPDATE_MS) so it tracks the glasses instead
        // of trailing the 1s safety-net poll.
        this.schedulePreviewUpdate();
        if (this.phase === "connected") {
          this.setStatus("Connected.");
          // A rendered frame also means the display path is warm enough for
          // the glasses to accept a mic enable, so this is where a capture
          // parked by the previous session (or by an EvenHub suspend) resumes.
          this.resumeVoiceCapture();
          // A rendered frame means the session is warmed up (fixedLayoutCreated),
          // so the buzzer won't be dropped. Play the one-time welcome sound now.
          if (this.welcomeSoundArmed) {
            this.welcomeSoundArmed = false;
            setWelcomeSoundPending(false);
            void this.playWelcomeSound();
          }
        }
      });
      this.offFirmwareInfo = communicator.onFirmwareInfo((info) => {
        this.appendLog(
          `firmware: L=${info.leftVersion || "?"} R=${info.rightVersion || "?"}` +
            (info.capabilities ? ` caps="${info.capabilities}"` : " (no CFW capability string)"),
        );
        const warning = firmwareIncompatibilityMessage(info) ?? "";
        const wakeLeaseSupported = info.capabilities
          .trim()
          .split(/\s+/)
          .includes("wakelease");
        const wearNotifySupported = info.capabilities
          .trim()
          .split(/\s+/)
          .includes("wearnotify");
        if (wakeLeaseSupported !== this.faceclawWakeLeaseSupported) {
          this.faceclawWakeLeaseSupported = wakeLeaseSupported;
          this.faceclawWakeLeaseState = null;
          void this.syncFaceclawWakeLease().catch((error) => {
            this.appendLog(`wake takeover lease sync failed: ${this.formatError(error)}`);
          });
        }
        if (wearNotifySupported !== this.wearNotifySupported) {
          this.wearNotifySupported = wearNotifySupported;
          this.ensureWearStateTracking();
        }
        if (warning !== this.firmwareWarningMessage) {
          this.firmwareWarningMessage = warning;
          if (warning) {
            this.appendLog(`firmware compatibility warning: ${warning}`);
          }
          this.emit();
        }
        if (warning) {
          this.scheduleIncompatibleFirmwareDisconnect();
        }
      });
      // The Music and Nightscout apps subscribe to their bridges directly and
      // repaint their own windows, so bridge updates need no controller action.
      this.offVoiceStatus = voiceControlBridge.onStatus((state) => {
        this.appendLog(state.status);
      });

      await mediaControllerBridge.start();
      await nightscoutBridge.start();
      // Register the compositor surfaces: the shell chrome above all windows,
      // and a surface per live window (only the foreground one is composited).
      await communicator.configureCompositorScreen(G2_LENS_WIDTH, G2_LENS_HEIGHT);
      await communicator.configureSurface(SHELL_SURFACE_ID, {
        x: 0,
        y: 0,
        width: G2_LENS_WIDTH,
        height: G2_LENS_HEIGHT,
        zOrder: 1,
        transparency: "color-key",
      });
      await this.configureLockSurface(communicator);
      const foregroundWindowId = shell.foregroundWindow()?.windowId;
      for (const window of shell.getWindows()) {
        await this.configureWindowSurface(
          window.surfaceId,
          window.windowId === foregroundWindowId,
          window.heightMode,
        );
      }
      await communicator.start();
      await this.syncLockSurface();
      this.syncEvenHubScreenOffSetting();
      shell.foregroundWindow()?.requestRender();
      this.requestShellRender();
      // Refresh the top-bar clock and the phone-side preview once a minute,
      // and keep the Android persistent notification current.
      this.shellRefreshTimer = setInterval(() => {
        this.requestShellRender();
        this.updateCompositePreview();
        this.updateConnectedForegroundNotification();
      }, SHELL_REFRESH_INTERVAL_MS);
      this.previewTimer = setInterval(() => this.updateCompositePreview(), PREVIEW_INTERVAL_MS);
      this.screenTimeoutTimer = setInterval(() => {
        if (this.phase !== "connected" || !this.communicator) return;
        if (!shell.applyScreenTimeout()) return;
        this.endTextSettingEdit();
        this.requestShellRender();
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
      this.offSilentMode?.();
      this.offSilentMode = null;
      this.offWearState?.();
      this.offWearState = null;
      this.offPhoneLockState?.();
      this.offPhoneLockState = null;
      this.offEvenAppConflict?.();
      this.offEvenAppConflict = null;
      this.offFrameMetrics?.();
      this.offFrameMetrics = null;
      this.offFirmwareInfo?.();
      this.offFirmwareInfo = null;
      this.offVoiceStatus?.();
      this.offVoiceStatus = null;
      await mediaControllerBridge.stop().catch(() => {});
      await nightscoutBridge.stop().catch(() => {});
      voiceControlBridge.stop();
      if (communicator) {
        await communicator.setFaceclawWakeLeaseEnabled(false).catch(() => false);
        await communicator.close().catch(() => {});
      }
      this.communicator = null;
      this.lockSurfaceConfigured = false;
      this.wearNotifySupported = false;
      this.faceclawWakeLeaseSupported = false;
      this.faceclawWakeLeaseState = null;
      this.evenHubResumePromise = null;
      this.clearDashboardTimer();
      stopForegroundNotification();
      this.setPhase("disconnected");
      this.setStatus(`Failed: ${message}`);
      this.appendLog(`error: ${message}`);
      throw error;
    } finally {
      this.connectRunning = false;
    }
  }

  /**
   * Incompatible firmware means every message Faceclaw sends is one the
   * glasses may misinterpret, and a live session fights the flash flow's own
   * connection. Drop the connection (without the CFW-directed cleanup
   * messages) and hold in the manual-disconnected state until the user
   * connects explicitly or installs the custom firmware.
   */
  private scheduleIncompatibleFirmwareDisconnect(): void {
    if (this.incompatibleDisconnectPending) return;
    this.incompatibleDisconnectPending = true;
    const attempt = () => {
      // Firmware info can arrive while connect() is still mid-flight; let it
      // finish so the teardown doesn't race its surface setup.
      if (this.connectRunning) {
        setTimeout(attempt, 200);
        return;
      }
      this.incompatibleDisconnectPending = false;
      if (this.phase === "disconnected" || this.phase === "disconnecting") {
        // The session ended some other way; still stop auto-reconnect from
        // re-dialing glasses we know can't run Faceclaw.
        suppressAutoReconnect();
        return;
      }
      this.appendLog(
        "Disconnecting: the glasses firmware is incompatible. Auto-reconnect is disabled until you connect manually or install the custom firmware.",
      );
      void this.disconnect({ skipFirmwareCleanup: true })
        .then(() => this.setStatus("Disconnected (incompatible firmware)."))
        .catch((error) => {
          this.appendLog(`incompatible-firmware disconnect failed: ${this.formatError(error)}`);
        });
    };
    setTimeout(attempt, 0);
  }

  /**
   * A connect attempt found an arm whose Android bond is missing, so the Java
   * worker stopped retrying. Drop into the manual-disconnected state (no
   * auto-reconnect: it would just fail again) and leave the re-pair
   * instruction from Java as the status the user sees.
   */
  private scheduleUnpairedDisconnect(message: string): void {
    if (this.unpairedDisconnectPending) return;
    this.unpairedDisconnectPending = true;
    const attempt = () => {
      // The unpaired report can arrive while connect() is still mid-flight;
      // let it finish so the teardown doesn't race its surface setup.
      if (this.connectRunning) {
        setTimeout(attempt, 200);
        return;
      }
      this.unpairedDisconnectPending = false;
      if (this.phase === "disconnected" || this.phase === "disconnecting") {
        // The session ended some other way; still stop auto-reconnect from
        // re-dialing glasses that are no longer paired.
        suppressAutoReconnect();
        this.setStatus(message);
        return;
      }
      this.appendLog(`Disconnecting: ${message} Auto-reconnect is disabled until you connect manually.`);
      void this.disconnect({ skipFirmwareCleanup: true })
        .then(() => this.setStatus(message))
        .catch((error) => {
          this.appendLog(`unpaired disconnect failed: ${this.formatError(error)}`);
        });
    };
    setTimeout(attempt, 0);
  }

  /**
   * Tear down the connection and enter the manual-disconnected state: every
   * caller is deliberate (the phone/glasses Disconnect actions, entering the
   * flash flow, an incompatible-firmware bailout), so auto-reconnect stays
   * off until an explicit connect or a successful firmware install.
   *
   * skipFirmwareCleanup: don't send the CFW cleanup/shutdown or wake-lease
   * messages — used when the firmware is incompatible and would misread them.
   */
  async disconnect(options?: { skipFirmwareCleanup?: boolean }): Promise<void> {
    suppressAutoReconnect();
    // The phone menu offers Disconnect during the connecting phase (it is the
    // only way out of a reconnection-attempt loop), so a call can land while
    // connect() is still mid-flight; let it finish so the teardown doesn't
    // race its surface setup. connect() returns once the Java worker thread
    // owns the retry loop, so this wait is short.
    while (this.connectRunning) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
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
    this.offSilentMode?.();
    this.offSilentMode = null;
    this.offWearState?.();
    this.offWearState = null;
    this.offPhoneLockState?.();
    this.offPhoneLockState = null;
    this.offEvenAppConflict?.();
    this.offEvenAppConflict = null;
    this.offFrameMetrics?.();
    this.offFrameMetrics = null;
    this.offFirmwareInfo?.();
    this.offFirmwareInfo = null;
    this.offVoiceStatus?.();
    this.offVoiceStatus = null;

    const communicator = this.communicator;
    this.communicator = null;
    this.lockSurfaceConfigured = false;
    this.evenHubSessionSuspended = false;
    this.evenHubResumePromise = null;

    // The recording's frame store lives in the communicator, so save what has
    // accumulated rather than silently losing it with the connection.
    if (this.screenRecordingActive) {
      this.screenRecordingActive = false;
      try {
        const path = communicator?.stopScreenRecording() ?? "";
        this.appendLog(path ? `screen recording saved: ${path}` : "screen recording discarded: no frames");
      } catch (error) {
        this.appendLog(`screen recording save failed: ${this.formatError(error)}`);
      }
    }

    try {
      const skipFirmwareCleanup = options?.skipFirmwareCleanup === true;
      if (!skipFirmwareCleanup) {
        const leaseReleased = await communicator?.setFaceclawWakeLeaseEnabled(false).catch((error) => {
          this.appendLog(`wake takeover lease release failed: ${this.formatError(error)}`);
          return false;
        });
        if (leaseReleased === true) {
          this.faceclawWakeLeaseState = false;
        }
      }

      // Quiesce every producer that can enqueue a glasses command before the
      // firmware cleanup barrier. On cleanup-capable CFW this leaves mode 11 as
      // Faceclaw's final BLE message before the transport closes.
      await mediaControllerBridge.stop().catch(() => {});
      await nightscoutBridge.stop().catch(() => {});
      voiceControlBridge.handleSessionEnded();

      const cleanupAcked = skipFirmwareCleanup
        ? false
        : await communicator?.sendCfwCleanup().catch((error) => {
            this.appendLog(`CFW cleanup failed: ${this.formatError(error)}`);
            return false;
          });
      if (cleanupAcked === true) {
        this.appendLog("CFW cleanup completed.");
      } else if (communicator && !skipFirmwareCleanup) {
        // Older CFWs do not advertise cleanup11. Preserve their established
        // teardown behavior; close() will also send the legacy FB lease release.
        const shutdownAcked = await communicator.sendShutdown(0).catch((error) => {
          this.appendLog(`shutdown command failed: ${this.formatError(error)}`);
          return false;
        });
        if (shutdownAcked) {
          this.appendLog("Shutdown command completed (legacy cleanup fallback).");
        } else {
          this.appendLog("Cleanup did not complete before disconnect.");
        }
      }
      await communicator?.close().catch(() => {});
    } finally {
      stopForegroundNotification();
      this.faceclawWakeLeaseSupported = false;
      this.faceclawWakeLeaseState = null;
      this.wearNotifySupported = false;
      this.setPhase("disconnected");
      this.setStatus("Disconnected.");
      this.appendLog("Disconnected from the glasses.");
    }
  }

  /**
   * Feed a ring gesture from somewhere other than the ring (the phone UI's
   * test buttons, the watch). "long-press" is a complete short hold;
   * "long-press-start" / "long-press-release" let a source with a real
   * finger-down/finger-up (the watch) hold for as long as the user does.
   */
  async injectSyntheticRingInput(kind: WearRemoteInputKind, origin: SyntheticInputOrigin = "ring"): Promise<void> {
    // Match the ring while the display is dark: only a double-click wakes it,
    // and that wake is handled by Shell.receiveInput. This check also protects
    // against a watch acting on a stale state snapshot.
    if (
      origin === "watch" &&
      !shell.isScreenOn() &&
      kind !== "double-click" &&
      kind !== "long-press-release"
    ) {
      this.appendLog(`${kind} (watch scheme) ignored while display is off`);
      return;
    }
    if (kind === "long-press") {
      // Hardware delivers a press event and then a release when the finger
      // lifts; emulate a short hold so the escape-menu countdown never fires.
      await this.handleInputEvent(this.buildSyntheticRingInput("long-press", origin));
      await this.handleInputEvent(this.buildSyntheticRingInput("long-press-release", origin));
      return;
    }
    const event = this.buildSyntheticRingInput(kind === "long-press-start" ? "long-press" : kind, origin);
    await this.handleInputEvent(event);
  }

  /**
   * A touch on the phone's mirror of the glasses display. Gestures other than
   * a tap are the watch scheme (swipes navigate, double-tap is back, a hold
   * is the menu). A tap lands on what the mirror shows: a sidebar icon
   * switches to that window, a launcher cell opens, anything else selects.
   * Coordinates are fractions of the mirror (0..1).
   */
  async handleMirrorTouch(kind: MirrorTouchKind, nx: number, ny: number): Promise<void> {
    if (this.phase !== "connected" && this.phase !== "charging" && !this.isPreviewDisplayActive()) return;
    if (this.glassesLocked) {
      // Same as the ring: only a double-tap reaches a locked display.
      if (kind === "double-tap") await this.injectSyntheticRingInput("double-click", "watch");
      return;
    }
    if (!shell.isScreenOn()) {
      if (kind === "double-tap") await this.injectSyntheticRingInput("double-click", "watch");
      return;
    }
    if (kind !== "tap") {
      await this.injectSyntheticRingInput(MIRROR_TOUCH_GESTURES[kind], "watch");
      return;
    }
    const x = Math.round(Math.min(1, Math.max(0, nx)) * G2_LENS_WIDTH);
    const y = Math.round(Math.min(1, Math.max(0, ny)) * G2_LENS_HEIGHT);
    const stripShown = sidebarStripVisible(shell.getFocus());
    this.appendLog(`mirror tap at ${x},${y}`);
    if (!shell.hasOverlay() && stripShown && x < SIDEBAR_WIDTH) {
      const target = shell.windowAtSidebarPoint(x, y);
      if (target) {
        this.appendLog(`mirror tap: sidebar -> ${target.title}`);
        shell.focusWindow(target.windowId);
        shell.foregroundWindow()?.requestRender();
        this.requestShellRender();
      }
      return;
    }
    const window = shell.foregroundWindow();
    if (window && !shell.hasOverlay()) {
      const rect = appViewportRect(window.heightMode);
      const inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
      if (shell.getFocus() !== "window") {
        shell.focusWindow(window.windowId);
        this.requestShellRender();
      }
      if (inside && window.hitTest && (await window.hitTest(x - rect.x, y - rect.y))) {
        this.appendLog(`mirror tap: ${window.title} at ${x - rect.x},${y - rect.y}`);
        this.requestShellRender();
        return;
      }
    }
    await this.injectSyntheticRingInput("click", "watch");
  }

  /** A document arrived via Android's Share intent: open it as a new window. */
  async openSharedTextDocument(text: string): Promise<void> {
    this.appendLog(`shared text document received (${text.length} chars)`);
    if (!shell.isScreenOn()) {
      shell.wake("sidebar");
    }
    const handler = ALL_APPS.find((app) => app.openSharedText);
    if (!handler?.openSharedText) {
      this.appendLog("no app handles shared text");
      return;
    }
    handler.openSharedText(this.buildAppContext(handler), "Shared text", text);
  }

  private startTextSettingEdit(setting: ConfigSettingString): void {
    this.startTextSettingsEdit([setting], setting.editorTitle);
  }

  private startTextSettingsEdit(
    settings: readonly ConfigSettingString[],
    title: string,
    onFinish?: () => void,
    toggle?: TextSettingsEditToggle,
  ): void {
    this.activeTextSettings = Array.from(settings.slice(0, 2));
    this.activeTextEditorTitle = title;
    this.activeTextEditorOnFinish = onFinish ?? null;
    this.activeTextEditorToggle = toggle ?? null;
    this.emit();
  }

  /**
   * Begin voice capture with the provider chosen in settings. Used by both
   * push-to-talk and the Transcribe app. Android mic permission is the consent
   * gate even though the audio source is the G2 mic over BLE.
   */
  private startVoiceCapture(endpointing = false): void {
    this.beginVoiceCapture("ptt", endpointing);
  }

  private stopVoiceCapture(): void {
    voiceControlBridge.stopPushToTalk();
  }

  private startContinuousVoiceCapture(): void {
    this.beginVoiceCapture("continuous");
  }

  private stopContinuousVoiceCapture(): void {
    voiceControlBridge.stopContinuousCapture();
  }

  /**
   * Provider and key settings for a capture on the given connection; a null
   * communicator means preview-only mode, where the phone's own microphone
   * stands in for the G2 mic.
   */
  private voiceCaptureOptions(communicator: FaceclawCommunicatorBridge | null) {
    return {
      communicator: communicator?.getNativeCommunicator() ?? null,
      usePhoneMic: communicator === null,
      provider: voiceProviderSetting.get(),
      elevenLabsApiKey: elevenLabsApiKeySetting.get(),
      openAiApiKey: openAiApiKeySetting.get(),
      sonioxApiKey: sonioxApiKeySetting.get(),
      saveRecording: saveVoiceRecordingsSetting.get(),
      // "My voice only" (Microphones app): verify command utterances
      // against the enrolled wearer voice-print; non-matching speakers'
      // finals are suppressed by the bridge.
      speakerVerification: wearerVerificationOptions() ?? undefined,
      // The Microphones app's processing config applies to every capture:
      // spectral noise suppression and the Sonic Radar listening beam.
      ...micSession.captureProcessingOptions(),
    };
  }

  /**
   * Restart the mic for a capture that a previous session left holding. Cheap
   * to call per frame: it does nothing unless one is actually parked.
   */
  private resumeVoiceCapture(): void {
    if (!voiceControlBridge.hasSuspendedCapture()) return;
    const communicator = this.communicator;
    if (!communicator || this.phase !== "connected") return;
    this.appendLog("resuming voice capture on the new glasses session");
    voiceControlBridge.resumeCapture(this.voiceCaptureOptions(communicator));
  }

  /**
   * Gate for opening the voice dialog (the shell asks before pushing the
   * layer). Connected sessions always proceed — the mic permission prompt,
   * if needed, appears over the open dialog as it always has. Preview mode
   * captures from the phone mic, so a missing permission turns the tap into
   * the system permission prompt instead of a dialog that would listen to
   * nothing; a grant lets the dialog open right away.
   */
  private async prepareVoiceCapture(): Promise<boolean> {
    if (!this.isPreviewDisplayActive()) return true;
    if (hasMicrophonePermission()) return true;
    const granted = await requestMicrophonePermission();
    if (!granted) {
      this.appendLog("voice input blocked: microphone permission denied");
    }
    return granted;
  }

  private beginVoiceCapture(kind: "ptt" | "continuous", endpointing = false): void {
    // Preview mode captures from the phone mic (voiceCaptureOptions with a
    // null communicator); otherwise a live glasses session must be the source.
    const previewCapture = this.isPreviewDisplayActive();
    if (!previewCapture && (this.phase !== "connected" || !this.communicator)) {
      return;
    }
    const communicator = this.communicator;
    void ensureVoicePermissions()
      .then(() => {
        if (previewCapture) {
          if (!this.isPreviewDisplayActive()) return;
        } else if (this.phase !== "connected" || this.communicator !== communicator) {
          return;
        }
        const options = { ...this.voiceCaptureOptions(communicator), endpointing };
        if (kind === "ptt") {
          voiceControlBridge.startPushToTalk(options);
        } else {
          voiceControlBridge.startContinuousCapture(options);
        }
      })
      .catch((error) => {
        this.appendLog(`voice permission failed: ${this.formatError(error)}`);
      });
  }

  private endTextSettingEdit(): void {
    const finishedSettings = this.activeTextSettings;
    this.activeTextSettings = [];
    this.activeTextEditorTitle = "";
    this.activeTextEditorOnFinish = null;
    this.activeTextEditorToggle = null;
    this.emit();
    if (finishedSettings.includes(nightscoutSiteUrlSetting) || finishedSettings.includes(nightscoutApiTokenSetting)) {
      void this.refreshNightscoutAfterSettingsChange();
    }
  }

  /**
   * Finish the active edit from the phone side (e.g. the IME's done key):
   * ends the edit session and navigates the Settings app's glasses editor
   * out of the edit page.
   */
  finishActiveTextSettingEdit(): void {
    if (!this.activeTextSettings.length) return;
    const onFinish = this.activeTextEditorOnFinish;
    const closesGlassesEditor = this.activeTextSettings.length === 1;
    this.endTextSettingEdit();
    if (closesGlassesEditor && this.textEditorHost?.closeTextEditor()) {
      this.textEditorHost.requestRender();
    }
    onFinish?.();
  }

  private updateTextSetting(setting: ConfigSettingString, value: string): void {
    if (setting.get() !== value) {
      setting.set(value);
      this.emit();
      this.previewOrRenderAfterTextSettingChange();
    }
  }

  private async refreshNightscoutAfterSettingsChange(): Promise<void> {
    await nightscoutBridge.refreshNow().catch((error) => {
      this.appendLog(`nightscout settings refresh failed: ${this.formatError(error)}`);
    });
  }

  private previewOrRenderAfterTextSettingChange(): void {
    // Echo phone-side keystrokes into the Settings app's glasses editor.
    if (this.textEditorHost?.isTextEditorOnTop()) {
      this.textEditorHost.requestRender();
    }
  }

  private async handleInputEvent(event: RawInputEvent): Promise<void> {
    const frameId =
      event.frameId > 0 ? event.frameId : frameTimings.startFrame(`input:${event.kind} (untracked source)`);
    frameTimings.logFrame(frameId, `TS input handler start: ${event.kind} ${eventLabel(event.kind, event.eventType)}`);
    let frameOwned = false;
    try {
      const inputEvent = rawInputEventToInputEvent(event);
      // The gesture, plus which app is on screen and whether input goes to it,
      // the sidebar, or a shell overlay. Java only knows the raw event codes,
      // and without the target the export says what was pressed but not who
      // spent the time drawing the answer.
      frameTimings.annotateFrame(frameId, `${inputEvent.type} ${shell.describeInputTarget()}`);
      if (this.glassesLocked) {
        const ringDoubleTap =
          inputEvent.type === "double-click" &&
          (event.eventSource === EventSourceType.TOUCH_EVENT_FROM_RING ||
            event.eventSource === EventSourceType.TOUCH_EVENT_FROM_WATCH);
        const suspendedDisplayWake = inputEvent.type === "display-wake";
        if (ringDoubleTap || suspendedDisplayWake) {
          if (shell.isScreenOn()) {
            // A normal ring double-tap still turns the locked display off.
            // display-wake is directional and can only turn an off display on.
            if (ringDoubleTap) shell.sleep();
          } else {
            shell.wake("sidebar");
            const ready = await frameTimings.spanAsync(frameId, "wake-barrier", () =>
              this.ensureEvenHubSessionActive(frameId),
            );
            if (!ready) {
              this.appendLog("EvenHub wake barrier timed out for locked display");
            }
          }
          frameTimings.finishFrame(frameId, "locked display toggled");
          frameOwned = true;
        }
        return;
      }
      const wakewordShouldWake =
        event.kind === "even-ai" &&
        event.eventType === EvenAIStatus.EVEN_AI_WAKE_UP &&
        wakeWordActionSetting.get() !== "off";
      const displayShouldWake = event.kind === "display-wake";
      let shellPreWoke = false;
      if (wakewordShouldWake || displayShouldWake) {
        if (!shell.isScreenOn()) {
          shellPreWoke = shell.wake("sidebar");
        }
        if (shellPreWoke || this.evenHubSessionSuspended || this.evenHubResumePromise) {
          const ready = await frameTimings.spanAsync(frameId, "wake-barrier", () =>
            this.ensureEvenHubSessionActive(frameId),
          );
          if (!ready) {
            this.appendLog(`EvenHub wake barrier timed out for ${event.kind}`);
          }
        }
      }
      frameTimings.spanStart(frameId, "handle-input");
      let outcome: ShellInputOutcome;
      try {
        // The shell consumes its reserved gestures and forwards the rest to
        // the focused window; the outcome says which surfaces changed.
        outcome = await shell.receiveInput(inputEvent, frameId);
      } finally {
        frameTimings.spanEnd(frameId, "handle-input");
      }
      if (shellPreWoke && !outcome.shell) {
        outcome = { ...outcome, shell: true };
      }

      if (event.kind === "watch-gesture") {
        this.appendLog(`watch-gesture ${eventLabel(event.kind, event.eventType)}`);
      }
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
        if (
          event.eventSource === EventSourceType.TOUCH_EVENT_FROM_RING ||
          event.eventSource === EventSourceType.TOUCH_EVENT_FROM_WATCH
        ) {
          this.lastInput = eventName(event.eventType);
        }
      }

      if (outcome.shell) {
        // Pass frameId as the cause, not the owner: the chrome render gets its
        // own child frame under this one, so the export shows the input and
        // every render it triggered on a single timeline.
        this.requestShellRender(frameId);
      }
      if (outcome.window) {
        // The window adapter owned frameId (render or explicit finish).
        frameOwned = true;
      } else if (outcome.shell) {
        frameOwned = true;
        frameTimings.finishFrame(frameId, "handled by shell; chrome render spawned");
      }
    } finally {
      if (!frameOwned) {
        frameTimings.finishFrame(frameId, "discarded: input did not trigger a render");
      }
    }
  }

  /** Launch or focus an in-process singleton app (notifications, debug tests). */
  private async launchInProcessApp(
    windowId: string,
    surfaceId: string,
    create: (options: InProcessAppOptions) => InProcessWindow,
  ): Promise<void> {
    const existing = this.inProcessApps.get(windowId);
    if (existing) {
      shell.focusWindow(windowId);
      this.requestShellRender();
      return;
    }
    const app = create({
      actions: {
        ...this.sharedActions,
        requestRender: () => {}, // rebound by createInProcessWindow
      },
      submitFrame: (planes, paintMs, frameId) => this.submitWindowFrame(surfaceId, planes, paintMs, frameId),
      setSurfaceVisible: (visible) => this.setWindowSurfaceVisible(surfaceId, visible),
      removeSurface: () => this.removeWindowSurface(surfaceId),
      reconfigureSurface: (heightMode) => {
        // Resize the surface rect to the new band; a foreground window stays
        // visible. The shell re-renders so the chrome (top bar) follows.
        const visible = shell.foregroundWindow()?.windowId === windowId;
        void this.configureWindowSurface(surfaceId, visible, heightMode);
        this.requestShellRender();
      },
      onClosed: () => {
        this.inProcessApps.delete(windowId);
      },
    });
    this.inProcessApps.set(windowId, app);
    shell.registerWindow(app.window);
    await this.configureWindowSurface(surfaceId, false, app.window.heightMode);
    shell.focusWindow(windowId);
    this.requestShellRender();
    this.appendLog(`launched ${windowId}`);
  }

  /** Get or spawn the worker host for an app. */
  private ensureWorkerHost(appId: string, createWorker: () => Worker): WorkerAppHost {
    const existing = this.appHosts.get(appId);
    if (existing) return existing;
    const host = new WorkerAppHost({
      appId,
      worker: createWorker(),
      configureSurface: (surfaceId, visible, heightMode) =>
        this.configureWindowSurface(surfaceId, visible, heightMode),
      setSurfaceVisible: (surfaceId, visible) => this.setWindowSurfaceVisible(surfaceId, visible),
      removeSurface: (surfaceId) => this.removeWindowSurface(surfaceId),
      requestShellRender: () => this.requestShellRender(),
      openSettings: (section) => {
        void this.launchApp("settings", { section }).catch((error) => {
          this.appendLog(`settings launch failed: ${this.formatError(error)}`);
        });
      },
      startTextSettingEdit: (settingId) => {
        const setting = getStringSettingById(settingId);
        if (setting) {
          this.startTextSettingEdit(setting);
        } else {
          this.appendLog(`worker requested edit of unknown setting ${settingId}`);
        }
      },
      endTextSettingEdit: () => this.endTextSettingEdit(),
    });
    this.appHosts.set(appId, host);
    return host;
  }

  /** The services an app's launch/boot callbacks may use; see AppContext. */
  private buildAppContext(app: AppDefinition): AppContext {
    return {
      appId: app.appId,
      apps: ALL_APPS,
      actions: this.sharedActions,
      launchApp: (appId, params) => this.launchApp(appId, params),
      uninstallApp: (appId) => this.uninstallApp(appId),
      launchInProcessApp: (windowId, surfaceId, create) => this.launchInProcessApp(windowId, surfaceId, create),
      ensureWorkerHost: (createWorker) => this.ensureWorkerHost(app.appId, createWorker),
      submitWindowFrame: (surfaceId, planes, paintMs, frameId) =>
        this.submitWindowFrame(surfaceId, planes, paintMs, frameId),
      setWindowSurfaceVisible: (surfaceId, visible) => this.setWindowSurfaceVisible(surfaceId, visible),
      requestShellRender: () => this.requestShellRender(),
      appendLog: (message) => this.appendLog(message),
      setTextEditorHost: (host) => {
        this.textEditorHost = host;
      },
    };
  }

  /** Save which apps are open (and which is foreground) for restoreOpenApps. */
  private persistOpenApps(): void {
    if (!this.openAppsRestored || this.suppressOpenAppsPersist) return;
    const open: string[] = [];
    for (const window of shell.getWindows()) {
      if (window.appId === "launcher") continue;
      if (!open.includes(window.appId)) open.push(window.appId);
    }
    savePersistedOpenApps({ open, foreground: shell.foregroundWindow()?.appId ?? null });
  }

  /**
   * Reopen the apps that were open when the app last ran — a development
   * convenience so installing a new build restores the working set. Shallow by
   * design: apps relaunch fresh (no within-app state), and multi-window apps
   * reopen only their primary window. Runs once, on reaching the main page;
   * windows opened here get compositor surfaces at connect like any launch.
   */
  async restoreOpenApps(): Promise<void> {
    if (this.openAppsRestored) return;
    this.openAppsRestored = true;
    const saved = loadPersistedOpenApps();
    if (!saved.open.length) return;
    const known = new Set(ALL_APPS.map((app) => app.appId));
    this.suppressOpenAppsPersist = true;
    try {
      for (const appId of saved.open) {
        if (!known.has(appId) && !getInstalledEvenHubAppById(appId)) continue;
        try {
          await this.launchApp(appId);
        } catch (error) {
          this.appendLog(`restore of ${appId} failed: ${this.formatError(error)}`);
        }
      }
      const foreground = saved.foreground
        ? shell.getWindows().find((window) => window.appId === saved.foreground)
        : undefined;
      if (foreground) shell.focusWindow(foreground.windowId);
    } finally {
      this.suppressOpenAppsPersist = false;
    }
    // Re-save the canonical post-restore state (drops apps that failed to open).
    this.persistOpenApps();
    this.requestShellRender();
  }

  /**
   * Launch an app by id: the launcher grid, assistant tools, window-menu
   * Settings item, and open-apps restore all come through here. Apps with an
   * open window focus it instead of opening another.
   */
  private async launchApp(appId: string, params?: AppLaunchParams): Promise<void> {
    const app = ALL_APPS.find((entry) => entry.appId === appId);
    if (app) {
      await app.launch(this.buildAppContext(app), params);
      return;
    }
    const installed = getInstalledEvenHubAppById(appId);
    if (installed) {
      const host = ALL_APPS.find((entry) => entry.appId === "evenhub")!;
      await launchInstalledPackage(this.buildAppContext({ ...host, appId }), installed);
      return;
    }
    this.appendLog(`unknown app: ${appId}`);
  }

  private async uninstallApp(appId: string): Promise<void> {
    const packageId = installedEvenHubPackageId(appId);
    if (!packageId) {
      this.appendLog(`app is not uninstallable: ${appId}`);
      return;
    }
    closeRunningPackage(packageId);
    if (uninstallEvenHubPackage(packageId)) {
      this.appendLog(`evenhub: uninstalled ${packageId}`);
    }
  }

  /** Create/refresh a window surface on the compositor, if a display target exists. */
  private async configureWindowSurface(
    surfaceId: string,
    visible: boolean,
    heightMode: WindowHeightMode = "min",
    // ensurePreviewDisplay passes its not-yet-published target explicitly.
    target: DisplayTarget | null = this.display,
  ): Promise<void> {
    if (!target) return;
    await target.configureSurface(surfaceId, {
      ...appViewportRect(heightMode),
      zOrder: 0,
      transparency: "opaque",
    });
    await target.setSurfaceVisible(surfaceId, visible);
  }

  private removeWindowSurface(surfaceId: string): void {
    const display = this.display;
    if (!display) return;
    void display.removeSurface(surfaceId).catch((error) => {
      this.appendLog(`surface removal failed: ${this.formatError(error)}`);
    });
  }

  /** Submit a painted frame for an in-process window (e.g. the launcher). */
  private async submitWindowFrame(surfaceId: string, planes: Plane[], paintMs: number, frameId: number): Promise<void> {
    const display = this.display;
    if (!display || this.phase === "charging") {
      frameTimings.finishFrame(frameId, "discarded: window frame with no display target");
      return;
    }
    const fingerprint = frameTimings.span(frameId, "fingerprint", () => planesFingerprint(planes));
    const { image, draws } = frameTimings.span(frameId, "flatten", () => flattenPlanesWithDraws(planes));
    const buffer = frameTimings.span(frameId, "to8bpp", () => image.to8bppBuffer());
    const preparedDraws = frameTimings.span(frameId, "prepareFrameDraws", () => prepareFrameDraws(draws));
    await frameTimings.spanAsync(frameId, "submit", () =>
      display.submitSurfaceFrame(
        surfaceId,
        buffer,
        { x: 0, y: 0, width: image.width, height: image.height },
        fingerprint,
        paintMs,
        frameId,
        preparedDraws,
      ),
    );
  }

  /** Flip a window surface's compositor visibility; fire-and-forget. */
  private setWindowSurfaceVisible(surfaceId: string, visible: boolean): void {
    const display = this.display;
    if (!display) return;
    void display.setSurfaceVisible(surfaceId, visible).catch((error) => {
      this.appendLog(`surface visibility change failed: ${this.formatError(error)}`);
    });
  }

  /**
   * Re-render and resubmit the shell surface (sidebar, top bar, shell
   * overlays). Coalesces like requestRender: one render in flight, at most
   * one queued.
   */
  requestShellRender(causeFrameId = 0): void {
    // Remember the input frame that asked for this chrome repaint so
    // renderShell can nest its frame under it; without that link an input
    // event and the shell render it caused show up as two unrelated frames
    // and the real input-to-pixels latency is never measured.
    if (causeFrameId > 0 && this.pendingShellRenderCauseFrameId === 0) {
      this.pendingShellRenderCauseFrameId = causeFrameId;
    }
    if (this.shellRenderInProgress) {
      this.shellRenderQueued = true;
      return;
    }
    this.shellRenderInProgress = true;
    void (async () => {
      try {
        do {
          this.shellRenderQueued = false;
          await this.renderShell();
        } while (this.shellRenderQueued);
      } catch (error) {
        this.appendLog(`shell render failed: ${this.formatError(error)}`);
      } finally {
        this.shellRenderInProgress = false;
      }
    })();
  }

  private async renderShell(): Promise<void> {
    const causeFrameId = this.pendingShellRenderCauseFrameId;
    this.pendingShellRenderCauseFrameId = 0;
    const frameId = frameTimings.startFrame("render:shell", causeFrameId);
    frameTimings.annotateFrame(frameId, shell.describeInputTarget());
    const wantFreshData = this.nextShellRenderWantsFreshData;
    this.nextShellRenderWantsFreshData = false;
    if (wantFreshData) frameTimings.logFrame(frameId, "follow-up repaint that must not use cached data");
    beginRenderPass(!wantFreshData);
    const paintStartedAtMs = Date.now();
    const planes = frameTimings.span(frameId, "paint", () =>
      frameTimings.runWithFrame(frameId, () => shell.paintSurface()),
    );
    const paintMs = Date.now() - paintStartedAtMs;
    const paintUsedStaleData = endRenderPass();
    if (paintUsedStaleData) {
      // Repaint with fresh data (e.g. notification icons) once this frame is
      // out; mirrors renderDashboard's stale-data contract. Linked to this
      // frame so the export shows one input costing two round trips instead of
      // an unexplained extra render.
      this.nextShellRenderWantsFreshData = true;
      this.requestShellRender(frameId);
    }
    const display = this.display;
    if (!display || this.phase === "charging") {
      frameTimings.finishFrame(frameId, "discarded: shell render with no display target");
      return;
    }
    const fingerprint = frameTimings.span(frameId, "fingerprint", () => planesFingerprint(planes));
    const { image, draws } = frameTimings.span(frameId, "flatten", () => flattenPlanesWithDraws(planes));
    const buffer = frameTimings.span(frameId, "to8bpp", () => image.to8bppBuffer());
    const preparedDraws = frameTimings.span(frameId, "prepareFrameDraws", () => prepareFrameDraws(draws));
    // Spanned because the bridge serializes Java calls: a frame can sit here
    // behind another surface's submission, which is otherwise an unexplained
    // jump between the paint spans and the composite.
    await frameTimings.spanAsync(frameId, "submit", () =>
      display.submitSurfaceFrame(
        SHELL_SURFACE_ID,
        buffer,
        { x: 0, y: 0, width: image.width, height: image.height },
        fingerprint,
        paintMs,
        frameId,
        preparedDraws,
      ),
    );
    // Backpressure: the next shell render waits for this one to reach the
    // glasses. Timing out here means the loop was blocked for the full timeout
    // and any input arriving meanwhile had its chrome repaint delayed, so say
    // so in the frame rather than leaving a silent stall. (The preview target
    // resolves immediately; nothing transmits.)
    const outcome = await display.waitForFrameFinished(frameId, FRAME_TRANSMIT_BACKPRESSURE_TIMEOUT_MS);
    if (outcome === null) {
      frameTimings.logFrame(
        frameId,
        `still unsent after ${FRAME_TRANSMIT_BACKPRESSURE_TIMEOUT_MS}ms; shell render loop released`,
      );
    }
    this.schedulePreviewUpdate();
  }

  private async handleAndroidNotificationPosted(notificationKey: string): Promise<void> {
    if (!notificationKey) {
      this.requestShellRender();
      return;
    }
    // New notifications open a shell modal over the app viewport; if the
    // screen was off, wake for it and go back to sleep when it is closed.
    // Waking while already on would steal focus, so only wake from sleep.
    const wokeScreen = shell.isScreenOn() ? false : shell.wake("sidebar");
    if (wokeScreen) {
      this.appendLog("android notification woke the screen");
    }
    shell.openNotificationModal(notificationKey, wokeScreen);
    this.requestShellRender();
  }

  private async playBuzzerSequence(payload: Uint8Array): Promise<void> {
    if (this.phase !== "connected" || !this.communicator) {
      return;
    }
    await this.communicator.playBuzzerSequence(payload);
  }

  /** One-time celebratory jingle on the first connection after onboarding. */
  private async playWelcomeSound(): Promise<void> {
    const effect = findSoundEffect("questcomplete");
    if (!effect) return;
    try {
      await playSoundEffect(
        effect,
        (payload) => this.playBuzzerSequence(payload),
        (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      );
    } catch (error) {
      this.appendLog(`welcome sound failed: ${this.formatError(error)}`);
    }
  }

  private clearDashboardTimer(): void {
    this.cancelEvenHubSuspendTimer();
    if (this.shellRefreshTimer) {
      clearInterval(this.shellRefreshTimer);
      this.shellRefreshTimer = null;
    }
    if (this.previewTimer) {
      clearInterval(this.previewTimer);
      this.previewTimer = null;
    }
    if (this.previewTrailingTimer) {
      clearTimeout(this.previewTrailingTimer);
      this.previewTrailingTimer = null;
    }
    if (this.screenTimeoutTimer) {
      clearInterval(this.screenTimeoutTimer);
      this.screenTimeoutTimer = null;
    }
  }

  private setPhase(phase: ConnectionPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    if (phase === "disconnected") {
      // Kept across "connecting": silent mode blocks app launches, so it can
      // itself cause the reconnect churn, and Java re-reports it either way.
      this.silentMode = false;
    }
    this.emit();
  }

  private setStatus(status: string): void {
    if (this.status === status) return;
    this.status = status;
    this.emit();
  }

  private updateConnectedForegroundNotification(): void {
    if (this.phase !== "connected") return;
    const now = Date.now();
    if (now - this.lastForegroundNotificationUpdateAtMs < FOREGROUND_NOTIFICATION_MIN_UPDATE_MS) return;
    this.lastForegroundNotificationUpdateAtMs = now;
    updateForegroundNotification("Connected");
  }

  private appendLog(line: string): void {
    console.log(`[${formatTimestamp(new Date())}] ${line}`);
  }

  private setDisplayPreview(preview: ImageSource | null): void {
    if (this.displayPreview === preview) return;
    this.displayPreview = preview;
    this.emit();
  }

  /**
   * Phone-side preview of what is on the glasses, fetched from the Java
   * compositor so it reflects every surface (chrome + whichever app is
   * foreground, including worker apps the TS side never renders). Throttled
   * to avoid rebuilding the bitmap faster than the phone UI needs it.
   */
  private previewTrailingTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRecordCaptureAtMs = 0;

  /**
   * Refresh the preview now if the floor allows, otherwise once the floor
   * expires — so the last frame of a burst always reaches the mirror instead
   * of waiting for the safety-net poll.
   */
  private schedulePreviewUpdate(): void {
    if (this.previewTrailingTimer) return;
    const wait = this.lastConnectedPreviewUpdateAtMs + CONNECTED_PREVIEW_MIN_UPDATE_MS - Date.now();
    if (wait <= 0) {
      this.updateCompositePreview();
      return;
    }
    this.previewTrailingTimer = setTimeout(() => {
      this.previewTrailingTimer = null;
      this.updateCompositePreview();
    }, wait);
  }

  private updateCompositePreview(): void {
    const display = this.display;
    if (!display) return;
    // The floor comes first (and stamps even when backgrounded below): with
    // it after the background check, per-frame refresh requests from a
    // backgrounded app never advance the timestamp and every one of them
    // pays the foreground-activity lookup.
    const now = Date.now();
    if (
      this.lastConnectedPreviewUpdateAtMs > 0 &&
      now - this.lastConnectedPreviewUpdateAtMs < CONNECTED_PREVIEW_MIN_UPDATE_MS
    ) {
      return;
    }
    this.lastConnectedPreviewUpdateAtMs = now;
    // The connected foreground service intentionally keeps this controller
    // alive after the phone UI is backgrounded. Do not keep constructing
    // 640x480 Android Bitmaps for a window that cannot display them: besides
    // being wasted work, paused NativeScript views can retain queued image
    // updates long enough to put severe pressure on the native heap.
    if (global.isAndroid) {
      const activity = Application.android.foregroundActivity;
      if (!activity || !activity.hasWindowFocus()) return;
    }
    if (this.screenRecordingActive && now - this.lastRecordCaptureAtMs >= RECORDING_MIN_CAPTURE_MS) {
      this.lastRecordCaptureAtMs = now;
      display.recordScreenFrame();
    }
    const preview = display.getCompositePreview(previewColorSetting.get() === "green");
    if (preview) {
      this.setDisplayPreview(preview);
    }
  }

  private formatError(error: unknown): string {
    const raw = (error as Error)?.message ?? String(error);
    const sanitized = raw.replace(/[\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim();
    if (sanitized.length <= 240) return sanitized;
    return `${sanitized.slice(0, 237)}...`;
  }

  private buildSyntheticRingInput(
    kind:
      | "click"
      | "double-click"
      | "scroll-up"
      | "scroll-down"
      | "long-press"
      | "long-press-release"
      | "wakeword"
      | "swipe-left"
      | "swipe-right"
      | "swipe-up"
      | "swipe-down",
    origin: SyntheticInputOrigin = "ring",
  ): RawInputEvent {
    const frameId = frameTimings.startFrame(`input:synthetic:${kind}`);
    // The phone UI's test buttons stand in for the ring; the watch is its own
    // source so the UI can give it a richer scheme (see InputSource).
    const eventSource =
      origin === "watch" ? EventSourceType.TOUCH_EVENT_FROM_WATCH : EventSourceType.TOUCH_EVENT_FROM_RING;
    switch (kind) {
      case "swipe-left":
      case "swipe-right":
      case "swipe-up":
      case "swipe-down":
        // Watch-only directional input; see WatchGestureType.
        return {
          kind: "watch-gesture",
          containerName: "",
          eventType: {
            "swipe-left": WatchGestureType.SWIPE_LEFT,
            "swipe-right": WatchGestureType.SWIPE_RIGHT,
            "swipe-up": WatchGestureType.SWIPE_UP,
            "swipe-down": WatchGestureType.SWIPE_DOWN,
          }[kind],
          eventSource: 0,
          systemExitReasonCode: 0,
          frameId,
        };
      case "wakeword":
        // Same event the glasses report for the spoken wakeword (sid 0x07).
        return {
          kind: "even-ai",
          containerName: "",
          eventType: EvenAIStatus.EVEN_AI_WAKE_UP,
          eventSource: 0,
          systemExitReasonCode: 0,
          frameId,
        };
      case "long-press":
        return {
          kind: "sys-event",
          containerName: "",
          eventType: OsEventTypeList.RING_LONG_PRESS_EVENT,
          eventSource,
          systemExitReasonCode: 0,
          frameId,
        };
      case "long-press-release":
        return {
          kind: "sys-event",
          containerName: "",
          eventType: OsEventTypeList.RING_LONG_PRESS_RELEASE_EVENT,
          eventSource,
          systemExitReasonCode: 0,
          frameId,
        };
      case "click":
        return {
          kind: "sys-event",
          containerName: "",
          eventType: OsEventTypeList.CLICK_EVENT,
          eventSource,
          systemExitReasonCode: 0,
          frameId,
        };
      case "double-click":
        return {
          kind: "sys-event",
          containerName: "",
          eventType: OsEventTypeList.DOUBLE_CLICK_EVENT,
          eventSource,
          systemExitReasonCode: 0,
          frameId,
        };
      case "scroll-up":
        return {
          kind: "text-click",
          containerName: "",
          eventType: OsEventTypeList.SCROLL_TOP_EVENT,
          eventSource,
          systemExitReasonCode: 0,
          frameId,
        };
      case "scroll-down":
      default:
        return {
          kind: "text-click",
          containerName: "",
          eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT,
          eventSource,
          systemExitReasonCode: 0,
          frameId,
        };
    }
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
    this.wearRemote?.schedulePublish();
  }
}

export const dashboardController = new DashboardController();
