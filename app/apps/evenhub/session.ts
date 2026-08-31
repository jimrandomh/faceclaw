/**
 * One running EvenHub app: the host side of the SDK's
 * flutter_inappwebview.callHandler('evenAppMessage', ...) contract, the page
 * container state, and the glue between the phone WebView and the glasses
 * window. Wire shapes were captured empirically from even_hub_sdk 0.0.12
 * (see notes/evenhub_compatibility.txt).
 *
 * Wire contract summary:
 *  - Web -> host: callHandler('evenAppMessage', '<json>') where the JSON is
 *    {type: "call_even_app_method", method, data?}. The handler's return
 *    value resolves the app-side promise (no response postMessage).
 *  - Host -> web: call window._listenEvenAppMessage({type:
 *    "listen_even_app_data", method, data}); for method "evenHubEvent", data
 *    is {type: "sysEvent"|"textEvent"|"listEvent", jsonData: {...}}.
 *  - Return values: createStartUpPageContainer -> int 0..3;
 *    updateImageRawData -> int 0..3 or enum string; rebuild/textUpgrade/
 *    shutDown/setLocalStorage -> boolean; getLocalStorage -> string;
 *    getUserInfo/getGlassesInfo -> plain JSON objects (not strings).
 */
import { ApplicationSettings } from "@nativescript/core";
import { GrayImage } from "../../graphics/image";
import { EvenHubFont } from "../../graphics/evenhub-font";
import { type InputEvent, type InputSource } from "../../ui/gestures";
import { type Layer } from "../../ui/layers";
import {
  anthropicApiKeySetting,
  elevenLabsApiKeySetting,
  mapboxApiKeySetting,
  openAiApiKeySetting,
  sonioxApiKeySetting,
} from "../../ui/dashboard-settings";
import {
  buildSoundSequencePayload,
  phraseDurationMs,
  CFW_SEQ_MAX,
  type Step,
} from "../../ui/sound-effects";
import { EvenHubApiKeyDialogLayer } from "./api-key-dialog";
import {
  asRecord,
  eventCaptureContainer,
  parsePage,
  readNumber,
  readOptionalNumber,
  readString,
  type EvenHubImageContainer,
  type EvenHubListContainer,
  type EvenHubContainer,
  type EvenHubPage,
} from "./containers";
import { compositePage } from "./compositor";
import { type EvenHubManifest } from "./ehpk";
import { permissionsIncludeMicrophone, permissionsInclude } from "./permissions";
import { evenHubMicRouter, type EvenHubMicClient } from "./mic-router";
import { evenHubImuRouter, type EvenHubImuClient } from "./imu-router";
import { evenHubCompassRouter, type EvenHubCompassClient } from "./compass-router";
import { type ImuReading } from "../../native/imu";
import { toolRegistry, type ToolResult, type ToolSpec } from "../../assistant/tool-registry";
import { getCurrentLocation } from "../../native/location";
import { LocationTracker, type TrackedLocation } from "../../native/location-tracker";
import { ensureFineLocationPermission } from "../../g2/android-permissions";

const UPNG = require("upng-js");

declare const com: any;

/** OsEventTypeList values (PB ordinals). */
const CLICK_EVENT = 0;
const SCROLL_TOP_EVENT = 1;
const SCROLL_BOTTOM_EVENT = 2;
const DOUBLE_CLICK_EVENT = 3;
const FOREGROUND_ENTER_EVENT = 4;
const FOREGROUND_EXIT_EVENT = 5;
const SYSTEM_EXIT_EVENT = 7;
const IMU_DATA_REPORT_EVENT = 8;

/**
 * Injected into every served HTML document at document start (before any app
 * JS): (1) the promise-returning flutter_inappwebview.callHandler the EvenHub
 * SDK expects, backed by the FaceclawEvenHubJsBridge Java object; and (2) a
 * host-driven setTimeout/setInterval/requestAnimationFrame replacement that
 * survives the screen-off throttle (fired by the native ticker in
 * FaceclawEvenHubWebViewHost). Kept in ES5 so it runs on any webview.
 */
export const EVENHUB_BRIDGE_INJECT_SCRIPT = `
(function () {
  if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) return;
  var pending = {};
  var nextId = 1;
  window.__fcResolve = function (id, ok, value) {
    var entry = pending[id];
    if (!entry) return;
    delete pending[id];
    (ok ? entry[0] : entry[1])(value);
  };
  window.flutter_inappwebview = {
    callHandler: function (name) {
      var args = Array.prototype.slice.call(arguments, 1);
      return new Promise(function (resolve, reject) {
        var id = nextId++;
        pending[id] = [resolve, reject];
        window.__faceclawEvenHub.postMessage(String(name), JSON.stringify(args), id);
      });
    }
  };
})();
(function () {
  // Host-driven timers. Chromium heavily throttles a page's own
  // setTimeout/setInterval when the phone screen is off, which slows
  // timer-driven apps to a crawl. Replace them with a queue fired by
  // window.__fcTimerTick(), which the native host calls at ~60Hz regardless of
  // screen state (host-initiated evaluateJavascript escapes the throttle).
  if (window.__fcTimerTick) return;
  var timers = new Map();
  var nextId = 1;
  window.setTimeout = function (cb, delay) {
    var args = Array.prototype.slice.call(arguments, 2);
    var id = nextId++;
    timers.set(id, { cb: cb, args: args, due: Date.now() + (+delay || 0), interval: 0 });
    return id;
  };
  window.setInterval = function (cb, delay) {
    var args = Array.prototype.slice.call(arguments, 2);
    var id = nextId++;
    var d = +delay || 0;
    timers.set(id, { cb: cb, args: args, due: Date.now() + d, interval: d });
    return id;
  };
  window.clearTimeout = function (id) { timers.delete(id); };
  window.clearInterval = function (id) { timers.delete(id); };
  window.__fcTimerTick = function () {
    var now = Date.now();
    var dueIds = [];
    timers.forEach(function (entry, id) { if (entry.due <= now) dueIds.push(id); });
    dueIds.sort(function (a, b) { return timers.get(a).due - timers.get(b).due; });
    for (var i = 0; i < dueIds.length; i++) {
      var entry = timers.get(dueIds[i]);
      if (!entry) continue; // cleared by an earlier callback this tick
      if (entry.interval > 0) {
        // Advance one period (keeps cadence); if we've fallen behind, skip the
        // missed periods rather than fast-forwarding a burst of catch-up fires.
        entry.due += entry.interval;
        if (entry.due <= now) entry.due = now + entry.interval;
      } else {
        timers.delete(dueIds[i]);
      }
      try { entry.cb.apply(null, entry.args); } catch (e) { if (window.console) console.error(e); }
    }
  };
})();
(function () {
  // Host-driven requestAnimationFrame, same idea as the timers above: a hidden
  // page's rAF is paused/throttled with the screen off, stalling canvas apps
  // that render on a rAF loop. Drive it from window.__fcRafTick(), called by the
  // native ticker each frame. (The glasses render via BLE, not the phone's
  // display, so vsync alignment doesn't matter — a steady frame rate does.)
  if (window.__fcRafTick) return;
  var rafs = new Map();
  var nextRafId = 1;
  window.requestAnimationFrame = function (cb) {
    var id = nextRafId++;
    rafs.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = function (id) { rafs.delete(id); };
  window.__fcRafTick = function () {
    if (rafs.size === 0) return;
    var ts = window.performance && performance.now ? performance.now() : Date.now();
    // Snapshot and clear: callbacks that re-request during this frame run on
    // the NEXT frame, matching rAF semantics (so a loop doesn't spin forever).
    var current = rafs;
    rafs = new Map();
    current.forEach(function (cb) {
      try { cb(ts); } catch (e) { if (window.console) console.error(e); }
    });
  };
})();
`;

