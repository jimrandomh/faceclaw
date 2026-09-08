import { ExtensionPlatform, type ExtensionHooks } from "./extension-platform";
import { boundedToken } from "./extension-policy";
import { Application, Utils } from "@nativescript/core";
import { shell, type ShellWindow } from "../../ui/shell/shell";
import { windowIcon } from "../../ui/shell/chrome-layer";
import { appViewportSize, type WindowHeightMode } from "../../ui/shell/geometry";
import { publishExternalNotificationPosted } from "../../native/notification-icons";
import { acceptExternalNotificationReplyResult, clearExternalNotifications, configureExternalNotifications, configureExternalNotificationReplies, putExternalNotification, removeExternalNotification, setSuppressedNotificationPackages } from "../../native/external-notifications";
import { refineHostDictation } from "../../native/anthropic";
import { anthropicApiKeySetting } from "../../ui/dashboard-settings";
import * as frameTimings from "../../native/frame-timings";

declare const com: any;
export type InstalledApk = { component: string; name: string; connected: boolean };
export const externalAppId = (component: string): string => `apk:${component}`;
function manager(): any { return global.isAndroid ? com.faceclaw.app.FaceclawExternalApps.get(Utils.android.getApplicationContext()) : null; }
export function installedExternalApps(): InstalledApk[] { try { return JSON.parse(String(manager()?.installedJson() ?? "[]")); } catch { return []; } }
export function showExternalAppSettings(): void { manager()?.showManager(Application.android.foregroundActivity ?? Application.android.startActivity); }
export type InstalledAndroidApp = { packageName: string; name: string };
export function installedAndroidApps(): InstalledAndroidApp[] { try { return JSON.parse(String(manager()?.androidAppsJson() ?? "[]")); } catch { return []; } }
export function openAndroidAppSettings(packageName: string): boolean { return Boolean(manager()?.openAndroidAppSettings(Application.android.foregroundActivity ?? Application.android.startActivity, packageName)); }
export function prioritizeExtension(feature: string, component: string): boolean { return Boolean(manager()?.prioritizeExtension(feature, component)); }


