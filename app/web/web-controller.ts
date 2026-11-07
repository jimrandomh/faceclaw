import { launcherEntries } from "../apps/launcher";
import { ALL_APPS } from "../apps/all-apps";
import type { AppContext, AppDefinition, AppLaunchParams } from "../apps/app-definition";
import { createLauncherWindow, LAUNCHER_SURFACE_ID } from "../apps/launcher/launcher-app";
import { createNotificationsAppWindow, NOTIFICATIONS_SURFACE_ID, NOTIFICATIONS_WINDOW_ID } from "../apps/notifications/notifications-app";
import { GlanceHost, type GlanceDisplay } from "../g2/glance-host";
import { mirrorToPanelFraction, phonePreviewCrop } from "../g2/phone-preview-crop";
import { prepareFrameDraws } from "../graphics/glyph-wire";
import { G2_LENS_HEIGHT, G2_LENS_WIDTH } from "../graphics/image";
import { flattenPlanesWithDraws, planesFingerprint, type Plane } from "../graphics/plane";
import { nightscoutBridge } from "../native/nightscout-bridge";
import { readActiveNotifications } from "../native/notification-icons";
import { shouldShowNotificationOnGlasses } from "../native/notification-sources";
import { PreviewDisplayTarget } from "../native/preview-display";
import { weatherBridge } from "../native/weather";
import type { PhoneGesture } from "../phone-ui/phone-gestures";
import { brightnessSetting, brightnessSettingToLevel, getStringSettingById, onAnySettingChanged, previewColorSetting } from "../ui/dashboard-settings";
import { makeInputEvent, type InputEvent, type InputEventPayload } from "../ui/gestures";
import { acceptInput } from "../ui/input-monitor";
import { noopLayerActions, type LayerActions } from "../ui/layers";
import { appViewportRect, isOnSwitcherEdge, sidebarStripVisible, type ScreenRect } from "../ui/shell/geometry";
import { type InProcessAppOptions, type InProcessWindow } from "../ui/shell/in-process-window";
import type { KeyboardInputSession } from "../ui/shell/keyboard-input";
import { shell, type ShellWindow } from "../ui/shell/shell";
import { WorkerAppHost } from "../ui/shell/worker-window";
import { playBuzzerSequence } from "./buzzer";
import { demoBatteries } from "./demo-data/device";
import { onDemoNotificationPopup } from "./demo-data/notifications";
import { promptDialog, alertDialog } from "./dialogs";
import { WebAppWorker, setWorkerFrameSink } from "./workers";

const SHELL_SURFACE_ID = "shell";
const SHELL_SURFACE_Z_ORDER = 1;
const MAX_BRIGHTNESS_LEVEL = 42;

export type WebFrame = {
  /** Gray pixels (row-major) of the whole panel, which the crop then selects from. */
  gray: Uint8Array;
  width: number;
  height: number;
  /** The screen area to show (Preview scaling), or null for the whole panel. */
  crop: ScreenRect | null;
  green: boolean;
  /** The Brightness setting, 0..1 (Auto shows full). */
  brightness: number;
  /** Foreground app and focus, for the page's status line. */
  focus: string;
};

export type WebControllerCallbacks = {
  onFrame: (frame: WebFrame) => void;
  onError: (message: string) => void;
  onKeyboardInputChanged: (session: KeyboardInputSession | null) => void;
};

/**
 * The browser host for the shared app registry and shell, in the mold of
 * IosPreviewController with everything about a glasses session taken out: frames
 * end at the shared Kotlin compositor (PreviewDisplayTarget), input arrives from
 * the page, and whatever the phones get from hardware comes from sample data.
 */