/**
 * Injected at document-start (after the stock bridge shim): defines
 * `window.getFaceclawExtensions`, the single entry point for Faceclaw-only
 * capabilities (see the faceclaw-extensions package). It never touches the
 * standard SDK or any prototype — everything lives behind this one global, so
 * apps stay compatible with the stock Even app (where the global is absent).
 *
 * RPC uses its own id-keyed promise map and `__fcExtResolve`, kept separate
 * from the stock `__fcResolve` channel. Events arrive via `__fcExtEvent`.
 * `<VERSION>` is interpolated by buildFaceclawExtensionsScript at load.
 */
export function buildFaceclawExtensionsScript(versionString: string): string {
  return `
(function () {
  if (window.getFaceclawExtensions) return;
  var VERSION = ${JSON.stringify(versionString)};
  var pending = {};
  var nextId = 1;
  window.__fcExtResolve = function (id, ok, value) {
    var entry = pending[id];
    if (!entry) return;
    delete pending[id];
    (ok ? entry[0] : entry[1])(value);
  };
  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = [resolve, reject];
      window.__faceclawEvenHub.postMessage("faceclawExt", JSON.stringify([method].concat(params || [])), id);
    });
  }
  function send(method, params) {
    // Fire-and-forget: id 0 tells the host no response is expected.
    window.__faceclawEvenHub.postMessage("faceclawExt", JSON.stringify([method].concat(params || [])), 0);
  }
  var listeners = {};
  window.__fcExtEvent = function (name, data) {
    var arr = listeners[name];
    if (!arr) return;
    for (var i = 0; i < arr.slice().length; i++) {
      try { arr[i](data); } catch (e) { if (window.console) console.error(e); }
    }
  };
  function on(name, cb) {
    (listeners[name] || (listeners[name] = [])).push(cb);
    return function () {
      var arr = listeners[name];
      if (!arr) return;
      var i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    };
  }
  // Compass: enable on first listener, disable when the last one leaves.
  var compassListeners = [];
  function addCompass(cb) {
    compassListeners.push(cb);
    if (compassListeners.length === 1) send("setCompass", [true]);
    var off = on("compass", cb);
    return function () {
      off();
      var i = compassListeners.indexOf(cb);
      if (i >= 0) compassListeners.splice(i, 1);
      if (compassListeners.length === 0) send("setCompass", [false]);
    };
  }
  // Voice-assistant tools: specs go to the host; handlers stay here and run when
  // the host invokes a tool via __fcExtInvokeTool.
  var toolHandlers = {};
  window.__fcExtInvokeTool = function (id, name, args) {
    var handler = toolHandlers[name];
    function reply(ok, value) {
      window.__faceclawEvenHub.postMessage("faceclawExtToolResult", JSON.stringify([id, ok, value]), 0);
    }
    if (!handler) { reply(false, "unknown tool " + name); return; }
    Promise.resolve().then(function () { return handler(args); }).then(
      function (res) { reply(true, res == null ? "" : res); },
      function (err) { reply(false, String((err && err.message) || err)); }
    );
  };
  function setAssistantTools(tools) {
    toolHandlers = {};
    var specs = [];
    (tools || []).forEach(function (t) {
      if (!t || !t.name || typeof t.handler !== "function") return;
      toolHandlers[t.name] = t.handler;
      specs.push({
        name: t.name,
        description: t.description || "",
        parameters: t.parameters || { type: "object", properties: {} },
        availability: t.availability === "open" ? "open" : "foreground"
      });
    });
    send("setAssistantTools", [specs]);
  }
  var extensions = {
    getVersion: function () { return VERSION; },
    returnToAppSwitcher: function () { send("returnToAppSwitcher"); },
    quit: function () { send("quit"); },
    addWindowLifecycleListener: function (cb) { return on("windowLifecycle", cb); },
    getConfiguredApiKeys: function () { return call("getConfiguredApiKeys"); },
    requestApiKeyAccess: function (services) { return call("requestApiKeyAccess", [services || []]); },
    playBuzzer: function (steps) { return call("playBuzzer", [steps || []]); },
    addCompassListener: addCompass,
    createLayout: function (layout) { return call("createLayout", [layout || {}]); },
    replaceLayout: function (layout) { return call("replaceLayout", [layout || {}]); },
    setAssistantTools: setAssistantTools
  };
  window.getFaceclawExtensions = function () { return extensions; };
})();
`;
}

/** Stock blocks a repeated createStartUpPageContainer ~2s before failing it. */
const DUPLICATE_CREATE_DELAY_MS = 2000;

export type EvenHubWebViewHandle = {
  /** Run JS inside the app's WebView (must be called on the main thread). */
  evaluateJs: (js: string) => void;
  /** Detach and destroy the WebView (the app is closing). */
  destroy: () => void;
};

export type EvenHubWindowHooks = {
  requestRender: () => void;
  closeWindow: () => void;
  /** Hand focus to the app switcher (used to decline an app's quit request). */
  focusSwitcher: () => void;
  /** Push a modal overlay layer onto the app window (e.g. a consent prompt). */
  pushOverlay: (layer: Layer) => void;
  /** Switch the window between the stock 576x288 band and the full 576x452 canvas. */
  setTallCanvas: (tall: boolean) => void;
  /** The shell window id (unique per running instance; used for tool registration). */
  windowId: string;
};

export class EvenHubSession implements EvenHubMicClient, EvenHubImuClient, EvenHubCompassClient {
  readonly manifest: EvenHubManifest;
  readonly distDir: string;
  /**
   * For a developer-loaded app served from a live web server: the absolute
   * URL to open. Empty for a packaged app, which is served offline out of
   * distDir instead (see webview.ts).
   */
  readonly remoteUrl: string;

