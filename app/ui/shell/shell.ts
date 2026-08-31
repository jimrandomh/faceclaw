import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { singlePlane, type Plane } from "../../graphics/plane";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { EvenAIStatus, EventSourceType, OsEventTypeList, WatchGestureType } from "../../g2/events";
import type { RawInputEvent } from "../../native/faceclaw-communicator";
import {
  directionalFallback,
  InputEvent,
  type InputEventPayload,
  type InputSource,
  isDirectionalInput,
  isWatchInput,
  makeInputEvent,
} from "../gestures";
import { Layer, LayerActions, LayerContext, LayerStack, noopLayerActions } from "../layers";
import { MenuLayer, type MenuItem } from "../menu";
import { VoiceInputLayer, type VoiceSendTarget } from "./voice-input";
import { voiceActivity } from "./voice-activity";
import { AssistantLayer } from "./assistant";
import { AssistantSession, type AssistantBackendConfig } from "../../assistant/session";
import { resolveAssistantModel } from "../../assistant/models";
import type { AssistantContext } from "../../assistant/types";
import { SingleNotificationLayer } from "../notifications";
import {
  anthropicApiKeySetting,
  assistantBackendSetting,
  assistantBridgeHostSetting,
  assistantBridgePortSetting,
  assistantBridgeTokenSetting,
  assistantModelSetting,
  assistantSkipConfirmationSetting,
  batteryDisplayModeSetting,
  onAnySettingChanged,
  openAiApiKeySetting,
  timeFormatSetting,
  wakeWordActionSetting,
} from "../dashboard-settings";
import { onAmbientCardsChanged } from "./ambient-cards";
import { ShellChromeLayer, sidebarContentLeft, type ShellChromeState, type ShellChromeWindow } from "./chrome-layer";
import { ShellModalLayer } from "./modal-layer";
import { ToolDebugMenuLayer } from "./tool-debug-layer";
import { toolRegistry } from "../../assistant/tool-registry";
import {
  minWindowTop,
  sidebarWidth,
  TOP_BAR_HEIGHT,
  windowBandHeight,
  windowTop,
  type WindowHeightMode,
} from "./geometry";

/**
 * The shell: owns the window registry, focus, screen on/off, and the shell
 * surface (sidebar + top bar + shell overlays such as the escape menu and
 * the voice dialog). Runs on the main thread; windows are hosted in-process
 * or in per-app worker threads.
 *
 * Input flow: every event enters via receiveInput. The shell consumes
 * everything while the sidebar or a shell overlay has focus and forwards the
 * rest to the focused window. Long-press goes to the foreground window (from
 * the sidebar it focuses the window first); by convention apps answer it with
 * a window menu that ends in Voice input / Close window. Holding the press
 * past the escape threshold opens the shell's own escape menu, so the shell
 * keeps working when a window's handler hangs.
 */

export type ShellWindow = {
  appId: string;
  windowId: string;
  title: string;
  /** Compositor surface this window renders to; configured at connect / launch. */
  surfaceId: string;
  /** Whether close menu entries (app menu default, shell escape menu) apply (the launcher is pinned). */
  closeable: boolean;
  /**
   * True when the window gives swipe-left / swipe-right (watch directional
   * input) a meaning; otherwise the shell forwards directionalFallback(event).
   */
  acceptsDirectional?: boolean;
  /**
   * Window height: the standard 288px band ("min") or the full screen
   * ("max", terminal views). Decides the surface rect and where the shell
   * draws this window's top bar.
   */
  heightMode: WindowHeightMode;
  /** App-side cleanup when the shell closes the window (worker notification, surface removal). */
  close?: () => void;
  drawIcon: ShellChromeWindow["drawIcon"];
  /**
   * Handle an input event the shell forwarded. Ownership of frameId (latency
   * tracking) passes to the window: it must eventually reach a frame submit
   * or a finishFrame call.
   */
  handleInput: (event: InputEvent, frameId: number) => Promise<void> | void;
  /** Repaint and resubmit this window's surface. */
  requestRender: () => void;
  /**
   * Re-measure against the current display mode (viewport size / band) and
   * repaint. Windows without it (workers, whose canvas is fixed at open) are
   * closed and relaunched by the controller instead.
   */
  relayout?: () => void;
  /**
   * A touch from the phone's mirror at (x, y) in app-viewport coordinates.
   * True if the window acted on it; otherwise the controller sends a select.
   */
  hitTest?: (x: number, y: number) => Promise<boolean> | boolean;
  /**
   * Deliver a text string to the window (e.g. finalized voice input). Optional:
   * only windows that consume typed text (the terminal) implement it.
   */
  receiveTextInput?: (text: string) => void;
  /** Foreground state changed: this window's surface is (not) the visible one. */
  setForeground?: (foreground: boolean) => void;
  /**
   * Input focus moved into this window. `lastInput` is the most recent input
   * event the shell received — for a focus that a click or swipe caused, the
   * event that caused it. A programmatic focus (a worker's focus-window
   * request, a wake path) can deliver an older event: check timestampMs
   * before treating it as current.
   */
  onFocus?: (lastInput: InputEvent | null) => void;
  /** Screen turned on/off; hidden or screen-off windows should stop painting. */
  setScreenOn?: (on: boolean) => void;
};

export type ShellConfig = {
  /** Actions handed to shell overlay layers; requestRender must re-render the shell surface. */
  actions: LayerActions;
  getScreenTimeoutMs: () => number | null;
  requestShellRender: () => void;
  /**
   * Asked before the voice dialog opens; resolving false swallows the open.
   * Preview-only mode uses it to turn the tap into a mic-permission prompt
   * when RECORD_AUDIO isn't granted yet (the phone mic is the source there).
   */
  prepareVoiceCapture?: () => Promise<boolean>;
  /** Screen on/off changed: the controller blanks/unblanks the compositor. */
  onScreenStateChanged: (on: boolean) => void;
  /** Window registered/removed or foreground changed (persists the open-app list). */
  onWindowsChanged?: () => void;
};