export class WebController {
  private readonly display = new PreviewDisplayTarget(G2_LENS_WIDTH, G2_LENS_HEIGHT);
  /** Resolves once the compositor has its base surfaces; frames wait for it. */
  private readonly displayReady: Promise<void>;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private previewCrop: ScreenRect | null = null;
  private clockMinute = -1;
  private shellRenderInProgress = false;
  private shellRenderQueued = false;
  private unblankAfterShellRender = false;
  private nextWorkerFrame = 0;
  private inputQueue: Promise<void> = Promise.resolve();
  private lastLayout = "";
  private readonly appHosts = new Map<string, WorkerAppHost>();
  private readonly inProcessApps = new Map<string, InProcessWindow>();

  private readonly actions: LayerActions = {
    ...noopLayerActions,
    playBuzzerSequence: (payload) => playBuzzerSequence(payload),
    requestRender: () => this.requestShellRender(),
    startTextSettingEdit: async (setting) => { await this.editSetting(setting); },
    startTextSettingsEdit: async (settings, _title, finished, toggle, cancelled) => {
      for (const setting of settings) {
        if (!(await this.editSetting(setting))) { cancelled?.(); return; }
      }
      toggle?.setting.set(true);
      finished?.();
    },
  };

  private readonly glanceDisplay: GlanceDisplay = {
    configureSurface: async (id, options) => { await this.display.configureSurface(id, options); },
    setSurfaceVisible: async (id, visible) => { await this.display.setSurfaceVisible(id, visible); this.schedulePreviewUpdate(); },
    setSurfaceDepth: async (id, depth) => { await this.display.setSurfaceDepth(id, depth); },
    setScreenBlanked: async (blanked) => { await this.display.setScreenBlanked(blanked); this.schedulePreviewUpdate(); },
    submitSurfaceFrame: async (id, pixels, rect, fingerprint, paintMs, frameId, draws) => {
      await this.display.submitSurfaceFrame(id, pixels, rect, fingerprint, paintMs, frameId, draws);
      this.schedulePreviewUpdate();
    },
  };

  private readonly glance = new GlanceHost({
    getDisplay: () => this.glanceDisplay,
    getProvider: () => ALL_APPS.find((app) => app.glanceboard)?.glanceboard ?? null,
    canShow: () => true,
    ensureSessionActive: async () => {
      await this.display.setScreenBlanked(false);
      this.schedulePreviewUpdate();
      return true;
    },
    onHiddenWhileAsleep: () => {
      if (!shell.isScreenOn()) void this.display.setScreenBlanked(true).then(() => this.schedulePreviewUpdate());
      else this.schedulePreviewUpdate();
    },
    onVisibilityChanged: () => this.schedulePreviewUpdate(),
    appendLog: (message) => console.log(`[glance] ${message}`),
  });