  private page: EvenHubPage | null = null;
  private pageCreated = false;
  private webViewHandle: EvenHubWebViewHandle | null = null;
  private windowHooks: EvenHubWindowHooks | null = null;
  private closed = false;
  private launchContextPushed = false;
  private systemExitSent = false;
  /** The one-shot launch FOREGROUND_ENTER has been delivered (page exists). */
  private launchEnterSent = false;
  /** Shell focus state; true from launch (apps open focused). */
  private foreground = true;
  /** Phone screen state; the mic goes silent while the screen is off. */
  private screenOn = true;
  /** The app has enabled its microphone via audioControl(true). */
  private micRequested = false;
  /** The app has enabled the accelerometer via imuControl(true). */
  private imuRequested = false;
  /** The app has activated the compass (extension addCompassListener). */
  private compassRequested = false;
  /** Non-null while the app has an active location subscription. */
  private locationTracker: LocationTracker | null = null;
  /** The shell window id, for tool registration (falls back to packageId). */
  private shellWindowId = "";
  /** Whether this app has contributed assistant tools (for cleanup). */
  private hasAppTools = false;
  /** Pending host→app tool invocations, keyed by call id. */
  private readonly pendingToolCalls = new Map<number, (result: ToolResult) => void>();
  private nextToolCallId = 1;
  // Window-lifecycle tracking for the extension API (apps launch visible+focused).
  private lastVisible = true;
  private lastFocused = true;
  /** Shell input focus on this window, sampled during paint. */
  private shellFocused = true;
  /** API-key services the user has granted this app this session. */
  private readonly grantedApiKeys = new Set<string>();
  private log: (message: string) => void;

  constructor(
    manifest: EvenHubManifest,
    distDir: string,
    log: (message: string) => void,
    remoteUrl = "",
  ) {
    this.manifest = manifest;
    this.distDir = distDir;
    this.remoteUrl = remoteUrl;
    this.log = log;
  }

  // ----- webview wiring -----

  attachWebView(handle: EvenHubWebViewHandle): void {
    this.webViewHandle = handle;
  }

  /** The WebView finished loading the app: push the one-shot launch context. */
  webViewLoaded(): void {
    if (this.launchContextPushed) return;
    this.launchContextPushed = true;
    // Launched to drive the glasses (from the on-glasses file browser), so
    // apps that branch on this should take their glasses path.
    this.pushMessage("evenAppLaunchSource", { launchSource: "glassesMenu" });
    this.pushMessage("deviceStatusChanged", {
      sn: "FACECLAW-G2",
      connectType: "connected",
      isWearing: true,
      batteryLevel: 100,
      isCharging: false,
      isInCase: false,
    });
  }

  // ----- glasses window wiring -----

  attachWindow(hooks: EvenHubWindowHooks): void {
    this.windowHooks = hooks;
    this.shellWindowId = hooks.windowId;
  }

  windowClosed(): void {
    this.windowHooks = null;
    this.close();
  }

  paint(size: { width: number; height: number }, focused: boolean): GrayImage {
    // Focus changes always trigger a repaint of the foreground window, so paint
    // is a reliable place to sample shell input-focus for lifecycle events.
    this.updateShellFocus(focused);
    if (!this.pageCreated || !this.page) {
      const image = new GrayImage(size.width, size.height, 0);
      const font = EvenHubFont.get();
      font.drawText(image, 16, 16, `Loading ${this.manifest.name}...`, 255);
      font.drawText(image, 16, 16 + 2 * font.lineHeight, "(waiting for the app to build its page)", 120);
      return image;
    }
    return compositePage(this.page, size, focused);
  }

  /**
   * Route a gesture to the app, emulating stock hardware: clicks and
   * double-clicks arrive as sysEvent (never textEvent) with zero-valued
   * fields elided the way protobuf JSON elides them; list selection moves
   * locally with events only for clicks and boundary scrolls.
   */
  handleGesture(event: InputEvent): void {
    if (!this.page) return;
    const capture = this.page ? eventCaptureContainer(this.page) : undefined;
    switch (event.type) {
      case "click":
        if (capture?.kind === "list") {
          this.emitListEvent(capture, CLICK_EVENT);
        } else {
          this.emitSysEvent(CLICK_EVENT, gestureSource(event.source));
        }
        break;
      case "double-click":
        this.emitSysEvent(DOUBLE_CLICK_EVENT, gestureSource(event.source));
        break;
      case "scroll-up":
      case "scroll-down": {
        const eventType = event.type === "scroll-up" ? SCROLL_TOP_EVENT : SCROLL_BOTTOM_EVENT;
        if (capture?.kind === "list") {
          this.scrollList(capture, eventType);
        } else {
          this.emitSysEvent(eventType, 0);
        }
        break;
      }
      default:
        break;
    }
  }

  private scrollList(list: EvenHubListContainer, eventType: number): void {
    // Swipe up selects the previous item, swipe down the next (stock direction).
    const delta = eventType === SCROLL_TOP_EVENT ? -1 : 1;
    const next = list.selectedIndex + delta;
    if (next < 0 || next >= list.itemNames.length) {
      // At a boundary the selection stays put and the app hears about it.
      this.emitListEvent(list, eventType);
      return;
    }
    list.selectedIndex = next;
    this.windowHooks?.requestRender();
  }

  /**
   * Shell focus changes drive foreground/background. The initial ENTER is
   * deferred until the page exists (a just-launched app is focused before it
   * has built its page); createStartUpPage emits it then.
   */
  setForeground(foreground: boolean): void {
    if (this.foreground === foreground) return;
    this.foreground = foreground;
    // Foreground gates mic + IMU eligibility (only the visible app hears audio /
    // reads the accelerometer).
    if (this.micRequested) evenHubMicRouter.notifyEligibilityChanged();
    if (this.imuRequested) evenHubImuRouter.notifyEligibilityChanged();
    if (this.compassRequested) evenHubCompassRouter.notifyEligibilityChanged();
    // Foreground gates which app tools are live; re-list on change.
    if (this.hasAppTools) toolRegistry.fireToolsChanged();
    // Focus is unknown until the next paint (a re-shown window repaints and
    // re-asserts it; a hidden one won't, so treat it as unfocused meanwhile).
    this.shellFocused = false;
    this.recomputeLifecycle();
    if (!this.pageCreated) return;
    this.emitSysEvent(foreground ? FOREGROUND_ENTER_EVENT : FOREGROUND_EXIT_EVENT, 0);
  }

  /** Screen turned on/off (forwarded from the shell); mutes the mic when off. */
  setScreenOn(on: boolean): void {
    if (this.screenOn === on) return;
    this.screenOn = on;
    if (this.micRequested) evenHubMicRouter.notifyEligibilityChanged();
    // As in setForeground: let the next paint re-assert focus.
    this.shellFocused = false;
    this.recomputeLifecycle();
  }

  // ----- extension window lifecycle -----

  /** Sample shell input-focus (from paint) and emit focused/blurred on change. */
  private updateShellFocus(focused: boolean): void {
    if (this.shellFocused === focused) return;
    this.shellFocused = focused;
    this.recomputeLifecycle();
  }