type Raster = { width: number; height: number; pixels: Uint8Array };
type WindowState = { window: ShellWindow; ready: boolean; serial: number; visible: boolean; frame: Raster | null; rendering: boolean; target: string; lastInput: number; cancelReview?: () => void; reviewId?: string; reviewPurpose?: "message" | "search" | "capture"; protected?: boolean; menuAvailable?: boolean; finishCapture?: () => void; completedCapture?: { text: string; at: number }; refinement?: { id: string; cancel: () => void } };
export type ExternalPlatformOptions = {
  extensions?: ExtensionHooks;
  configureSurface: (id: string, visible: boolean, mode: WindowHeightMode) => Promise<void>;
  setSurfaceVisible: (id: string, visible: boolean) => void;
  removeSurface: (id: string) => void;
  submitRaster: (id: string, pixels: Uint8Array, width: number, height: number, serial: number) => Promise<void>;
  requestRender: () => void;
  isLocked: () => boolean;
};
/** Shell adapter contains no Signal account, bridge credential, or foreign code. */
export class ExternalAppPlatform {
  private readonly native = manager();
  private readonly windows = new Map<string, WindowState>();
  private readonly listener: any;
  readonly extensions: ExtensionPlatform;
  constructor(private readonly options: ExternalPlatformOptions) {
    this.extensions = new ExtensionPlatform(this.native, options.extensions ?? {}, options.isLocked, () => {
      const id = shell.foregroundWindow()?.windowId;
      return [...this.windows.values()].some(state => state.window.windowId === id && (state.protected || !!state.reviewId));
    });
    configureExternalNotifications((component, target) => { void this.open(component, target); }, publishExternalNotificationPosted);
    configureExternalNotificationReplies(
      component => !this.options.isLocked() && shell.isScreenOn() && this.granted(component, "notifications") && this.granted(component, "dictation"),
      (component, data) => Boolean(this.native?.replyToNotification(component, JSON.stringify(data))),
    );
    this.listener = global.isAndroid ? new com.faceclaw.app.FaceclawExternalAppListener({
      onEvent: (component: string, type: string, json: string) => this.onEvent(String(component), String(type), JSON.parse(String(json))),
      onExtensionFrame: (component: string, feature: string, generation: number, width: number, height: number, pixels: any) => {
        this.extensions.onFrame(String(component), String(feature), Number(generation), width, height, new Uint8Array((ArrayBuffer as any).from(pixels)));
      },
      onFrame: (component: string, width: number, height: number, pixels: any) => {
        const state = this.windows.get(String(component));
        if (!state?.ready || !state.visible || this.options.isLocked()) return;
        // Native owns an immutable private byte snapshot, never app shared memory.
        state.frame = { width, height, pixels: new Uint8Array((ArrayBuffer as any).from(pixels)) };
        void this.render(String(component), state);
      },
    }) : null;
    this.native?.setListener(this.listener);
    // Expiry must retract popups even when the bridge is unreachable.
    setInterval(() => {
      publishExternalNotificationPosted("");
      for (const [component, window] of this.windows) if (window.ready && window.visible && !this.options.isLocked() && shell.isScreenOn()) this.extensions.publishOwnNotifications(component);
      for (const app of installedExternalApps()) if (app.connected) this.send(app.component, "host-state", this.extensions.ownHostState(app.component));
    }, 1000);
  }
  private send(component: string, type: string, data: unknown = {}): void { this.native?.send(component, type, JSON.stringify(data)); }
  private granted(component: string, capability: string): boolean { return Boolean(this.native?.allows(component, capability)); }
  private heightMode(component: string): WindowHeightMode {
    const layout = this.extensions.feature("ui.window-layout");
    return layout?.component === component && ["min", "medium", "max"].includes(String(layout.configuration.ownHeightMode)) ? layout.configuration.ownHeightMode as WindowHeightMode : "min";
  }
  async open(component: string, target = ""): Promise<void> {
    const app = installedExternalApps().find((item) => item.component === component);
    if (!app?.connected) { showExternalAppSettings(); return; }
    const previous = this.windows.get(component);
    if (previous) {
      this.cancelOwnedWork(previous); previous.target = target;
      this.send(component, "open", { ...appViewportSize(previous.window.heightMode ?? "min"), target });
      shell.focusWindow(previous.window.windowId); this.options.requestRender(); return;
    }
    const id = externalAppId(component), surfaceId = `window:${id}`, heightMode = this.heightMode(component);
    const state: WindowState = { window: null!, ready: false, serial: 0, visible: false, frame: null, rendering: false, target, lastInput: 0 };
    const window: ShellWindow = {
      appId: id, windowId: id, title: app.name, surfaceId, closeable: true, heightMode, drawIcon: windowIcon("package", app.name.slice(0, 1)),
      close: () => { state.ready = false; state.frame = null; this.cancelOwnedWork(state); this.send(component, "close"); this.windows.delete(component); this.options.removeSurface(surfaceId); },
      hasAppMenu: () => state.menuAvailable === true,
      handleInput: (event, frameId) => {
        if (state.visible) this.extensions.windowInput(component, event);
        if (event.type === "short-then-long-press") {
          if (!state.menuAvailable) { shell.openSystemMenu(id); return; }
          state.lastInput = Date.now(); this.send(component, "app-menu"); frameTimings.finishFrame(frameId, "external app menu dispatched"); return;
        }
        if (event.type === "system-menu-opened") return;
        state.lastInput = Date.now(); this.send(component, "input", event); frameTimings.finishFrame(frameId, "external app input dispatched");
      },
      requestRender: () => this.send(component, "render"),
      relayout: () => { window.heightMode = this.heightMode(component); state.ready = false; this.cancelOwnedWork(state); state.frame = null; void this.options.configureSurface(surfaceId, state.visible, window.heightMode ?? "min").then(() => { if (this.windows.get(component) !== state) return; state.ready = true; this.send(component, "resize", appViewportSize(window.heightMode ?? "min")); }); },
      setForeground: (visible) => { state.visible = visible; if (!visible) { state.frame = null; this.cancelOwnedWork(state); } this.options.setSurfaceVisible(surfaceId, visible); this.send(component, "visibility", { visible, screenOn: shell.isScreenOn() && !this.options.isLocked() }); },
      setScreenOn: (on) => { if (!on) { state.frame = null; this.cancelOwnedWork(state); } this.send(component, "visibility", { visible: state.visible, screenOn: on && !this.options.isLocked() }); },
    };
    state.window = window; this.windows.set(component, state); shell.registerWindow(window);
    await this.options.configureSurface(surfaceId, false, heightMode);
    if (this.windows.get(component) !== state) return;
    state.ready = true; this.send(component, "open", { ...appViewportSize(heightMode), target }); shell.focusWindow(id); this.options.requestRender();
  }
  lockChanged(): void {
    this.extensions.lockChanged();
    for (const [component, state] of this.windows) {
      this.cancelOwnedWork(state); state.frame = null;
      this.send(component, "visibility", { visible: state.visible, screenOn: shell.isScreenOn() && !this.options.isLocked() });
    }
  }
  private async render(component: string, state: WindowState): Promise<void> {
    if (state.rendering) return;
    state.rendering = true;
    try {
      while (state.frame && state.ready && state.visible && this.windows.get(component) === state) {
        const frame = state.frame; state.frame = null;
        await this.options.submitRaster(state.window.surfaceId!, frame.pixels, frame.width, frame.height, ++state.serial);
      }
    } finally { state.rendering = false; }
  }
  private onEvent(component: string, type: string, data: any): void {
    if (this.extensions.onNativeEvent(component, type, data)) {
      if (type === "extensions-changed") for (const [owner, state] of this.windows) if (state.window.heightMode !== this.heightMode(owner)) state.window.relayout?.();
      return;
    }
    const state = this.windows.get(component);
    if (type === "disconnected") { if (state) this.cancelOwnedWork(state); if (state) shell.closeWindow(state.window.windowId); clearExternalNotifications(component); }
    if (["connected", "disconnected", "changed", "grants-changed"].includes(type)) {
      if (type === "grants-changed") { if (state) this.cancelOwnedWork(state); clearExternalNotifications(component); }
      setSuppressedNotificationPackages(JSON.parse(String(this.native.suppressedPackagesJson())));
      this.options.requestRender(); publishExternalNotificationPosted(""); return;
    }
    if (type === "own-notifications" || type === "own-notification-action") {
      if (!state?.ready || !state.visible || this.options.isLocked() || !shell.isScreenOn() || !this.native.isExtensionGranted(component, "notification-content")) return;
      if (type === "own-notifications") { this.extensions.publishOwnNotifications(component); return; }
      if (!boundedToken(data.callId) || Date.now() - state.lastInput > 5000 || state.reviewId || state.refinement || !shell.canShowExtensionOverlay()) return;
      state.lastInput = 0;
      const result = this.extensions.actOnOwnNotification(component, data);
      this.send(component, "own-notification-action-result", { callId: data.callId, ...result }); return;
    }
    if (type === "request-open-window") {
      if (this.options.isLocked() || !shell.isScreenOn() || !shell.canShowExtensionOverlay() || typeof data.target !== "string" || data.target.length > 512 || [...this.windows.values()].some(item => item.visible && (item.protected || item.reviewId || item.refinement))) return;
      if (state) this.cancelOwnedWork(state);
      void this.open(component, data.target); return;
    }
    if (type === "window-menu-state") { if (state && typeof data.available === "boolean") state.menuAvailable = data.available; return; }
    if (type === "window-protection") { if (state && typeof data.protected === "boolean") state.protected = data.protected; return; }
    if (type === "request-system-menu") {
      if (!state?.ready || !state.visible || shell.foregroundWindow()?.windowId !== state.window.windowId || this.options.isLocked() || !shell.isScreenOn() || state.protected || state.reviewId || state.cancelReview || state.refinement || !shell.canShowExtensionOverlay()) return;
      const elapsed = Date.now() - state.lastInput;
      if (state.lastInput <= 0 || elapsed < 0 || elapsed > 5000) return;
      state.lastInput = 0;
      shell.openSystemMenu(state.window.windowId); return;
    }
    if (type === "sleep") { if (state?.visible && shell.isScreenOn() && !this.options.isLocked() && Date.now() - state.lastInput <= 5000) { state.lastInput = 0; shell.sleepAtAppRoot(); } return; }
    if (type === "host-refinement") { this.startHostRefinement(component, data, state); return; }
    if (type === "cancel-host-refinement") { if (state?.refinement?.id === data.requestId) state.refinement.cancel(); return; }
    if (type === "capture-dictation") { this.startCapture(component, data, state); return; }
    if (type === "finish-capture-dictation") { if (state?.reviewPurpose === "capture" && state.reviewId === data.requestId) state.finishCapture?.(); return; }
    if (type === "cancel-capture-dictation") { if (state?.reviewPurpose === "capture" && state.reviewId === data.requestId) state.cancelReview?.(); return; }
    if (type === "notification-reply-result") { acceptExternalNotificationReplyResult(component, data); return; }
    if (type === "notification") {
      const app = installedExternalApps().find((item) => item.component === component);
      if (!app || !this.granted(component, "notifications")) return;
      const key = putExternalNotification(component, app.name, data, this.granted(component, "previews"));
      if (key) publishExternalNotificationPosted(key); return;
    }
    if (type === "remove-notification") { if (typeof data.id === "string") removeExternalNotification(component, data.id); return; }
    if (type === "cancel-search-dictation") { if (state?.reviewPurpose === "search" && data.requestId === state.reviewId) state.cancelReview?.(); return; }
    if (type === "search-dictation") { this.startSearch(component, data, state); return; }
    if (type === "cancel-dictation") { if (state?.reviewPurpose === "message" && data.requestId === state.reviewId) state.cancelReview?.(); return; }
    if (type !== "dictation") return;
    const reject = (reason: string) => this.send(component, "dictation-rejected", { requestId: String(data.requestId ?? "").slice(0, 128), reason });
    if (!state?.ready || !state.visible || this.options.isLocked() || !this.granted(component, "dictation")) { reject("App review unavailable"); return; }
    if (typeof data.requestId !== "string" || data.requestId.length > 128 || typeof data.target !== "string" || data.target.length > 512 || typeof data.label !== "string" || data.label.length > 100 || typeof (data.initialText ?? "") !== "string" || (data.initialText?.length ?? 0) > 8000) { reject("Invalid review request"); return; }
    // A recent real window gesture is required; background apps cannot turn on the mic.
    if (Date.now() - state.lastInput > 5000 || state.cancelReview) { reject("Review requires a fresh user gesture"); return; }
    state.lastInput = 0; state.reviewId = data.requestId; state.reviewPurpose = "message";
    const expires = Date.now() + 5 * 60000, requestId = data.requestId, target = data.target;
    let sent = false;
    state.cancelReview = shell.startExternalAppReview(state.window.windowId, data.label, String(data.initialText ?? ""), (text) => {
      if (sent || Date.now() > expires || !this.granted(component, "dictation") || this.windows.get(component) !== state || this.options.isLocked()) return;
      sent = true; this.send(component, "dictation-result", { requestId, target, text, confirmed: true });
    }, () => { if (state.reviewId === requestId && state.reviewPurpose === "message") { state.cancelReview = undefined; state.reviewId = undefined; state.reviewPurpose = undefined; } });
  }
  private cancelOwnedWork(state: WindowState): void {
    for (const [component, current] of this.windows) if (current === state) this.extensions.clearOwnNotifications(component);
    state.completedCapture = undefined; state.lastInput = 0;
    state.cancelReview?.(); state.refinement?.cancel();
  }
  private startHostRefinement(component: string, data: any, state: WindowState | undefined): void {
    const requestId = typeof data.requestId === "string" ? data.requestId.slice(0, 128) : "";
    const reject = (reason: string) => this.send(component, "host-refinement-rejected", { requestId, reason });
    if (!state?.ready || !state.visible || this.options.isLocked() || !shell.isScreenOn() || !this.granted(component, "dictation") || state.cancelReview || state.refinement || !boundedToken(data.requestId) || typeof data.original !== "string" || data.original.length > 8000 || typeof data.followup !== "string" || !data.followup.trim() || data.followup.length > 8000) { reject("refinement-unavailable"); return; }
    const captured = state.completedCapture;
    const captureAuthorized = captured && Date.now() - captured.at <= 30000 && captured.text === data.followup;
    if (Date.now() - state.lastInput > 5000 && !captureAuthorized) { reject("fresh-user-action-required"); return; }
    // Consume authorization before backend dispatch, including unavailable-key failures.
    state.lastInput = 0; state.completedCapture = undefined;
    const apiKey = anthropicApiKeySetting.get();
    if (!apiKey.trim()) { reject("host-refinement-unavailable"); return; }
    let handle: { cancel: () => void } | undefined, timer: ReturnType<typeof setTimeout> | undefined, finished = false;
    const available = () => this.windows.get(component) === state && state.ready && state.visible && !this.options.isLocked() && shell.isScreenOn() && this.granted(component, "dictation") && state.refinement?.id === requestId;
    const finish = (text?: string) => {
      if (finished) return;
      const allowed = available(); finished = true; if (timer) clearTimeout(timer);
      if (state.refinement?.id === requestId) state.refinement = undefined;
      if (allowed && typeof text === "string" && text.trim() && text.length <= 8000) this.send(component, "host-refinement-result", { requestId, text });
      else reject("refinement-cancelled-or-unavailable");
    };
    const cancel = () => { finish(); handle?.cancel(); };
    state.refinement = { id: requestId, cancel };
    timer = setTimeout(cancel, 120000);
    try { handle = refineHostDictation({ apiKey, original: data.original, followup: data.followup, onDone: text => finish(text), onError: () => finish() }); }
    catch { finish(); }
  }
  private startCapture(component: string, data: any, state: WindowState | undefined): void {
    const requestId = typeof data.requestId === "string" ? data.requestId.slice(0, 128) : "";
    const reject = (reason: string) => this.send(component, "capture-dictation-closed", { requestId, reason });
    if (!state?.ready || !state.visible || this.options.isLocked() || !shell.isScreenOn() || !this.granted(component, "dictation") || !boundedToken(data.requestId) || (data.ownTranscription !== undefined && typeof data.ownTranscription !== "boolean") || typeof data.label !== "string" || data.label.length > 100 || Date.now() - state.lastInput > 5000 || state.cancelReview || state.refinement) { reject("capture-unavailable"); return; }
    if (data.ownTranscription === true && !this.native.isExtensionGranted(component, "transcription")) { reject("transcription-permission-required"); return; }
    state.completedCapture = undefined;
    state.lastInput = 0; state.reviewId = requestId; state.reviewPurpose = "capture";
    let finalText: string | undefined;
    const available = () => this.windows.get(component) === state && state.ready && state.visible && !this.options.isLocked() && shell.isScreenOn() && this.granted(component, "dictation") && state.reviewId === requestId && (data.ownTranscription !== true || this.native.isExtensionGranted(component, "transcription"));
    const capture = shell.startExternalAppCapture(state.window.windowId,
      event => { if (available()) { if (event.isFinal && typeof event.text === "string" && event.text.length <= 8000) finalText = event.text; this.send(component, "capture-dictation-transcript", { requestId, ...event, purpose: "capture" }); } },
      status => { if (available()) this.send(component, "capture-dictation-status", { requestId, status }); },
      reason => {
        if (reason === "complete" && finalText !== undefined && available()) state.completedCapture = { text: finalText, at: Date.now() };
        if (state.reviewId === requestId && state.reviewPurpose === "capture") { state.cancelReview = undefined; state.finishCapture = undefined; state.reviewId = undefined; state.reviewPurpose = undefined; }
        reject(reason);
      }, available, data.ownTranscription === true ? { component, captureId: requestId } : undefined);
    if (state.reviewId === requestId) { state.cancelReview = capture.cancel; state.finishCapture = capture.finish; }
  }
  private startSearch(component: string, data: any, state: WindowState | undefined): void {
    const reject = (reason: string) => this.send(component, "search-dictation-rejected", { requestId: String(data.requestId ?? "").slice(0, 128), reason });
    if (!state?.ready || !state.visible || this.options.isLocked() || !shell.isScreenOn() || !this.granted(component, "dictation")) { reject("Voice search unavailable"); return; }
    if (typeof data.requestId !== "string" || !data.requestId || data.requestId.length > 128 || typeof data.target !== "string" || !data.target || data.target.length > 512 || typeof data.label !== "string" || data.label.length > 100) { reject("Invalid search request"); return; }
    const gestureExpires = state.lastInput + 5000;
    if (Date.now() > gestureExpires || state.cancelReview) { reject("Search requires a fresh user gesture"); return; }
    const requestId = data.requestId, target = data.target, expires = Date.now() + 5 * 60000;
    state.lastInput = 0; state.reviewId = requestId; state.reviewPurpose = "search";
    let completed = false, closed = false;
    const available = () => this.windows.get(component) === state && state.ready && state.visible && !this.options.isLocked() && shell.isScreenOn() && this.granted(component, "dictation") && state.reviewId === requestId && state.reviewPurpose === "search";
    state.cancelReview = shell.startExternalAppSearch(state.window.windowId, data.label, query => {
      if (completed || closed || Date.now() > expires || !available() || typeof query !== "string" || !query.trim() || query.length > 256) return;
      completed = true;
      this.send(component, "search-dictation-result", { requestId, target, text: query, confirmed: true });
    }, () => {
      if (closed) return;
      closed = true;
      if (state.reviewId === requestId && state.reviewPurpose === "search") {
        state.cancelReview = undefined; state.reviewId = undefined; state.reviewPurpose = undefined;
        if (!completed) reject("Search cancelled or unavailable");
      }
    }, () => Date.now() <= gestureExpires && available());
  }

}