  constructor(private readonly callbacks: WebControllerCallbacks) {
    this.display.activate(() => this.schedulePreviewUpdate());
    setWorkerFrameSink((surfaceId, pixels, width, height, draws) => {
      void this.submitWorkerPixels(surfaceId, pixels, width, height, draws).catch((error) => this.fail(error));
    });
    this.displayReady = this.registerSurfaces().catch((error) => this.fail(error));
    shell.configure({
      actions: this.actions,
      voiceInputEnabled: false,
      onKeyboardInputChanged: (session) => callbacks.onKeyboardInputChanged(session),
      getScreenTimeoutMs: () => null,
      requestShellRender: () => this.requestShellRender(),
      onWindowsChanged: () => this.requestShellRender(),
      openNotificationsWindow: () =>
        this.openInProcessAppInBackground(NOTIFICATIONS_WINDOW_ID, NOTIFICATIONS_SURFACE_ID, createNotificationsAppWindow),
      onSwitcherBarHeightChanged: () => {
        this.relayout();
        shell.foregroundWindow()?.requestRender();
        this.requestShellRender();
      },
      onScreenStateChanged: (on) => {
        if (on) this.glance.dismiss();
        this.unblankAfterShellRender = on;
        if (!on) void this.display.setScreenBlanked(true).catch((error) => this.fail(error));
        this.requestShellRender();
      },
    });
    shell.setBatteryLevels({
      headset: demoBatteries.headset, headsetCharging: false,
      ring: demoBatteries.ring, ringCharging: false,
      case: demoBatteries.case, caseCharging: null,
    });

    const launcher = createLauncherWindow({
      actions: this.actions,
      apps: () => launcherEntries(ALL_APPS),
      launchApp: (id) => this.launchApp(id),
      uninstallApp: async () => {},
      submitFrame: (planes) => this.submit(LAUNCHER_SURFACE_ID, planes),
      setSurfaceVisible: (visible) => this.setWindowSurfaceVisible(LAUNCHER_SURFACE_ID, visible),
    });
    void this.configureWindow(launcher);
    shell.registerWindow(launcher);
    shell.wake("window");
    shell.focusWindow(launcher.windowId);

    onDemoNotificationPopup((key) => {
      const notification = readActiveNotifications(128).find((candidate) => candidate.key === key);
      if (!notification || !shouldShowNotificationOnGlasses(notification.packageName)) return;
      const woke = !shell.isScreenOn() && shell.wake("sidebar");
      shell.openNotificationModal(key, woke);
      this.requestShellRender();
    });
    for (const app of ALL_APPS) if (app.appId !== "launcher") app.boot?.(this.buildAppContext(app));

    void nightscoutBridge.start().catch((error) => this.fail(error));
    weatherBridge.setSessionActive(true);
    onAnySettingChanged(() => {
      this.relayout();
      shell.foregroundWindow()?.requestRender();
      this.requestShellRender();
      this.schedulePreviewUpdate();
    });
    setInterval(() => this.refreshClock(), 1000);
    this.relayout();
    shell.foregroundWindow()?.requestRender();
    this.requestShellRender();
  }

  private async registerSurfaces(): Promise<void> {
    await this.display.configureCompositorScreen(G2_LENS_WIDTH, G2_LENS_HEIGHT);
    await this.display.configureSurface(SHELL_SURFACE_ID, {
      x: 0, y: 0, width: G2_LENS_WIDTH, height: G2_LENS_HEIGHT, zOrder: SHELL_SURFACE_Z_ORDER, transparency: "color-key",
    });
    await this.display.setUnderlayDim(SHELL_SURFACE_Z_ORDER, 1);
    await this.display.setScreenBlanked(!shell.isScreenOn());
    this.lastLayout = "";
    for (const window of shell.getWindows()) await this.configureWindow(window);
  }