  /**
   * Emit visible/hidden and focused/blurred extension events on transition.
   * visible = foreground && screen on; focused additionally needs shell input
   * focus on this window.
   */
  private recomputeLifecycle(): void {
    const visible = this.foreground && this.screenOn;
    const focused = visible && this.shellFocused;
    if (visible !== this.lastVisible) {
      this.lastVisible = visible;
      this.pushExtEvent("windowLifecycle", { type: visible ? "visible" : "hidden" });
    }
    if (focused !== this.lastFocused) {
      this.lastFocused = focused;
      this.pushExtEvent("windowLifecycle", { type: focused ? "focused" : "blurred" });
    }
  }

  // ----- microphone (EvenHubMicClient) -----

  get windowId(): string {
    return this.shellWindowId || this.manifest.packageId;
  }

  isForeground(): boolean {
    return this.foreground;
  }

  isScreenOn(): boolean {
    return this.screenOn;
  }

  /** A decoded mic frame from the router: hand it to the app as an audioEvent. */
  deliverAudioPcm(pcm: Uint8Array): void {
    const audioPcm = Array.from(pcm);
    this.pushMessage("evenHubEvent", { type: "audioEvent", jsonData: { audioPcm } });
  }

  /**
   * audioControl(enable, source?): open or close the microphone for this app.
   * Gated on a declared microphone permission (confirmed at install/first run).
   * Enabling only registers intent — the router decides when audio actually
   * flows (foreground + screen on + no assistant modal).
   */
  private audioControl(data: Record<string, unknown>): boolean {
    if (!permissionsIncludeMicrophone(this.manifest.permissions)) {
      this.log("evenhub: audioControl denied (app declares no microphone permission)");
      return false;
    }
    const enable = readEnableFlag(data);
    // The 0.0.12 payload shape isn't captured; log it once per toggle so the
    // real field names can be confirmed from hardware.
    this.log(`evenhub: audioControl enable=${enable} data=${JSON.stringify(data)}`);
    if (enable) {
      if (!this.micRequested) {
        this.micRequested = true;
        evenHubMicRouter.requestMic(this);
      }
    } else if (this.micRequested) {
      this.micRequested = false;
      evenHubMicRouter.releaseMic(this);
    }
    return true;
  }

  // ----- location -----

  private declaresLocation(): boolean {
    if (permissionsInclude(this.manifest.permissions, "location")) return true;
    this.log("evenhub: location denied (app declares no location permission)");
    return false;
  }

  /** getAppLocation(): one-shot fix, or null on denial/error (SDK contract). */
  private async getAppLocation(): Promise<AppLocation | null> {
    if (!this.declaresLocation()) return null;
    if (!(await ensureFineLocationPermission())) return null;
    try {
      const location = await getCurrentLocation();
      return {
        latitude: location.latitude,
        longitude: location.longitude,
        ...(location.accuracyMeters != null ? { accuracy: location.accuracyMeters } : {}),
        timestamp: location.timestampMs,
      };
    } catch (error) {
      this.log(`evenhub: getAppLocation failed: ${error}`);
      return null;
    }
  }

  /**
   * startAppLocationUpdates(options?): begin a location subscription. Fixes are
   * pushed to the app as `appLocationChanged`. Continues in the background (the
   * subscription ends only on stopAppLocationUpdates or app close), matching the
   * Navigate app's foreground-service-backed tracking.
   */
  private async startLocationUpdates(data: Record<string, unknown>): Promise<boolean> {
    if (!this.declaresLocation()) return false;
    if (!(await ensureFineLocationPermission())) return false;
    if (this.closed) return false;
    if (this.locationTracker) return true;
    const intervalMs = readOptionalNumber(data, "intervalMs") ?? 1000;
    const tracker = new LocationTracker({
      onLocation: (location) => {
        if (this.closed) return;
        this.pushMessage("appLocationChanged", toAppLocation(location));
      },
      onError: (message) => this.log(`evenhub: location update error: ${message}`),
    });
    this.locationTracker = tracker;
    tracker.start(Math.max(200, Math.round(intervalMs)));
    return true;
  }

  private stopLocationUpdates(): boolean {
    this.locationTracker?.stop();
    this.locationTracker = null;
    return true;
  }

  // ----- accelerometer / IMU (EvenHubImuClient) -----

  /** A shared IMU reading from the router: hand it to the app as a sysEvent. */
  deliverImu(reading: ImuReading): void {
    this.pushEvenHubEvent("sysEvent", {
      eventType: IMU_DATA_REPORT_EVENT,
      imuData: { x: reading.x, y: reading.y, z: reading.z },
    });
  }

  /**
   * imuControl(isOpen, reportFrq): enable/disable the accelerometer report
   * stream. There is no EvenHub IMU permission (nor an Android one), so no
   * consent gate. Enabling registers intent; the router only actually streams
   * to the foreground app. reportFrq is one of 100..1000 (step 100).
   */
  private imuControl(data: Record<string, unknown>): boolean {
    const enable = readEnableFlag(data);
    const freq = clampImuFreq(readOptionalNumber(data, "reportFrq") ?? readOptionalNumber(data, "reportFreq") ?? 100);
    // Payload field spelling isn't fully captured; log once per toggle.
    this.log(`evenhub: imuControl enable=${enable} freq=${freq} data=${JSON.stringify(data)}`);
    if (enable) {
      this.imuRequested = true;
      evenHubImuRouter.requestImu(this, freq);
    } else if (this.imuRequested) {
      this.imuRequested = false;
      evenHubImuRouter.releaseImu(this);
    }
    return true;
  }

  // ----- bridge calls (web -> host) -----

  /**
   * Handle one callHandler('evenAppMessage', ...) invocation. argsJson is the
   * JSON array of handler arguments; args[0] is the SDK's message JSON string
   * (kept lenient: a bare object works too).
   */
  handleBridgeCall(handlerName: string, argsJson: string, callId: number): void {
    if (handlerName === "faceclawExt") {
      this.handleExtensionCall(argsJson, callId);
      return;
    }
    if (handlerName === "faceclawExtToolResult") {
      this.handleToolResult(argsJson);
      return;
    }
    void (async () => {
      let result: unknown = null;
      try {
        if (handlerName !== "evenAppMessage") throw new Error(`unknown handler ${handlerName}`);
        const args = JSON.parse(argsJson) as unknown[];
        const first = args[0];
        const message = asRecord(typeof first === "string" ? JSON.parse(first) : first);
        const method = readString(message, "method", "");
        const data = asRecord(message.data);
        result = await this.dispatch(method, data);
      } catch (error) {
        this.log(`evenhub bridge call failed: ${error}`);
        this.resolveCall(callId, false, String(error));
        return;
      }
      this.resolveCall(callId, true, result);
    })();
  }