/** Which surfaces need re-rendering after an input event. */
export type ShellInputOutcome = { shell: boolean; window: boolean };

/**
 * Assistant overlay activity, for mirrors outside the glasses (the watch).
 * "streaming" carries the reply so far (replace semantics); "done" the final
 * reply; "error" the message; "closed" fires when the overlay leaves the
 * stack by any path.
 */
export type AssistantActivityEvent = {
  phase: "thinking" | "streaming" | "done" | "error" | "closed";
  text: string;
};

export type FocusKind = "sidebar" | "window";

const noopActions: LayerActions = noopLayerActions;

/**
 * Hold a long-press this much past the long-press event (which the firmware
 * itself only fires after a shorter hold) and the shell opens its own escape
 * menu — the recovery path when an app ignores or mishandles the gesture.
 */
const LONG_PRESS_ESCAPE_MENU_MS = 4000;

/** Shell-surface overlay menu (the escape menu); closing it returns focus to the sidebar. */
class ShellOverlayMenuLayer extends MenuLayer {
  constructor(items: MenuItem[], private readonly onClosed: () => void) {
    // Aligned to the min-height window band (like the sidebar), wherever the
    // vertical position setting currently puts it; past the sidebar strip
    // where one reserves width (none in the full-panel mode).
    super(null, items, {
      x: sidebarWidth() + 8,
      y: minWindowTop() + TOP_BAR_HEIGHT + 8,
      width: 272,
      minHeight: 0,
    });
  }

  onRemoved(): void {
    this.onClosed();
  }
}

/** How long a show_alert popup stays before auto-dismissing. */
const ALERT_DISMISS_MS = 6000;
const ALERT_X = 40;
const ALERT_W = G2_LENS_WIDTH - 80;
const ALERT_Y = 96;
const ALERT_H = 96;

/**
 * A brief text popup on the shell surface (the assistant's show_alert tool and
 * other short notices). Auto-dismisses after a few seconds; a click or
 * double-click dismisses it early.
 */