  private refreshClock(): void {
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== this.clockMinute) {
      this.clockMinute = minute;
      this.requestShellRender();
    }
  }

  private async configureWindow(window: ShellWindow): Promise<void> {
    await this.display.configureSurface(window.surfaceId, {
      ...appViewportRect(window.heightMode, window.appId), zOrder: 0, transparency: "opaque",
    });
    await this.display.setSurfaceVisible(window.surfaceId, shell.foregroundWindow()?.windowId === window.windowId);
  }

  private relayout(): void {
    const layout = shell.getWindows().map((window) => JSON.stringify(appViewportRect(window.heightMode, window.appId))).join(";");
    if (layout === this.lastLayout) return;
    this.lastLayout = layout;
    for (const window of shell.getWindows()) {
      void this.configureWindow(window).catch((error) => this.fail(error));
      window.relayout?.();
    }
  }

  private async submit(id: string, planes: Plane[], live: () => boolean = () => true): Promise<void> {
    await this.displayReady;
    if (!live()) return;
    const fingerprint = planesFingerprint(planes);
    const { image, draws } = flattenPlanesWithDraws(planes);
    await this.display.submitSurfaceFrame(id, image.pixels, { x: 0, y: 0, width: image.width, height: image.height },
      fingerprint, -1, 0, prepareFrameDraws(draws));
  }

  private async submitWorkerPixels(id: string, pixels: Uint8Array, width: number, height: number, draws: ArrayBuffer | null): Promise<void> {
    await this.displayReady;
    await this.display.submitSurfaceFrame(id, pixels, { x: 0, y: 0, width, height }, `${id}#${++this.nextWorkerFrame}`, -1, 0, draws);
  }

  private setWindowSurfaceVisible(id: string, visible: boolean): void {
    void this.display.setSurfaceVisible(id, visible).catch((error) => this.fail(error));
  }

  private removeWindowSurface(id: string): void {
    void this.display.removeSurface(id).catch((error) => this.fail(error));
  }

  /** One render in flight, at most one queued. */
  private requestShellRender(): void {
    if (this.shellRenderInProgress) { this.shellRenderQueued = true; return; }
    this.shellRenderInProgress = true;
    void (async () => {
      try {
        do {
          this.shellRenderQueued = false;
          await this.renderShell();
        } while (this.shellRenderQueued);
      } catch (error) {
        this.fail(error);
      } finally {
        this.shellRenderInProgress = false;
      }
    })();
  }

  private async renderShell(): Promise<void> {
    await this.displayReady;
    const unblank = this.unblankAfterShellRender;
    this.unblankAfterShellRender = false;
    try {
      await this.display.submitShellScene(shell.paintScene());
    } finally {
      if (unblank && shell.isScreenOn()) await this.display.setScreenBlanked(false);
    }
    this.schedulePreviewUpdate();
  }

  /** Coalesced to the display's own pace: nobody needs more than the panel's 60 Hz here. */
  private schedulePreviewUpdate(): void {
    if (this.previewTimer !== null) return;
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      try {
        const crop = phonePreviewCrop(false, this.glance.screenRect());
        this.previewCrop = crop;
        const window = shell.foregroundWindow();
        this.callbacks.onFrame({
          gray: this.display.composite(),
          width: this.display.width,
          height: this.display.height,
          crop,
          green: previewColorSetting.get() === "green",
          brightness: (brightnessSettingToLevel(brightnessSetting.get()) ?? MAX_BRIGHTNESS_LEVEL) / MAX_BRIGHTNESS_LEVEL,
          focus: !shell.isScreenOn() && !this.glance.isVisible() ? "Display asleep"
            : this.glance.isVisible() ? "Glanceboard"
            : `${window?.title ?? "Apps"}${shell.getFocus() === "sidebar" ? " · App switcher" : ""}`,
        });
      } catch (error) {
        this.fail(error);
      }
    }, 16);
  }

  private fail(error: unknown): void {
    console.error(error);
    this.callbacks.onError(error instanceof Error ? error.message : String(error));
  }

  /**
   * A gesture from the page: the mirror (the display itself, where a tap lands on what's
   * under it), or the on-page ring. Mirror coordinates are fractions of the shown area.
   */
  gesture(gesture: PhoneGesture, origin: "ring" | "mirror", nx = 0, ny = 0): void {
    this.inputQueue = this.inputQueue.then(async () => {
      if (gesture === "press" && origin === "mirror") return;
      if (gesture === "tap" && origin === "mirror" && shell.isScreenOn()) {
        await this.mirrorTap(nx, ny);
        return;
      }
      let type: string = ({ press: "ring-press", tap: "click", "double-tap": "double-click" } as Record<string, string>)[gesture] ?? gesture;
      if (origin === "ring" && type.startsWith("swipe-")) {
        if (type === "swipe-left" || type === "swipe-right") return;
        type = type === "swipe-up" ? "scroll-up" : "scroll-down";
      }
      await this.receiveInput(makeInputEvent({ type, source: origin === "ring" ? "ring" : "watch" } as InputEventPayload));
    }).catch((error) => this.fail(error));
  }

  /** A full discrete gesture from a keyboard key or a page button: a hold includes its release. */
  input(type: "click" | "double-click" | "scroll-up" | "scroll-down" | "long-press" | "short-then-long-press" | "long-press-release"): void {
    this.inputQueue = this.inputQueue.then(async () => {
      await this.receiveInput(makeInputEvent({ type, source: "ring" } as InputEventPayload));
    }).catch((error) => this.fail(error));
  }

  private async receiveInput(event: InputEvent): Promise<void> {
    if (!acceptInput(event)) return;
    if (!shell.isScreenOn()) {
      const glanceEvent = this.glance.eventForGesture(event.type);
      if (glanceEvent?.type === "dismiss") this.glance.dismiss();
      else if (glanceEvent) {
        await this.glance.handleEvent(glanceEvent, 0);
        return;
      }
    }
    await shell.receiveInput(event);
    this.requestShellRender();
  }

  /** The hit-testing of the phones' mirrors (IosPreviewController.mirrorTap). */
  private async mirrorTap(mirrorNx: number, mirrorNy: number): Promise<void> {
    const { nx, ny } = mirrorToPanelFraction(this.previewCrop, mirrorNx, mirrorNy);
    const x = Math.max(0, Math.min(G2_LENS_WIDTH - 1, Math.floor(nx * G2_LENS_WIDTH)));
    const y = Math.max(0, Math.min(G2_LENS_HEIGHT - 1, Math.floor(ny * G2_LENS_HEIGHT)));
    if (!shell.hasOverlay() && shell.focusStatusItemAt(x, y)) { this.requestShellRender(); return; }
    const window = shell.foregroundWindow();
    if (!shell.hasOverlay() && sidebarStripVisible(shell.getFocus(), window?.appId)
      && isOnSwitcherEdge(x, y, window?.heightMode ?? "min", window?.appId)) {
      const target = shell.windowAtSidebarPoint(x, y);
      if (target) { shell.focusWindow(target.windowId); target.requestRender(); this.requestShellRender(); }
      return;
    }
    if (window && !shell.hasOverlay()) {
      const rect = appViewportRect(window.heightMode, window.appId);
      if (x < rect.x || x >= rect.x + rect.width || y < rect.y || y >= rect.y + rect.height) return;
      shell.focusWindow(window.windowId);
      if (await window.hitTest?.(x - rect.x, y - rect.y)) { this.requestShellRender(); return; }
    }
    await this.receiveInput(makeInputEvent({ type: "click", source: "watch" }));
  }

  async launchApp(id: string, params?: AppLaunchParams): Promise<void> {
    const app = ALL_APPS.find((candidate) => candidate.appId === id);
    if (!app) return;
    try {
      await app.launch(this.buildAppContext(app), params);
    } catch (error) {
      this.fail(error);
    }
  }

  startKeyboardInput(): void {
    shell.startKeyboardInput();
    this.requestShellRender();
  }

  private buildAppContext(app: AppDefinition): AppContext {
    return {
      appId: app.appId,
      apps: ALL_APPS,
      actions: this.actions,
      launchApp: (id, params) => this.launchApp(id, params),
      uninstallApp: async () => {},
      launchInProcessApp: (id, surface, create) => this.launchInProcessApp(id, surface, create),
      openInProcessAppInBackground: (id, surface, create) => this.openInProcessAppInBackground(id, surface, create),
      ensureWorkerHost: (create) => this.ensureWorkerHost(app.appId, create),
      submitWindowFrame: (id, planes) => this.submit(id, planes),
      setWindowSurfaceVisible: (id, visible) => this.setWindowSurfaceVisible(id, visible),
      requestShellRender: () => this.requestShellRender(),
      appendLog: (message) => console.log(`[app] ${message}`),
      setTextEditorHost: () => {},
    };
  }

  private async launchInProcessApp(windowId: string, surfaceId: string,
    create: (options: InProcessAppOptions) => InProcessWindow): Promise<void> {
    const existing = this.inProcessApps.get(windowId);
    if (existing) {
      shell.focusWindow(windowId);
      existing.requestRender();
      this.requestShellRender();
      return;
    }
    const { app, surface } = this.createInProcessApp(windowId, surfaceId, create);
    await this.configureWindow(app.window);
    surface.ready = true;
    shell.registerWindow(app.window);
    shell.focusWindow(windowId);
    app.requestRender();
    this.requestShellRender();
  }

  private openInProcessAppInBackground(windowId: string, surfaceId: string,
    create: (options: InProcessAppOptions) => InProcessWindow): { window: InProcessWindow; opened: boolean } {
    const existing = this.inProcessApps.get(windowId);
    if (existing) return { window: existing, opened: false };
    const { app, surface } = this.createInProcessApp(windowId, surfaceId, create);
    void this.configureWindow(app.window).catch((error) => this.fail(error));
    surface.ready = true;
    shell.registerWindow(app.window);
    return { window: app, opened: true };
  }

  private createInProcessApp(windowId: string, surfaceId: string,
    create: (options: InProcessAppOptions) => InProcessWindow): { app: InProcessWindow; surface: { ready: boolean } } {
    const surface = { ready: false };
    const app = create({
      actions: this.actions,
      submitFrame: (planes) => (surface.ready ? this.submit(surfaceId, planes, () => surface.ready) : Promise.resolve()),
      setSurfaceVisible: (visible) => this.setWindowSurfaceVisible(surfaceId, visible),
      removeSurface: () => { surface.ready = false; this.removeWindowSurface(surfaceId); },
      reconfigureSurface: () => {
        const window = shell.getWindows().find((candidate) => candidate.windowId === windowId);
        if (window) void this.configureWindow(window).catch((error) => this.fail(error));
        this.requestShellRender();
      },
      onClosed: () => { this.inProcessApps.delete(windowId); },
    });
    this.inProcessApps.set(windowId, app);
    return { app, surface };
  }

  private ensureWorkerHost(appId: string, create: () => Worker): WorkerAppHost {
    const existing = this.appHosts.get(appId);
    if (existing) return existing;
    const worker = create();
    const host = new WorkerAppHost({
      appId,
      worker: worker as unknown as Worker,
      onStopping: () => { if (this.appHosts.get(appId) === host) this.appHosts.delete(appId); },
      playBuzzerSequence: (payload) => this.actions.playBuzzerSequence(payload),
      openUrl: (url) => { window.open(url, "_blank", "noopener"); },
      configureSurface: async (id, visible, heightMode) => {
        await this.display.configureSurface(id, { ...appViewportRect(heightMode, appId), zOrder: 0, transparency: "opaque" });
        await this.display.setSurfaceVisible(id, typeof visible === "function" ? visible() : visible);
      },
      setSurfaceVisible: (id, visible) => this.setWindowSurfaceVisible(id, visible),
      removeSurface: (id) => this.removeWindowSurface(id),
      requestShellRender: () => this.requestShellRender(),
      openSettings: (section) => { void this.launchApp("settings", { section }); },
      startTextSettingEdit: (id) => {
        const setting = getStringSettingById(id);
        if (setting) void this.editSetting(setting);
      },
      endTextSettingEdit: () => {},
      startTextInput: () => shell.startKeyboardInput(),
    });
    this.appHosts.set(appId, host);
    return host;
  }

  private async editSetting(setting: { editorTitle: string; inputKind?: string; get(): string; set(value: string): void; validationError?(value?: string): string | null }): Promise<boolean> {
    let draft = setting.get();
    for (;;) {
      const result = await promptDialog({ title: setting.editorTitle, defaultText: draft, inputType: setting.inputKind, okButtonText: "Save" });
      if (!result.result) return false;
      draft = result.text;
      const error = setting.validationError?.(draft);
      if (error) {
        await alertDialog({ title: setting.editorTitle, message: error });
        continue;
      }
      setting.set(draft);
      return true;
    }
  }
}

export type { WebAppWorker };