  private async dispatch(method: string, data: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "createStartUpPageContainer":
        return this.createStartUpPage(data);
      case "rebuildPageContainer":
        return this.rebuildPage(data);
      case "textContainerUpgrade":
        return this.textUpgrade(data);
      case "updateImageRawData":
        return this.updateImage(data);
      case "shutDownPageContainer":
        return this.shutDown(readNumber(data, "exitMode", 0));
      case "setLocalStorage":
        ApplicationSettings.setString(this.storageKey(readString(data, "key", "")), readString(data, "value", ""));
        return true;
      case "getLocalStorage":
        return ApplicationSettings.getString(this.storageKey(readString(data, "key", "")), "");
      case "getUserInfo":
        return { uid: 0, name: "Faceclaw", avatar: "", country: "" };
      case "getGlassesInfo":
        return {
          model: "g2",
          sn: "FACECLAW-G2",
          status: {
            sn: "FACECLAW-G2",
            connectType: "connected",
            isWearing: true,
            batteryLevel: 100,
            isCharging: false,
            isInCase: false,
          },
        };
      case "audioControl":
        return this.audioControl(data);
      case "getAppLocation":
        return this.getAppLocation();
      case "startAppLocationUpdates":
        return this.startLocationUpdates(data);
      case "stopAppLocationUpdates":
        return this.stopLocationUpdates();
      case "imuControl":
        return this.imuControl(data);
      // Unsupported surface (album/camera pickers): fail politely.
      case "pickImageFromAlbum":
      case "captureImageFromCamera":
        return null;
      default:
        this.log(`evenhub: unhandled method ${method}`);
        return null;
    }
  }

  /** EhStartUpPageCreateResult: 0 success, 1 invalid, 2 oversize, 3 outOfMemory. */
  private async createStartUpPage(data: Record<string, unknown>): Promise<number> {
    if (this.pageCreated) {
      // One-shot per session on stock: a second call blocks ~2s, then fails.
      await delay(DUPLICATE_CREATE_DELAY_MS);
      return 1;
    }
    const page = parsePage(data);
    this.warnOnInvalidPage(page);
    this.page = page;
    this.pageCreated = true;
    // The launch focus arrived before the page existed; deliver the ENTER now.
    if (this.foreground && !this.launchEnterSent) {
      this.launchEnterSent = true;
      this.emitSysEvent(FOREGROUND_ENTER_EVENT, 0);
    }
    this.windowHooks?.requestRender();
    return 0;
  }

  private rebuildPage(data: Record<string, unknown>): boolean {
    // Also serves as create for apps that fall back to rebuild-on-error.
    const page = parsePage(data);
    this.warnOnInvalidPage(page);
    this.page = page;
    this.pageCreated = true;
    this.windowHooks?.requestRender();
    return true;
  }

  private warnOnInvalidPage(page: EvenHubPage): void {
    // Stock rejects these outright; we accept-and-log until rejection is
    // proven necessary for compatibility.
    const captures = page.containers.filter((c) => c.kind !== "image" && c.isEventCapture).length;
    if (captures !== 1) this.log(`evenhub: page has ${captures} event-capture containers (stock requires exactly 1)`);
    const texts = page.containers.filter((c) => c.kind === "text").length;
    const images = page.containers.filter((c) => c.kind === "image").length;
    if (texts > 8 || images > 4) this.log(`evenhub: page exceeds stock limits (${texts} text, ${images} image)`);
  }

  private textUpgrade(data: Record<string, unknown>): boolean {
    const id = readNumber(data, "containerID", -1);
    // containerID is the identity; containerName is optional in the wild (e.g.
    // level-even-g2 omits it). Match by id, enforcing the name only when the app
    // actually supplies a non-empty one. (updateImage already matches by id.)
    const name = readString(data, "containerName", "");
    const container = this.page?.containers.find(
      (c) => c.kind === "text" && c.id === id && (name === "" || c.name === name),
    );
    if (!container || container.kind !== "text") return false;
    const content = readString(data, "content", "");
    const offset = readOptionalNumber(data, "contentOffset");
    // (contentLength is intentionally ignored — see below.)
    // Stock semantics are "write `content` at contentOffset and truncate the
    // rest" (a null-terminating strcpy(buf+offset, content)), NOT a splice that
    // keeps the old tail after offset+contentLength. Keeping the tail left stray
    // trailing text when an app (e.g. g2oom) shrank a string with an
    // under-sized contentLength; dropping it matches stock and still supports
    // suffix rewrites (offset>0) and full replaces (offset 0 / omitted).
    if (offset !== undefined && offset > 0) {
      container.content = container.content.slice(0, offset) + content;
    } else {
      container.content = content;
    }
    this.windowHooks?.requestRender();
    return true;
  }

  /** BleEhSendImageResult: 0 success, 1 imageException, 2 sizeInvalid, 3 sendFailed. */
  private updateImage(data: Record<string, unknown>): number {
    const id = readNumber(data, "containerID", -1);
    const container = this.page?.containers.find((c) => c.kind === "image" && c.id === id);
    if (!container || container.kind !== "image") return 3;
    const bytes = imagePayloadBytes(data.imageData ?? data.rawData ?? asRecord(data).mapRawData);
    if (!bytes || bytes.length === 0) return 1;
    const decoded = decodeImageBytes(bytes, container);
    if (!decoded) return 1;
    container.pixels = decoded.pixels;
    container.pixelsWidth = decoded.width;
    container.pixelsHeight = decoded.height;
    this.windowHooks?.requestRender();
    return 0;
  }

  private shutDown(exitMode: number): boolean {
    if (exitMode === 1) {
      // The app asked to quit (stock would pop an on-glasses confirm). We
      // decline and hand focus to the app switcher instead, leaving the app
      // running — so an app's double-tap-to-quit becomes double-tap-to-defocus.
      // No FOREGROUND_EXIT: focusing the sidebar doesn't background the app
      // (native Faceclaw apps behave the same), and refocusing the same window
      // wouldn't re-fire ENTER, which would leave a pause-on-exit app stuck.
      this.windowHooks?.focusSwitcher();
      return true;
    }
    // Immediate exit. Resolve first (the return travels via evaluateJs, and
    // close() only tears the webview down after its own delay).
    setTimeout(() => this.close(), 200);
    return true;
  }

  private storageKey(key: string): string {
    return `evenhub:${this.manifest.packageId}:ls:${key}`;
  }

  // ----- pushes (host -> web) -----

  private resolveCall(callId: number, ok: boolean, value: unknown): void {
    this.webViewHandle?.evaluateJs(
      `window.__fcResolve && window.__fcResolve(${callId}, ${ok ? "true" : "false"}, ${JSON.stringify(value ?? null)})`,
    );
  }

  private pushMessage(method: string, data: unknown): void {
    const message = { type: "listen_even_app_data", method, data };
    this.webViewHandle?.evaluateJs(
      `window._listenEvenAppMessage && window._listenEvenAppMessage(${JSON.stringify(message)})`,
    );
  }

  private resolveExtCall(callId: number, ok: boolean, value: unknown): void {
    this.webViewHandle?.evaluateJs(
      `window.__fcExtResolve && window.__fcExtResolve(${callId}, ${ok ? "true" : "false"}, ${JSON.stringify(value ?? null)})`,
    );
  }

  /** Deliver an extension event to the app (e.g. windowLifecycle). */
  private pushExtEvent(name: string, data: unknown): void {
    this.webViewHandle?.evaluateJs(
      `window.__fcExtEvent && window.__fcExtEvent(${JSON.stringify(name)}, ${JSON.stringify(data)})`,
    );
  }

  private pushEvenHubEvent(payloadType: "sysEvent" | "textEvent" | "listEvent", jsonData: Record<string, unknown>): void {
    this.pushMessage("evenHubEvent", { type: payloadType, jsonData: elideZeroFields(jsonData) });
  }

  private emitSysEvent(eventType: number, eventSource: number): void {
    this.pushEvenHubEvent("sysEvent", { eventType, eventSource });
  }

  private emitListEvent(list: EvenHubListContainer, eventType: number): void {
    this.pushEvenHubEvent("listEvent", {
      containerID: list.id,
      containerName: list.name,
      currentSelectItemIndex: list.selectedIndex,
      currentSelectItemName: list.itemNames[list.selectedIndex] ?? "",
      eventType,
    });
  }

  // ----- Faceclaw extensions (faceclawExt channel) -----

  private handleExtensionCall(argsJson: string, callId: number): void {
    void (async () => {
      let ok = true;
      let result: unknown = null;
      try {
        const args = JSON.parse(argsJson) as unknown[];
        const method = String(args[0]);
        result = await this.dispatchExtension(method, args.slice(1));
      } catch (error) {
        ok = false;
        result = String(error);
        this.log(`evenhub: extension call failed: ${error}`);
      }
      // id 0 is a fire-and-forget send; nothing is awaiting it.
      if (callId !== 0) this.resolveExtCall(callId, ok, result);
    })();
  }

  private async dispatchExtension(method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case "returnToAppSwitcher":
        this.windowHooks?.focusSwitcher();
        return null;
      case "quit":
        // A real quit — bypasses the shutDown(1) → return-to-switcher behavior.
        setTimeout(() => this.close(), 0);
        return null;
      case "getConfiguredApiKeys":
        return configuredApiKeyServices();
      case "requestApiKeyAccess":
        return this.requestApiKeyAccess(Array.isArray(params[0]) ? params[0].map(String) : []);
      case "playBuzzer":
        await this.playBuzzer(Array.isArray(params[0]) ? params[0] : []);
        return null;
      case "setCompass":
        this.setCompass(params[0] === true);
        return null;
      case "createLayout":
      case "replaceLayout":
        return this.applyExtensionLayout(asRecord(params[0]));
      case "setAssistantTools":
        this.setAssistantTools(Array.isArray(params[0]) ? params[0] : []);
        return null;
      default:
        this.log(`evenhub: unknown extension method ${method}`);
        return null;
    }
  }

  // ----- compass (EvenHubCompassClient) -----

  deliverCompass(headingDegrees: number): void {
    this.pushExtEvent("compass", { headingDegrees });
  }

  private setCompass(enable: boolean): void {
    if (enable) {
      if (!this.compassRequested) {
        this.compassRequested = true;
        evenHubCompassRouter.requestCompass(this);
      }
    } else if (this.compassRequested) {
      this.compassRequested = false;
      evenHubCompassRouter.releaseCompass(this);
    }
  }

  // ----- extended layout -----

  /**
   * Build/replace the page from an extended layout: full 576x452 canvas, no
   * container-count limit, and per-container `preserve` (inherit content from a
   * same-named container in the outgoing layout). Returns true on success.
   */
  private applyExtensionLayout(data: Record<string, unknown>): boolean {
    const previous = this.page;
    const page = parsePage(data);
    for (const container of page.containers) {
      if (container.preserve) preserveContent(container, previous);
    }
    this.page = page;
    this.pageCreated = true;
    // The extended layout uses the taller app area.
    this.windowHooks?.setTallCanvas(true);
    if (this.foreground && !this.launchEnterSent) {
      this.launchEnterSent = true;
      this.emitSysEvent(FOREGROUND_ENTER_EVENT, 0);
    }
    this.windowHooks?.requestRender();
    return true;
  }

  // ----- assistant tools -----

  private setAssistantTools(rawSpecs: unknown[]): void {
    const specs: ToolSpec[] = [];
    for (const raw of rawSpecs) {
      const record = asRecord(raw);
      const name = readString(record, "name", "");
      if (!name) continue;
      const availability = record.availability === "open" ? "open" : "foreground";
      specs.push({
        name,
        description: readString(record, "description", ""),
        inputSchema: asRecord(record.parameters),
        availability,
      });
    }
    if (specs.length === 0 && !this.hasAppTools) return;
    toolRegistry.setAppTools({
      windowId: this.windowId,
      // Prefix tools with the app's package name, per the extension contract.
      appId: this.manifest.packageId,
      specs,
      invoke: (toolName, args) => this.invokeAppTool(toolName, args),
      isForeground: () => this.foreground,
    });
    this.hasAppTools = specs.length > 0;
  }

  /** Invoke one of the app's tools by dispatching into the webview and awaiting its reply. */
  private invokeAppTool(toolName: string, args: unknown): Promise<ToolResult> {
    return new Promise((resolve) => {
      if (!this.webViewHandle || this.closed) {
        resolve({ ok: false, error: "app not available" });
        return;
      }
      const id = this.nextToolCallId++;
      this.pendingToolCalls.set(id, resolve);
      this.webViewHandle.evaluateJs(
        `window.__fcExtInvokeTool && window.__fcExtInvokeTool(${id}, ${JSON.stringify(toolName)}, ${JSON.stringify(args ?? {})})`,
      );
    });
  }

  private handleToolResult(argsJson: string): void {
    try {
      const args = JSON.parse(argsJson) as unknown[];
      const id = Number(args[0]);
      const ok = args[1] === true;
      const value = args[2];
      const resolve = this.pendingToolCalls.get(id);
      if (!resolve) return;
      this.pendingToolCalls.delete(id);
      if (ok) {
        resolve({ ok: true, content: typeof value === "string" ? value : JSON.stringify(value ?? null) });
      } else {
        resolve({ ok: false, error: typeof value === "string" ? value : "tool failed" });
      }
    } catch (error) {
      this.log(`evenhub: bad tool result: ${error}`);
    }
  }

  /**
   * Prompt the user (on the glasses) to share configured API keys with the app,
   * resolving with the granted values. Services already granted this session
   * skip the prompt; declining resolves with an empty map.
   */
  private requestApiKeyAccess(services: string[]): Promise<Record<string, string>> {
    const requested = services.filter(isKnownApiKeyService);
    const buildGrant = (): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const id of requested) {
        if (!this.grantedApiKeys.has(id)) continue;
        const value = apiKeyValue(id);
        if (value) out[id] = value;
      }
      return out;
    };
    if (requested.length === 0 || requested.every((id) => this.grantedApiKeys.has(id))) {
      return Promise.resolve(buildGrant());
    }
    if (!this.windowHooks) return Promise.resolve({});
    return new Promise((resolve) => {
      const dialog = new EvenHubApiKeyDialogLayer(
        this.manifest.name,
        requested.map((id) => ({ id, configured: apiKeyValue(id).length > 0 })),
        () => {
          for (const id of requested) this.grantedApiKeys.add(id);
          resolve(buildGrant());
        },
        () => resolve({}),
      );
      this.windowHooks?.pushOverlay(dialog);
      this.windowHooks?.requestRender();
    });
  }

  /** Play a piezo tone sequence, chunking/pacing past the firmware's 48-step cap. */
  private async playBuzzer(rawSteps: unknown[]): Promise<void> {
    const steps = normalizeBuzzerSteps(rawSteps);
    if (steps.length === 0) return;
    const communicator = activeCommunicator();
    if (!communicator) return;
    for (let i = 0; i < steps.length; i += CFW_SEQ_MAX) {
      const chunk = steps.slice(i, i + CFW_SEQ_MAX);
      const payload = buildSoundSequencePayload(chunk);
      try {
        communicator.playBuzzerSequence(payload.buffer);
      } catch (error) {
        this.log(`evenhub: playBuzzer failed: ${error}`);
        return;
      }
      if (i + CFW_SEQ_MAX < steps.length) await delay(phraseDurationMs(chunk));
    }
  }

  // ----- teardown -----

  /** Close everything: glasses window, WebView, session. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.micRequested) {
      this.micRequested = false;
      evenHubMicRouter.releaseMic(this);
    }
    if (this.imuRequested) {
      this.imuRequested = false;
      evenHubImuRouter.releaseImu(this);
    }
    if (this.compassRequested) {
      this.compassRequested = false;
      evenHubCompassRouter.releaseCompass(this);
    }
    if (this.hasAppTools) {
      this.hasAppTools = false;
      toolRegistry.removeAppTools(this.windowId);
    }
    for (const resolve of this.pendingToolCalls.values()) resolve({ ok: false, error: "app closed" });
    this.pendingToolCalls.clear();
    this.locationTracker?.stop();
    this.locationTracker = null;
    if (!this.systemExitSent) {
      // Best effort: lets the app's teardown handlers run before the webview dies.
      this.emitSysEvent(SYSTEM_EXIT_EVENT, 0);
      this.systemExitSent = true;
    }
    const hooks = this.windowHooks;
    this.windowHooks = null;
    hooks?.closeWindow();
    const webView = this.webViewHandle;
    this.webViewHandle = null;
    if (webView) {
      // Give in-flight resolves/pushes a beat to reach the webview first.
      setTimeout(() => webView.destroy(), 100);
    }
  }

  isClosed(): boolean {
    return this.closed;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The SDK's AppLocation shape (even_hub_sdk 0.0.12+), all fields camelCase. */