class ShellAlertLayer implements Layer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly text: string, private readonly onDismiss: () => void) {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onDismiss();
    }, ALERT_DISMISS_MS);
  }

  paint(_ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    const image = paintBelow();
    const font = getDefaultSmallFont();
    // Positioned within the min-height window band, like the other shell overlays.
    const alertY = minWindowTop() + ALERT_Y;
    image.fillRoundedRect(ALERT_X, alertY, ALERT_W, ALERT_H, 1, 10);
    image.drawRoundedRect(ALERT_X, alertY, ALERT_W, ALERT_H, 90, 10);
    image.drawText(font, ALERT_X + 16, alertY + 12, "Assistant", 200);
    image.drawTextWrapped({
      font,
      x: ALERT_X + 16,
      y: alertY + 18 + font.lineHeight + 4,
      width: ALERT_W - 32,
      text: this.text,
      value: 235,
    });
    return image;
  }

  handleInput(event: InputEvent, _ctx: LayerContext): void {
    if (event.type === "click" || event.type === "double-click") {
      this.clearTimer();
      this.onDismiss();
    }
  }

  onRemoved(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

class Shell {
  private windows: ShellWindow[] = [];
  private selectedIndex = 0;
  /** Window ids in most-recently-visible-first order; closing the visible window returns to the next entry. */
  private mruWindowIds: string[] = [];
  private focus: FocusKind = "sidebar";
  private screenOn = true;
  private lastInputAtMs = Date.now();
  /** The most recent input event received, for windows gaining focus (see ShellWindow.onFocus). */
  private lastInput: InputEvent | null = null;
  private battery: ShellChromeState["battery"] = { headset: null, headsetCharging: null };
  private attention = new Map<string, boolean>();
  // App-provided top-bar tray icons, keyed by owner id; drawn between the
  // notification icons and the battery indicators.
  private readonly trayIcons = new Map<string, GrayImage>();
  private activeVoiceLayer: VoiceInputLayer | null = null;
  private assistantSession: AssistantSession | null = null;
  private assistantLayer: AssistantLayer | null = null;
  private readonly assistantActivityListeners = new Set<(event: AssistantActivityEvent) => void>();
  private readonly alertListeners = new Set<(text: string) => void>();
  private escapeMenuTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly actions: LayerActions = { ...noopActions };
  private config: ShellConfig = {
    actions: noopActions,
    getScreenTimeoutMs: () => null,
    requestShellRender: () => {},
    onScreenStateChanged: () => {},
  };
  private readonly chrome = new ShellChromeLayer(() => this.chromeState());
  private readonly stack = new LayerStack(this.chrome, this.actions);

  // Top-bar settings we mirror into the chrome; a change to either repaints
  // the shell surface so the top bar reflects it immediately.
  private topBarSettingsSubscribed = false;
  private lastBatteryDisplayMode: string | null = null;
  private lastTimeFormat: string | null = null;

  configure(config: ShellConfig): void {
    this.config = config;
    this.stack.setActions(config.actions);
    this.subscribeToTopBarSettings();
    this.subscribeToAmbientCards();
  }

  // Ambient (encounter) cards live in the chrome paint; a posted or expired
  // card repaints the shell surface so it appears and disappears on time.
  private ambientCardsSubscribed = false;

  private subscribeToAmbientCards(): void {
    if (this.ambientCardsSubscribed) return;
    this.ambientCardsSubscribed = true;
    onAmbientCardsChanged(() => {
      if (this.screenOn) {
        this.config.requestShellRender();
      }
    });
  }

  private subscribeToTopBarSettings(): void {
    if (this.topBarSettingsSubscribed) return;
    this.topBarSettingsSubscribed = true;
    this.lastBatteryDisplayMode = batteryDisplayModeSetting.get();
    this.lastTimeFormat = timeFormatSetting.get();
    onAnySettingChanged(() => {
      const batteryMode = batteryDisplayModeSetting.get();
      const timeFormat = timeFormatSetting.get();
      if (batteryMode === this.lastBatteryDisplayMode && timeFormat === this.lastTimeFormat) {
        return;
      }
      this.lastBatteryDisplayMode = batteryMode;
      this.lastTimeFormat = timeFormat;
      this.config.requestShellRender();
    });
  }

  /** Add a window (or replace one with the same windowId, keeping its slot). */
  registerWindow(window: ShellWindow): void {
    const existing = this.windows.findIndex((w) => w.windowId === window.windowId);
    if (existing >= 0) {
      this.windows[existing] = window;
      if (existing === this.selectedIndex) this.noteWindowVisible(window.windowId);
    } else {
      this.windows.push(window);
      if (this.windows.length - 1 === this.selectedIndex) this.noteWindowVisible(window.windowId);
    }
    this.config.onWindowsChanged?.();
  }

  /** Move a window to the front of the most-recently-visible order. */
  private noteWindowVisible(windowId: string): void {
    this.mruWindowIds = this.mruWindowIds.filter((id) => id !== windowId);
    this.mruWindowIds.unshift(windowId);
  }

  /** Index of the most recently visible window still in the registry, or -1. */
  private mostRecentWindowIndex(): number {
    for (const id of this.mruWindowIds) {
      const index = this.windows.findIndex((w) => w.windowId === id);
      if (index >= 0) return index;
    }
    return -1;
  }

  removeWindow(windowId: string): void {
    const index = this.windows.findIndex((w) => w.windowId === windowId);
    if (index < 0) return;
    const wasSelected = index === this.selectedIndex;
    this.windows.splice(index, 1);
    this.attention.delete(windowId);
    this.mruWindowIds = this.mruWindowIds.filter((id) => id !== windowId);
    if (wasSelected) {
      // Return to the most recently visible remaining window.
      const mruIndex = this.mostRecentWindowIndex();
      this.selectedIndex =
        mruIndex >= 0 ? mruIndex : Math.min(index, Math.max(0, this.windows.length - 1));
    } else if (this.selectedIndex > index) {
      this.selectedIndex--;
    }
    if (this.focus === "window" && (wasSelected || !this.windows.length)) {
      this.focus = "sidebar";
    }
    if (wasSelected) {
      // Hand the foreground to whatever is now selected.
      const next = this.windows[this.selectedIndex];
      if (next) {
        this.noteWindowVisible(next.windowId);
        next.setForeground?.(true);
        next.requestRender();
      }
    }
    this.config.onWindowsChanged?.();
    this.config.requestShellRender();
  }

  /** Close a window by id, if it is closeable (menu actions route here). */
  closeWindow(windowId: string): void {
    const window = this.windows.find((w) => w.windowId === windowId);
    if (!window || !window.closeable) return;
    try {
      window.close?.();
    } catch (error) {
      console.warn(`window ${window.windowId} close failed`, error);
    }
    this.removeWindow(window.windowId);
  }

  /** Close the foreground window via the shell (escape menu action). */
  closeForegroundWindow(): void {
    const window = this.foregroundWindow();
    if (window) this.closeWindow(window.windowId);
  }

  getWindows(): readonly ShellWindow[] {
    return this.windows;
  }

  setWindowAttention(windowId: string, attention: boolean): void {
    if (Boolean(this.attention.get(windowId)) === attention) return;
    this.attention.set(windowId, attention);
    this.config.requestShellRender();
  }

  setBatteryLevels(levels: Partial<ShellChromeState["battery"]>): void {
    this.battery = { ...this.battery, ...levels };
  }

  /**
   * Set or clear an app's top-bar tray icon (a small grayscale image, drawn
   * between the notification icons and the battery indicators). Small and
   * infrequently updated by design; not a framebuffer.
   */
  setTrayIcon(ownerId: string, icon: GrayImage | null): void {
    if (icon) {
      this.trayIcons.set(ownerId, icon);
    } else if (!this.trayIcons.delete(ownerId)) {
      return;
    }
    this.config.requestShellRender();
  }

  isScreenOn(): boolean {
    return this.screenOn;
  }

  /** Current headset battery levels (for the assistant's get_state tool). */
  getBatteryLevels(): ShellChromeState["battery"] {
    return this.battery;
  }

  /**
   * The foreground app, or null when only the launcher is showing. The launcher
   * is a pinned window but counts as "no app" for the assistant's context.
   */
  getForegroundApp(): { appId: string; title: string } | null {
    const window = this.foregroundWindow();
    if (!window || window.appId === "launcher") return null;
    return { appId: window.appId, title: window.title };
  }

  noteUserActivity(nowMs = Date.now()): void {
    this.lastInputAtMs = nowMs;
  }

  /** Where input currently goes: the sidebar strip or the foreground window. */
  getFocus(): FocusKind {
    return this.focus;
  }

  /** True while a shell overlay (menu, dialog, voice input) is above the chrome. */
  hasOverlay(): boolean {
    return !this.stack.isAtBase();
  }

  /** The window whose sidebar icon is at screen (x, y), for mirror touches. */
  windowAtSidebarPoint(x: number, y: number): ShellWindow | null {
    const index = this.chrome.windowIndexAt(x, y, this.windows.length);
    return index === null ? null : this.windows[index] ?? null;
  }

  /** Whether input focus currently targets this window (regardless of screen state). */
  private isFocusTarget(window: ShellWindow | undefined): boolean {
    return !!window && this.focus === "window" && this.foregroundWindow() === window;
  }

  /** Turn the screen on (if off) and set focus. Returns whether it was off. */
  wake(focus: FocusKind, nowMs = Date.now()): boolean {
    this.lastInputAtMs = nowMs;
    const gaining = focus === "window" ? this.foregroundWindow() : undefined;
    const alreadyFocused = this.isFocusTarget(gaining);
    this.focus = focus;
    if (gaining && !alreadyFocused) gaining.onFocus?.(this.lastInput);
    if (this.screenOn) return false;
    this.screenOn = true;
    this.config.onScreenStateChanged(true);
    for (const window of this.windows) {
      window.setScreenOn?.(true);
    }
    // Refresh the foreground window; the compositor restored its retained
    // frame, but its content may be stale (e.g. a running stopwatch).
    this.foregroundWindow()?.requestRender();
    return true;
  }

  /** Turn the screen off, closing any shell overlays. Sidebar selection is kept. */
  sleep(): void {
    if (!this.screenOn) return;
    this.cancelEscapeMenuTimer();
    this.screenOn = false;
    this.stack.clearToBase();
    for (const window of this.windows) {
      window.setScreenOn?.(false);
    }
    this.config.onScreenStateChanged(false);
  }

  /** Foreground and focus a window by id (e.g. a wake path opening content in it). */
  focusWindow(windowId: string): void {
    const index = this.windows.findIndex((w) => w.windowId === windowId);
    if (index < 0) return;
    const target = this.windows[index];
    const alreadyFocused = this.isFocusTarget(target);
    this.setSelectedIndex(index);
    this.focus = "window";
    if (!alreadyFocused) target?.onFocus?.(this.lastInput);
  }

  /** Idle timeout: sleep if the configured timeout elapsed. Returns whether it slept. */
  applyScreenTimeout(nowMs = Date.now()): boolean {
    const timeoutMs = this.config.getScreenTimeoutMs();
    if (timeoutMs === null || !this.screenOn) return false;
    // An open voice dialog suspends the timeout: a long dictation or refine
    // has no button presses, but the screen must stay on for it. Sliding
    // lastInputAtMs forward also restarts the full timeout when it closes.
    // An in-flight assistant turn suspends it for the same reason (a tool loop
    // can run for a while with no input); once the turn ends and the
    // Follow-up/Done menu is showing, the normal idle timeout resumes.
    if (this.activeVoiceLayer || this.assistantSession?.isTurnActive()) {
      this.lastInputAtMs = nowMs;
      return false;
    }
    if (nowMs - this.lastInputAtMs < timeoutMs) return false;
    this.sleep();
    return true;
  }

  /**
   * Show a new notification in a shell modal over the app viewport. If the
   * notification woke the screen, closing the modal goes back to sleep
   * (matching the old sleep-popup behavior).
   */
  openNotificationModal(notificationKey: string, wokeScreen: boolean): void {
    if (!this.screenOn) return;
    const modal: ShellModalLayer = new ShellModalLayer(
      new SingleNotificationLayer(notificationKey, {
        origin: "new-notification-modal",
        closeModal: () => this.closeNotificationModal(modal, wokeScreen),
      }),
      this.config.actions,
    );
    this.stack.push(modal);
    this.config.requestShellRender();
  }

  private closeNotificationModal(modal: ShellModalLayer, wokeScreen: boolean): void {
    this.stack.popIfTop((layer) => layer === modal);
    if (wokeScreen) {
      this.sleep();
    }
    this.config.requestShellRender();
  }

  /** Called by a window when the user backs out of its root (double-tap). */
  yieldFocusToSidebar(): void {
    if (this.focus === "sidebar") return;
    this.focus = "sidebar";
    // Repaint the window so its selection highlight dims to the unfocused
    // style this frame.
    this.foregroundWindow()?.requestRender();
    this.config.requestShellRender();
  }

  /** Paint the shell surface: transparent chrome, or all-transparent when asleep. */
  paintSurface(): Plane[] {
    if (!this.screenOn) {
      return singlePlane(new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0));
    }
    return this.stack.paint();
  }

  async receiveInput(event: InputEvent, frameId = 0): Promise<ShellInputOutcome> {
    const previous = this.lastInput;
    this.lastInput = event;
    // A visible window may paint a source-dependent indicator (see
    // lastInputEvent); when the source class flips (watch <-> ring/arms),
    // repaint it so the indicator follows the device now in use.
    if (this.screenOn && previous && isWatchInput(previous) !== isWatchInput(event)) {
      this.foregroundWindow()?.requestRender();
    }
    // The stock lifecycle has already interpreted the physical double tap as
    // "wake". Keep that directionality if delivery is delayed or duplicated.
    if (event.type === "display-wake") {
      this.lastInputAtMs = Date.now();
      const wokeScreen = !this.screenOn && this.wake("sidebar");
      return { shell: wokeScreen, window: false };
    }

    // The wakeword is handled before the screen-off short-circuit so its
    // configured action can work from a dark screen. With the CFW the stock
    // Even AI app never launches, so the firmware does not power the display
    // for us either -- actions that need it wake the screen themselves.
    if (event.type === "wakeword") {
      const action = wakeWordActionSetting.get();
      if (action === "off") {
        return { shell: false, window: false };
      }

      this.lastInputAtMs = Date.now();
      const wokeScreen = !this.screenOn && this.wake("sidebar");
      if (action === "voice-input" && !this.activeVoiceLayer) {
        if (this.assistantLayer) {
          // The assistant overlay is up; a wakeword continues that conversation.
          this.startAssistantFollowUp(true);
        } else {
          // Wakeword defaults the highlight to Send to Assistant.
          this.openVoiceDialog({ handsFree: true, defaultTarget: "assistant" });
        }
      }
      return { shell: wokeScreen || action === "voice-input", window: false };
    }

    this.lastInputAtMs = Date.now();

    // Anything but the long-press itself means the press ended (or the event
    // stream moved on), so the escape countdown stops.
    if (event.type !== "long-press") {
      this.cancelEscapeMenuTimer();
    }

    if (!this.screenOn) {
      if (event.type === "double-click") {
        this.wake("sidebar");
        return { shell: true, window: false };
      }
      return { shell: false, window: false };
    }

    // Long-press goes to the foreground window (from the sidebar it focuses
    // the window first); apps conventionally answer it with their window
    // menu. The escape timer runs regardless of what the app does with it:
    // holding the press long enough opens the shell's own menu.
    if (event.type === "long-press") {
      this.startEscapeMenuTimer();
      if (this.activeVoiceLayer || !this.stack.isAtBase()) {
        return { shell: true, window: false };
      }
      const window = this.foregroundWindow();
      if (!window) {
        return { shell: true, window: false };
      }
      if (this.focus === "sidebar") {
        this.focus = "window";
        window.onFocus?.(this.lastInput);
      }
      // The window owns frameId from here (render or explicit finish).
      await window.handleInput(event, frameId);
      return { shell: true, window: true };
    }
    if (event.type === "long-press-release") {
      this.activeVoiceLayer?.endCapture();
      if (this.activeVoiceLayer || !this.stack.isAtBase() || this.focus !== "window") {
        return { shell: true, window: false };
      }
      const window = this.foregroundWindow();
      if (!window) {
        return { shell: true, window: false };
      }
      await window.handleInput(event, frameId);
      return { shell: false, window: true };
    }

    if (!this.stack.isAtBase()) {
      await this.stack.handleInput(event);
      return { shell: true, window: false };
    }

    if (this.focus === "sidebar") {
      return this.handleSidebarInput(event);
    }

    const window = this.foregroundWindow();
    if (window) {
      // The window owns frameId from here (render or explicit finish).
      const delivered = isDirectionalInput(event) && !window.acceptsDirectional ? directionalFallback(event) : event;
      await window.handleInput(delivered, frameId);
      return { shell: false, window: true };
    }
    return { shell: false, window: false };
  }

  foregroundWindow(): ShellWindow | undefined {
    return this.windows[this.selectedIndex] ?? this.windows[0];
  }

  /**
   * Screen rect actually occupied by content, for cropping screenshots: the
   * foreground window's band (full screen for a max-height window, the
   * vertical-position-dependent 288px band otherwise), minus the sidebar
   * strip left of the icon columns when the one-column variant is active.
   */
  screenshotCropRect(): { x: number; y: number; width: number; height: number } {
    const heightMode = this.foregroundWindow()?.heightMode ?? "min";
    const x = sidebarContentLeft(this.windows.length);
    return {
      x,
      y: windowTop(heightMode),
      width: G2_LENS_WIDTH - x,
      height: windowBandHeight(heightMode),
    };
  }

  /**
   * Compact description of where input is currently going, for the frame
   * timing export: "which app was drawing" is usually the first thing you need
   * to interpret an input-to-display latency, and it is not recoverable from
   * the input event itself.
   */
  describeInputTarget(): string {
    const foreground = this.foregroundWindow()?.windowId ?? "none";
    if (!this.screenOn) return `fg=${foreground} target=screen-off`;
    if (this.activeVoiceLayer) return `fg=${foreground} target=voice`;
    if (!this.stack.isAtBase()) return `fg=${foreground} target=shell-overlay`;
    return `fg=${foreground} target=${this.focus}`;
  }

  /**
   * The most recent input event received, from any source. Windows whose
   * appearance depends on the input device in use (e.g. the launcher's
   * defocused selection preview) can read it at paint time; the shell
   * repaints the foreground window whenever the source class changes, so
   * such paints stay current even while the window is not focused.
   */
  lastInputEvent(): InputEvent | null {
    return this.lastInput;
  }

  /** Whether the most recent input came from the watch (see lastInputEvent). */
  lastInputWasWatch(): boolean {
    return this.lastInput !== null && isWatchInput(this.lastInput);
  }

  /** Whether a window is the current input target (foreground + focus in-window). */
  isWindowFocused(windowId: string): boolean {
    return this.screenOn && this.focus === "window" && this.foregroundWindow()?.windowId === windowId;
  }

  /**
   * Whether a window's content is on screen: it's the foreground window and the
   * screen is on. Focus-independent — the app viewport stays visible while the
   * sidebar is focused (the sidebar is just the left strip).
   */
  isWindowVisible(windowId: string): boolean {
    return this.screenOn && this.foregroundWindow()?.windowId === windowId;
  }

  private handleSidebarInput(event: InputEvent): ShellInputOutcome {
    switch (event.type) {
      case "double-click":
        // A double-tap at the root (the app switcher selected) turns the
        // display off — from the ring and the watch scheme alike; watch-scheme
        // gestures wake it again (or a ring double-tap does).
        this.sleep();
        return { shell: true, window: false };
      case "scroll-up":
      case "swipe-up":
        this.moveSelection(-1);
        return { shell: true, window: false };
      case "scroll-down":
      case "swipe-down":
        this.moveSelection(1);
        return { shell: true, window: false };
      case "click":
      case "swipe-right":
        // Right: into the selected window (spatially, the window is to the
        // sidebar's right). Left has nowhere further to go and is ignored.
        if (this.windows.length) {
          this.focus = "window";
          this.foregroundWindow()?.onFocus?.(this.lastInput);
          // Repaint the window now so its selection highlight reflects focus
          // this frame, not one frame late.
          this.foregroundWindow()?.requestRender();
        }
        return { shell: true, window: false };
      default:
        return { shell: false, window: false };
    }
  }

  private moveSelection(delta: number): void {
    if (!this.windows.length) return;
    const count = this.windows.length;
    this.setSelectedIndex((this.selectedIndex + delta + count) % count);
  }

  /** Change selection; the selected window is the foreground window. */
  private setSelectedIndex(index: number): void {
    if (index === this.selectedIndex) return;
    const previous = this.windows[this.selectedIndex];
    this.selectedIndex = index;
    const next = this.windows[index];
    if (next) this.noteWindowVisible(next.windowId);
    previous?.setForeground?.(false);
    next?.setForeground?.(true);
    next?.requestRender();
    this.config.onWindowsChanged?.();
  }

  // True while a voice-dialog open waits on prepareVoiceCapture (e.g. the
  // preview-mode permission prompt); a second tap must not queue another open.
  private voiceDialogPending = false;

  private openVoiceDialog(options: {
    finishOnClick?: boolean;
    handsFree?: boolean;
    defaultTarget: "assistant" | "app";
  }): void {
    if (this.voiceDialogPending) return;
    this.voiceDialogPending = true;
    void (async () => {
      let ready = true;
      try {
        ready = (await this.config.prepareVoiceCapture?.()) ?? true;
      } catch {
        ready = false;
      } finally {
        this.voiceDialogPending = false;
      }
      // Re-checked after the await: another path may have opened a dialog
      // (or torn down the base state) while a permission prompt was up.
      if (!ready || this.activeVoiceLayer) return;
      this.openVoiceDialogNow(options);
      this.config.requestShellRender();
    })();
  }

  private openVoiceDialogNow(options: {
    finishOnClick?: boolean;
    handsFree?: boolean;
    defaultTarget: "assistant" | "app";
  }): void {
    const targets = this.buildVoiceSendTargets();
    let defaultIndex = targets.findIndex((target) => target.id === options.defaultTarget);
    if (defaultIndex < 0) defaultIndex = 0;
    // Skip the menu only for a hands-free (wakeword) capture aimed at the
    // assistant, when the user has opted into it.
    const autoSend =
      Boolean(options.handsFree) &&
      options.defaultTarget === "assistant" &&
      targets[defaultIndex]?.id === "assistant" &&
      assistantSkipConfirmationSetting.get();

    const layer = new VoiceInputLayer({
      actions: this.config.actions,
      onClosed: () => {
        if (this.activeVoiceLayer === layer) {
          this.activeVoiceLayer = null;
          voiceActivity.setActive(false);
          // The idle countdown restarts in full once voice input ends.
          this.noteUserActivity();
        }
      },
      dismiss: () => {
        this.stack.popIfTop((top) => top === layer);
      },
      sendTargets: targets,
      defaultTargetIndex: defaultIndex,
      finishOnClick: options.finishOnClick ?? false,
      handsFree: options.handsFree ?? false,
      autoSend,
    });
    this.activeVoiceLayer = layer;
    voiceActivity.setActive(true);
    this.stack.push(layer);
    layer.startCapture();
  }

  /**
   * The send destinations offered by the voice dialog: the assistant (when an
   * API key is configured) and/or typing into the foreground window (when it
   * accepts text). Order fixes the menu row order.
   */
  private buildVoiceSendTargets(): VoiceSendTarget[] {
    const targets: VoiceSendTarget[] = [];
    if (this.isAssistantAvailable()) {
      targets.push({
        id: "assistant",
        label: "Send to Assistant",
        onSend: (text) => this.sendToAssistant(text),
      });
    }
    if (this.foregroundWindow()?.receiveTextInput) {
      targets.push({
        id: "app",
        label: "Type Into App",
        onSend: (text) => this.sendTextToForegroundWindow(text),
      });
    }
    // Guarantee at least one destination so the dialog is never a dead end.
    if (targets.length === 0) {
      targets.push({
        id: "app",
        label: "Type Into App",
        onSend: (text) => this.sendTextToForegroundWindow(text),
      });
    }
    return targets;
  }

  /** Deliver a text string to the foreground window (e.g. finalized voice input). */
  sendTextToForegroundWindow(text: string): void {
    this.foregroundWindow()?.receiveTextInput?.(text);
  }

  /**
   * Open the voice dialog aimed at the foreground window. Called when the
   * user picks Voice input from a window's menu (in-process directly, worker
   * apps via a start-voice-input message). The menu click already ended the
   * press, so the dialog finishes on click instead of long-press-release.
   */
  startVoiceInput(): void {
    if (!this.screenOn || this.activeVoiceLayer || !this.stack.isAtBase()) return;
    // The transcript is aimed at the window whose menu requested it; the menu
    // entry point defaults the highlight to Type Into App.
    this.focus = "window";
    this.openVoiceDialog({ finishOnClick: true, defaultTarget: "app" });
    this.config.requestShellRender();
  }

  isAssistantAvailable(): boolean {
    return this.resolveAssistantConfiguration() !== null;
  }

  /** Observe assistant turns (see AssistantActivityEvent). */
  onAssistantActivity(listener: (event: AssistantActivityEvent) => void): () => void {
    this.assistantActivityListeners.add(listener);
    return () => {
      this.assistantActivityListeners.delete(listener);
    };
  }

  /** Observe showAlert popups (mirrored to the watch). */
  onAlertShown(listener: (text: string) => void): () => void {
    this.alertListeners.add(listener);
    return () => {
      this.alertListeners.delete(listener);
    };
  }

  private emitAssistantActivity(event: AssistantActivityEvent): void {
    for (const listener of Array.from(this.assistantActivityListeners)) {
      try {
        listener(event);
      } catch (error) {
        console.warn("assistant activity listener failed", error);
      }
    }
  }

  /**
   * Dismiss the assistant overlay (cancelling any in-flight turn), as Done
   * would. Returns whether an overlay was actually open to close.
   */
  closeAssistant(): boolean {
    return this.closeAssistantLayer();
  }

  private ensureAssistantSession(): AssistantSession | null {
    const config = this.resolveAssistantConfiguration();
    if (!config) return null;
    if (
      !this.assistantSession ||
      this.assistantSession.isExpired() ||
      !this.assistantSession.matchesConfiguration(config)
    ) {
      this.assistantSession?.cancel();
      this.assistantSession = new AssistantSession(config);
    }
    return this.assistantSession;
  }

  private resolveAssistantConfiguration(): AssistantBackendConfig | null {
    if (assistantBackendSetting.get() === "external") {
      const host = assistantBridgeHostSetting.get().trim();
      const token = assistantBridgeTokenSetting.get();
      if (!host || !token) return null;
      const port = parseInt(assistantBridgePortSetting.get(), 10) || 8790;
      return { kind: "external", bridge: { host, port, token } };
    }
    const llm = resolveAssistantModel(assistantModelSetting.get(), {
      anthropic: anthropicApiKeySetting.get(),
      openai: openAiApiKeySetting.get(),
    });
    return llm ? { kind: "direct", llm } : null;
  }

  private buildAssistantContext(): AssistantContext {
    const foreground = this.getForegroundApp();
    return {
      foregroundApp: foreground?.appId ?? null,
      foregroundTitle: foreground?.title ?? null,
      screenOn: this.screenOn,
      localTime: formatAssistantTime(new Date()),
      headsetBattery: this.battery.headset,
    };
  }

  /**
   * Start (or continue) an assistant conversation from a finalized utterance.
   * Opens the assistant overlay if it isn't already up; a follow-up reuses the
   * existing session and overlay.
   */
  sendToAssistant(text: string): void {
    const session = this.ensureAssistantSession();
    if (!session) {
      this.showAlert(
        assistantBackendSetting.get() === "external"
          ? "Configure the agent bridge host and token in Settings."
          : "Set an API key or download the on-phone model in Settings.",
      );
      return;
    }
    if (!this.screenOn) this.wake("sidebar");
    let layer = this.assistantLayer;
    if (!layer) {
      const created = new AssistantLayer(this.config.actions, {
        onFollowUp: () => this.startAssistantFollowUp(),
        onCancel: () => this.assistantSession?.cancel(),
        onClose: () => this.closeAssistantLayer(),
        onRemoved: () => {
          // Removed by any path (Done, or the screen sleeping mid-conversation):
          // stop the turn and drop the reference so a later query starts clean.
          this.assistantSession?.cancel();
          if (this.assistantLayer === created) this.assistantLayer = null;
          this.emitAssistantActivity({ phase: "closed", text: "" });
        },
      });
      layer = created;
      this.assistantLayer = created;
      this.stack.push(created);
    }
    this.runAssistantTurn(session, layer, text);
    this.config.requestShellRender();
  }

  private runAssistantTurn(session: AssistantSession, layer: AssistantLayer, text: string): void {
    layer.startTurn();
    let replySoFar = "";
    this.emitAssistantActivity({ phase: "thinking", text: "" });
    session.sendUtterance(text, this.buildAssistantContext(), {
      onTextDelta: (delta, textSoFar) => {
        replySoFar = textSoFar;
        layer.onTextDelta(delta, textSoFar);
        this.emitAssistantActivity({ phase: "streaming", text: textSoFar });
      },
      onToolActivity: (label) => layer.onToolActivity(label),
      onTurnDone: () => {
        layer.onTurnDone();
        this.emitAssistantActivity({ phase: "done", text: replySoFar });
      },
      onError: (message) => {
        layer.onError(message);
        this.emitAssistantActivity({ phase: "error", text: message });
      },
    });
  }

  /**
   * Record another utterance in the current assistant conversation. handsFree
   * (from a wakeword over the overlay) starts the mic immediately; otherwise
   * (the Follow-up menu button) a click ends the utterance.
   */
  private startAssistantFollowUp(handsFree = false): void {
    const layer = this.assistantLayer;
    const session = this.assistantSession;
    if (!layer || !session || this.activeVoiceLayer) return;
    const voice = new VoiceInputLayer({
      actions: this.config.actions,
      onClosed: () => {
        if (this.activeVoiceLayer === voice) {
          this.activeVoiceLayer = null;
          voiceActivity.setActive(false);
          this.noteUserActivity();
        }
      },
      dismiss: () => {
        this.stack.popIfTop((top) => top === voice);
      },
      sendTargets: [
        { id: "assistant", label: "Send", onSend: (text) => this.runAssistantTurn(session, layer, text) },
      ],
      finishOnClick: !handsFree,
      handsFree,
      autoSend: handsFree && assistantSkipConfirmationSetting.get(),
    });
    this.activeVoiceLayer = voice;
    voiceActivity.setActive(true);
    this.stack.push(voice);
    voice.startCapture();
    this.config.requestShellRender();
  }

  private closeAssistantLayer(): boolean {
    // Popping fires the layer's onRemoved, which cancels the turn and clears
    // this.assistantLayer. popThrough also closes anything stacked above the
    // overlay (a follow-up voice dialog, an alert), so a close command works
    // no matter what the conversation is showing.
    const layer = this.assistantLayer;
    const closed = layer ? this.stack.popThrough(layer) : false;
    this.noteUserActivity();
    this.config.requestShellRender();
    return closed;
  }

  /** Show a brief text popup on the lenses (assistant show_alert / notices). */
  showAlert(text: string): void {
    if (!this.screenOn) this.wake("sidebar");
    for (const listener of Array.from(this.alertListeners)) {
      try {
        listener(text);
      } catch (error) {
        console.warn("alert listener failed", error);
      }
    }
    const layer = new ShellAlertLayer(text, () => {
      this.stack.popIfTop((top) => top === layer);
      this.config.requestShellRender();
    });
    this.stack.push(layer);
    this.config.requestShellRender();
  }

  private startEscapeMenuTimer(): void {
    this.cancelEscapeMenuTimer();
    this.escapeMenuTimer = setTimeout(() => {
      this.escapeMenuTimer = null;
      this.openEscapeMenu();
    }, LONG_PRESS_ESCAPE_MENU_MS);
  }

  private cancelEscapeMenuTimer(): void {
    if (this.escapeMenuTimer !== null) {
      clearTimeout(this.escapeMenuTimer);
      this.escapeMenuTimer = null;
    }
  }

  /**
   * The held-long-press safeguard menu. Shell-owned and shell-drawn (never
   * the app's), so an unresponsive app can always be closed. It opens over
   * whatever the app did with the long-press, including its own menu.
   */
  private openEscapeMenu(): void {
    if (!this.screenOn || this.activeVoiceLayer || !this.stack.isAtBase()) return;
    const foreground = this.foregroundWindow();
    if (!foreground) return;
    const items: MenuItem[] = [];
    if (foreground.closeable) {
      items.push({
        label: "Close window",
        onSelect: (ctx) => {
          // Pop the menu first (its onRemoved returns focus to the sidebar),
          // then close the window the menu was opened over.
          ctx.stack.pop();
          this.closeForegroundWindow();
        },
      });
    }
    items.push({
      label: "Debug",
      onSelect: (ctx) => {
        ctx.stack.pop();
        this.openToolDebugDialog();
      },
    });
    this.stack.push(new ShellOverlayMenuLayer(items, () => this.yieldFocusToSidebar()));
    this.config.requestShellRender();
  }

  /**
   * Escape menu > Debug: list the assistant tools registered for the
   * foreground window's app (live or gated). System-wide "always" tools are
   * constant and omitted.
   */
  private openToolDebugDialog(): void {
    const foreground = this.foregroundWindow();
    const appId = foreground?.appId ?? null;
    const entries = appId
      ? toolRegistry
          .listToolsForDebug()
          .filter(
            (entry) =>
              entry.spec.name.startsWith(`app.${appId}.`) || entry.windowId === foreground!.windowId,
          )
      : [];
    this.stack.push(new ToolDebugMenuLayer(appId, entries, () => this.yieldFocusToSidebar()));
    this.config.requestShellRender();
  }

  private chromeState(): ShellChromeState {
    return {
      windows: this.windows.map((window) => ({
        windowId: window.windowId,
        title: window.title,
        attention: Boolean(this.attention.get(window.windowId)),
        drawIcon: window.drawIcon,
      })),
      selectedIndex: this.selectedIndex,
      focus: this.focus,
      foregroundHeightMode: this.foregroundWindow()?.heightMode ?? "min",
      battery: this.battery,
      trayIcons: Array.from(this.trayIcons.keys())
        .sort()
        .map((key) => this.trayIcons.get(key)!),
    };
  }
}