type AppLocation = {
  latitude: number;
  longitude: number;
  accuracy?: number;
  altitude?: number;
  speed?: number;
  heading?: number;
  timestamp?: number;
};

/** Map a continuous GPS fix to the SDK's AppLocation (omitting absent fields). */
function toAppLocation(location: TrackedLocation): AppLocation {
  const out: AppLocation = { latitude: location.latitude, longitude: location.longitude };
  if (location.accuracyMeters != null) out.accuracy = location.accuracyMeters;
  if (location.speedMps != null) out.speed = location.speedMps;
  if (location.bearingDeg != null) out.heading = location.bearingDeg;
  out.timestamp = location.timestampMs;
  return out;
}

/**
 * Read the enable flag from an audioControl / imuControl payload. The exact
 * wire field name for SDK 0.0.12 isn't captured, so accept the plausible
 * spellings (the mock bridge reads `isOpen`; IMU's PB field is `iMUReportEn`);
 * default to enabling (the common intent) when the payload is opaque, and log
 * it so the real shape can be pinned from hardware.
 */
function readEnableFlag(data: Record<string, unknown>): boolean {
  for (const key of ["enable", "open", "isOpen", "on", "status", "value", "start", "iMUReportEn", "IMU_ReportEn"]) {
    const value = data[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value === "true" || value === "1" || value === "on" || value === "open";
  }
  return true;
}

/** Snap a requested IMU report rate to the SDK's 100..1000 (step 100) grid. */
function clampImuFreq(freq: number): number {
  const snapped = Math.round(freq / 100) * 100;
  return Math.min(1000, Math.max(100, snapped));
}

function activeCommunicator(): any {
  if (!global.isAndroid) return null;
  try {
    return com.faceclaw.app.FaceclawBleCommunicator.getActive();
  } catch {
    return null;
  }
}

/**
 * Copy content into a `preserve` container from the same-named, same-kind
 * container in the previous page (if any), so a replaceLayout keeps its pixels /
 * text / list state instead of blanking.
 */
function preserveContent(target: EvenHubContainer, previous: EvenHubPage | null): void {
  const source = previous?.containers.find((c) => c.kind === target.kind && c.name === target.name);
  if (!source) return;
  if (target.kind === "text" && source.kind === "text") {
    target.content = source.content;
  } else if (target.kind === "image" && source.kind === "image") {
    target.pixels = source.pixels;
    target.pixelsWidth = source.pixelsWidth;
    target.pixelsHeight = source.pixelsHeight;
  } else if (target.kind === "list" && source.kind === "list") {
    target.itemNames = source.itemNames;
    target.selectedIndex = Math.min(source.selectedIndex, Math.max(0, target.itemNames.length - 1));
  }
}

/** The API-key services the extension API can surface, and their settings. */
const API_KEY_SERVICES = [
  { id: "openai", setting: openAiApiKeySetting },
  { id: "anthropic", setting: anthropicApiKeySetting },
  { id: "soniox", setting: sonioxApiKeySetting },
  { id: "elevenlabs", setting: elevenLabsApiKeySetting },
  { id: "mapbox", setting: mapboxApiKeySetting },
] as const;

function isKnownApiKeyService(id: string): boolean {
  return API_KEY_SERVICES.some((service) => service.id === id);
}

function apiKeyValue(id: string): string {
  return API_KEY_SERVICES.find((service) => service.id === id)?.setting.get().trim() ?? "";
}

/** Service ids the user has actually configured (non-empty key), names only. */
function configuredApiKeyServices(): string[] {
  return API_KEY_SERVICES.filter((service) => service.setting.get().trim()).map((service) => service.id);
}

/** Coerce an app-supplied buzzer step list into validated {freq, ms, duty?}. */
function normalizeBuzzerSteps(raw: unknown[]): Step[] {
  const out: Step[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const freq = Number(record.freq);
    const ms = Number(record.ms);
    if (!Number.isFinite(freq) || !Number.isFinite(ms)) continue;
    const duty = record.duty === undefined ? undefined : Number(record.duty);
    out.push({ freq, ms, duty: duty !== undefined && Number.isFinite(duty) ? duty : undefined });
  }
  return out;
}

/**
 * Decode an uncompressed Windows BMP ('BM', BI_RGB) to 8bpp grayscale. Handles
 * 1/4/8-bit paletted and 24/32-bit BGR(A), top-down or bottom-up. Returns null
 * for compressed or unsupported variants. Apps like EvenChess send 1-bit BMPs
 * (black/white palette) for full-board refreshes.
 */
function decodeBmp(bytes: Uint8Array): { pixels: Uint8Array; width: number; height: number } | null {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null;
  const u16 = (o: number) => bytes[o]! | (bytes[o + 1]! << 8);
  const u32 = (o: number) => (bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16) | (bytes[o + 3]! << 24)) >>> 0;
  const i32 = (o: number) => bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16) | (bytes[o + 3]! << 24);

  const pixelOffset = u32(10);
  const dibSize = u32(14);
  const width = i32(18);
  const heightRaw = i32(22);
  const bitCount = u16(28);
  const compression = u32(30);
  if (compression !== 0) return null; // only BI_RGB (uncompressed)
  if (width <= 0 || width > 4096) return null;
  const topDown = heightRaw < 0;
  const height = Math.abs(heightRaw);
  if (height === 0 || height > 4096) return null;

  // Palette (grayscale per index) for <=8bpp; each entry is 4 bytes BGRA.
  let palette: Uint8Array | null = null;
  if (bitCount <= 8) {
    let numColors = u32(46);
    if (numColors === 0 || numColors > (1 << bitCount)) numColors = 1 << bitCount;
    const palOffset = 14 + dibSize;
    palette = new Uint8Array(numColors);
    for (let i = 0; i < numColors; i++) {
      const o = palOffset + i * 4;
      if (o + 2 >= bytes.length) break;
      palette[i] = luminance(bytes[o + 2]!, bytes[o + 1]!, bytes[o]!);
    }
  }

  const stride = (((width * bitCount + 31) >> 5) << 2); // rows are 4-byte aligned
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const srcY = topDown ? y : height - 1 - y;
    const rowStart = pixelOffset + srcY * stride;
    if (rowStart >= bytes.length) break;
    const dstRow = y * width;
    for (let x = 0; x < width; x++) {
      let gray: number;
      if (bitCount === 1) {
        const bit = ((bytes[rowStart + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1;
        gray = palette?.[bit] ?? (bit ? 255 : 0);
      } else if (bitCount === 4) {
        const byte = bytes[rowStart + (x >> 1)] ?? 0;
        const nib = (x & 1) === 0 ? byte >> 4 : byte & 0x0f;
        gray = palette?.[nib] ?? nib * 17;
      } else if (bitCount === 8) {
        const idx = bytes[rowStart + x] ?? 0;
        gray = palette?.[idx] ?? idx;
      } else if (bitCount === 24) {
        const o = rowStart + x * 3;
        gray = luminance(bytes[o + 2] ?? 0, bytes[o + 1] ?? 0, bytes[o] ?? 0);
      } else if (bitCount === 32) {
        const o = rowStart + x * 4;
        gray = luminance(bytes[o + 2] ?? 0, bytes[o + 1] ?? 0, bytes[o] ?? 0);
      } else {
        return null;
      }
      pixels[dstRow + x] = gray;
    }
  }
  return { pixels, width, height };
}

function luminance(r: number, g: number, b: number): number {
  return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
}

/**
 * ring/left-arm/right-arm -> PB EventSourceType. The watch is reported to
 * EvenHub apps as the ring: they only know stock hardware, and the watch's
 * ring-vocabulary gestures mean the same thing.
 */
function gestureSource(source: InputSource): number {
  switch (source) {
    case "right-arm":
      return 1;
    case "ring":
    case "watch":
      return 2;
    case "left-arm":
      return 3;
  }
}

/**
 * Protobuf JSON elides zero-valued fields, and apps depend on it (they test
 * eventType === 0 || eventType === undefined). Emit the same shape.
 */
function elideZeroFields(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === 0 || value === "") continue;
    out[key] = value;
  }
  return out;
}