export const shell = new Shell();

const ASSISTANT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ASSISTANT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Human-readable local time for the assistant's per-turn context. */
function formatAssistantTime(date: Date): string {
  let hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const meridiem = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const day = `${ASSISTANT_WEEKDAYS[date.getDay()]} ${ASSISTANT_MONTHS[date.getMonth()]} ${date.getDate()}`;
  return `${day}, ${hours}:${minutes} ${meridiem}`;
}

export function rawInputEventToInputEvent(event: RawInputEvent): InputEvent {
  return makeInputEvent(rawInputEventToPayload(event));
}

function rawInputEventToPayload(event: RawInputEvent): InputEventPayload {
  if (event.kind === "sys-event") {
    if (event.eventType === OsEventTypeList.CLICK_EVENT) {
      return {
        type: "click",
        source: eventSourceToString(event.eventSource),
      };
    } else if (event.eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      return {
        type: "double-click",
        source: eventSourceToString(event.eventSource),
      };
    } else if (event.eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      return scrollEvent("scroll-down", event.eventSource);
    } else if (event.eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
      return scrollEvent("scroll-up", event.eventSource);
    } else if (event.eventType === OsEventTypeList.RING_LONG_PRESS_EVENT) {
      // CFW-forwarded long-press (replaces the firmware's force-quit dialog).
      // Current CFW supplies the physical source for ring and temple presses;
      // eventSourceToString's ring fallback keeps older CFW builds compatible.
      return { type: "long-press", source: eventSourceToString(event.eventSource) };
    } else if (event.eventType === OsEventTypeList.RING_LONG_PRESS_RELEASE_EVENT) {
      return { type: "long-press-release", source: eventSourceToString(event.eventSource) };
    }
  } else if (event.kind === "watch-gesture") {
    // Synthetic, from the Wear OS remote (app/g2/wear-remote.ts); the glasses
    // firmware never produces these.
    if (event.eventType === WatchGestureType.SWIPE_LEFT) {
      return { type: "swipe-left", source: "watch" };
    } else if (event.eventType === WatchGestureType.SWIPE_RIGHT) {
      return { type: "swipe-right", source: "watch" };
    } else if (event.eventType === WatchGestureType.SWIPE_UP) {
      return { type: "swipe-up", source: "watch" };
    } else if (event.eventType === WatchGestureType.SWIPE_DOWN) {
      return { type: "swipe-down", source: "watch" };
    }
  } else if (event.kind === "even-ai") {
    // sid 0x07 EvenAIDataPackage; eventType carries eEvenAIStatus. Only the
    // wakeword interests us -- ENTER means the user manually opened the stock
    // assistant, and EXIT is it tearing down.
    if (event.eventType === EvenAIStatus.EVEN_AI_WAKE_UP) {
      return { type: "wakeword" };
    }
  } else if (event.kind === "display-wake") {
    // Outside an EvenHub page the firmware consumes the physical double tap
    // itself and reports only that the stock display lifecycle woke.
    return { type: "display-wake" };
  } else if (event.kind === "text-click") {
    if (event.eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      return scrollEvent("scroll-down", event.eventSource);
    } else if (event.eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
      return scrollEvent("scroll-up", event.eventSource);
    }
  }
  return {
    type: "unknown",
    kind: event.kind,
    eventSource: event.eventSource,
    eventType: event.eventType,
  };
}