/** Accept the payload forms seen on the wire: number[], JSON-ified typed
 * array ({"0": 1, ...}), or base64 string. */
function imagePayloadBytes(raw: unknown): Uint8Array | null {
  if (Array.isArray(raw)) {
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = Number(raw[i]) & 0xff;
    return out;
  }
  if (typeof raw === "string") return base64Decode(raw);
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const keys = Object.keys(record);
    const out = new Uint8Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const value = record[String(i)];
      if (typeof value !== "number") return null;
      out[i] = value & 0xff;
    }
    return out;
  }
  return null;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Decode(text: string): Uint8Array | null {
  const clean = text.replace(/[\s=]+$/g, "").replace(/\s+/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let bitCount = 0;
  let outIndex = 0;
  for (const char of clean) {
    const value = BASE64_ALPHABET.indexOf(char);
    if (value < 0) return null;
    bits = (bits << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out[outIndex++] = (bits >> bitCount) & 0xff;
    }
  }
  return out.subarray(0, outIndex);
}

/**
 * Decode an image payload: PNG or BMP (both are sent by real apps — EvenChess
 * force-refreshes as 1-bit BMP but streams live moves as PNG, so a host that
 * only did PNG dropped the initial board), or raw grayscale sized to the
 * container (8bpp, or 4bpp packed two pixels per byte, high nibble first).
 */
function decodeImageBytes(
  bytes: Uint8Array,
  container: EvenHubImageContainer,
): { pixels: Uint8Array; width: number; height: number } | null {
  if (bytes.length > 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const bmp = decodeBmp(bytes);
    if (bmp) return bmp;
  }
  if (bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    try {
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const decoded = UPNG.decode(buffer);
      const frames = UPNG.toRGBA8(decoded) as ArrayBuffer[];
      if (!frames.length) return null;
      const rgba = new Uint8Array(frames[0]!);
      const pixels = new Uint8Array(decoded.width * decoded.height);
      for (let i = 0; i < pixels.length; i++) {
        const offset = i * 4;
        const alpha = (rgba[offset + 3] ?? 0) / 255;
        pixels[i] = Math.round(
          (0.2126 * (rgba[offset] ?? 0) + 0.7152 * (rgba[offset + 1] ?? 0) + 0.0722 * (rgba[offset + 2] ?? 0)) * alpha,
        );
      }
      return { pixels, width: decoded.width, height: decoded.height };
    } catch (error) {
      console.warn(`evenhub: PNG decode failed: ${error}`);
      return null;
    }
  }
  const area = container.width * container.height;
  if (bytes.length === area) {
    return { pixels: Uint8Array.from(bytes), width: container.width, height: container.height };
  }
  if (bytes.length === Math.ceil(area / 2)) {
    const pixels = new Uint8Array(area);
    for (let i = 0; i < area; i++) {
      const byte = bytes[i >> 1]!;
      const nibble = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
      pixels[i] = nibble * 17;
    }
    return { pixels, width: container.width, height: container.height };
  }
  return null;
}