/** Scroll events only carry a source when it is the watch (the stock ones never needed one). */
function scrollEvent(type: "scroll-up" | "scroll-down", eventSource: number): InputEventPayload {
  return eventSource === EventSourceType.TOUCH_EVENT_FROM_WATCH ? { type, source: "watch" } : { type };
}

function eventSourceToString(eventSource: number): InputSource {
  if (eventSource === EventSourceType.TOUCH_EVENT_FROM_RING) {
    return "ring";
  } else if (eventSource === EventSourceType.TOUCH_EVENT_FROM_GLASSES_L) {
    return "left-arm";
  } else if (eventSource === EventSourceType.TOUCH_EVENT_FROM_GLASSES_R) {
    return "right-arm";
  } else if (eventSource === EventSourceType.TOUCH_EVENT_FROM_WATCH) {
    return "watch";
  }
  return "ring";
}

export function inputEventToString(event: InputEvent): string {
  switch (event.type) {
    case "click":
      return `Click from ${event.source}`;
    case "double-click":
      return `Double click from ${event.source}`;
    case "scroll-up":
      return `Scroll up`;
    case "scroll-down":
      return `Scroll down`;
    case "long-press":
      return `Long press from ${event.source}`;
    case "long-press-release":
      return `Long press release from ${event.source}`;
    case "swipe-left":
      return `Swipe left from ${event.source}`;
    case "swipe-right":
      return `Swipe right from ${event.source}`;
    case "swipe-up":
      return `Swipe up from ${event.source}`;
    case "swipe-down":
      return `Swipe down from ${event.source}`;
    case "display-wake":
      return `Display wake`;
    case "wakeword":
      return `Wakeword`;
    default:
    case "unknown":
      return `Unknown event: ${event.kind} ${event.eventSource} ${event.eventType}`;
  }
}
