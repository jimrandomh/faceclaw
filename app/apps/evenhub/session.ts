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
  clampToStockLimits,
  containerById,
  declaredMenuItems,
  PAGE_CREATE_INVALID,
  stockPageFailure,
  eventCaptureContainer,
  parsePage,
  readNumber,
  readOptionalNumber,
  readString,
  readTextBrightness,
  type EvenHubImageContainer,
  type EvenHubListContainer,
  type EvenHubContainer,
  type EvenHubMenuItem,
  type EvenHubPage,
  type EvenHubTextContainer,
} from "./containers";
import { compositePage, layoutText } from "./compositor";
import { describeImageUpdate, describePage, describeTextUpgrade } from "./layout-debug";
import { IMAGE_SEND_FAILED, IMAGE_SUCCESS, prepareImageUpdate } from "./image-pipeline";
import { stockPayloadError } from "./payload-validation";
import { decodeImageRgba } from "../../native/image-rgba";
import { stepListSelection } from "./list-menu";
import { type EvenHubManifest } from "./ehpk";
import { permissionsIncludeMicrophone, permissionsInclude } from "./permissions";
import { evenHubMicRouter, type EvenHubMicClient } from "./mic-router";
import { evenHubImuRouter, type EvenHubImuClient } from "./imu-router";
import { evenHubCompassRouter, type EvenHubCompassClient, type EvenHubCompassReading } from "./compass-router";
import { type ImuReading } from "../../native/imu";
import { toolRegistry, type ToolResult, type ToolSpec } from "../../assistant/tool-registry";
import { getCurrentLocation } from "../../native/location";
import { LocationTracker, type TrackedLocation } from "../../native/location-tracker";
import { ensureFineLocationPermission } from "../../native/location-permissions";
import {
  buildEvenHubDeviceStatus,
  OFFLINE_DEVICE_STATUS_SOURCE,
  sameDeviceStatus,
  type EvenHubDeviceStatus,
  type EvenHubDeviceStatusSource,
} from "./device-status";
import { parseWindowIcon, WindowIconRenderer } from "./window-icon";
import { availableFontFamilies, containerFace, measureContainerText } from "./fonts";
import { parseFontSpec } from "./font-spec";


/**
 * Page layouts and container updates go to logcat at debug level (see
 * layout-debug.ts): `adb logcat -s FaceclawEvenHubLayout:D`. Android only.
 */
const LAYOUT_LOG_TAG = "FaceclawEvenHubLayout";
const LAYOUT_LOG_ENABLED = !!global.isAndroid;
/** Logcat truncates entries around 4 KB; split longer lines below that. */
const LOGCAT_CHUNK_CHARS = 3000;

/** OsEventTypeList values (PB ordinals). */
const CLICK_EVENT = 0;
const SCROLL_TOP_EVENT = 1;
const SCROLL_BOTTOM_EVENT = 2;
const DOUBLE_CLICK_EVENT = 3;
const FOREGROUND_ENTER_EVENT = 4;
const FOREGROUND_EXIT_EVENT = 5;
const ABNORMAL_EXIT_EVENT = 6;
const SYSTEM_EXIT_EVENT = 7;
const IMU_DATA_REPORT_EVENT = 8;
/** SDK 0.0.14: the press gesture, delivered like any other list/text/sys event. */
const LONG_PRESS_EVENT = 9;
const LONG_PRESS_RELEASE_EVENT = 10;

/** After a failed rebuild, how long the app gets to hear ABNORMAL_EXIT before it is closed. */
const ABNORMAL_EXIT_CLOSE_DELAY_MS = 200;

/** Stock text scrolling: one step per swipe, and "at an end" within this tolerance. */
const TEXT_SCROLL_STEP_PX = 28;
const TEXT_SCROLL_EDGE_PX = 3;

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
  // Host-driven timers and requestAnimationFrame. Chromium heavily throttles a
  // page's own setTimeout/setInterval when the phone screen is off, and pauses
  // or throttles a hidden page's rAF, which slows timer-driven apps to a crawl
  // and stalls canvas apps that render on a rAF loop. Replace them with queues
  // fired by window.__fcTick(), which the native host calls regardless of
  // screen state (host-initiated evaluateJavascript escapes the throttle).
  // (The glasses render via BLE, not the phone's display, so vsync alignment
  // doesn't matter — a steady frame rate does.)
  //
  // __fcTick returns how many ms until it next has work (-1: none), and the
  // host sleeps until then instead of evaluating JS at 60Hz for an idle page.
  // Work added outside a tick that is due before the host's next tick wakes it
  // through the bridge.
  if (window.__fcTick) return;
  var FRAME_MS = 16;
  var timers = new Map();
  var nextId = 1;
  var rafs = new Map();
  var nextRafId = 1;
  var inTick = false;
  // When the host will next call __fcTick; Infinity while it is idle.
  var hostNextTickAt = Infinity;
  function needTickBy(due) {
    if (inTick || due >= hostNextTickAt) return;
    hostNextTickAt = Date.now();
    var bridge = window.__faceclawEvenHub;
    if (bridge && bridge.wakeTimers) bridge.wakeTimers();
  }
  window.setTimeout = function (cb, delay) {
    var args = Array.prototype.slice.call(arguments, 2);
    var id = nextId++;
    var due = Date.now() + (+delay || 0);
    timers.set(id, { cb: cb, args: args, due: due, interval: 0 });
    needTickBy(due);
    return id;
  };
  window.setInterval = function (cb, delay) {
    var args = Array.prototype.slice.call(arguments, 2);
    var id = nextId++;
    var d = +delay || 0;
    var due = Date.now() + d;
    timers.set(id, { cb: cb, args: args, due: due, interval: d });
    needTickBy(due);
    return id;
  };
  window.clearTimeout = function (id) { timers.delete(id); };
  window.clearInterval = function (id) { timers.delete(id); };
  window.requestAnimationFrame = function (cb) {
    var id = nextRafId++;
    rafs.set(id, cb);
    needTickBy(Date.now() + FRAME_MS);
    return id;
  };
  window.cancelAnimationFrame = function (id) { rafs.delete(id); };
  function runTimers() {
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
  }
  function runRafs() {
    if (rafs.size === 0) return;
    var ts = window.performance && performance.now ? performance.now() : Date.now();
    // Snapshot and clear: callbacks that re-request during this frame run on
    // the NEXT frame, matching rAF semantics (so a loop doesn't spin forever).
    var current = rafs;
    rafs = new Map();
    current.forEach(function (cb) {
      try { cb(ts); } catch (e) { if (window.console) console.error(e); }
    });
  }
  function inTickDo(fn) {
    inTick = true;
    try { fn(); } finally { inTick = false; }
  }
  // Fixed-rate entry points for hosts that don't use __fcTick's schedule (the
  // iOS host calls both every frame).
  window.__fcTimerTick = function () { inTickDo(runTimers); };
  window.__fcRafTick = function () { inTickDo(runRafs); };
  window.__fcTick = function () {
    inTick = true;
    try {
      runTimers();
      runRafs();
    } finally {
      inTick = false;
    }
    var now = Date.now();
    var delay = rafs.size ? FRAME_MS : -1;
    timers.forEach(function (entry) {
      var d = entry.due - now;
      if (delay < 0 || d < delay) delay = d;
    });
    if (delay >= 0) delay = Math.max(FRAME_MS, Math.ceil(delay));
    hostNextTickAt = delay < 0 ? Infinity : now + delay;
    return delay;
  };
})();
`;

/**
 * Injected at document-start (after the stock bridge shim): defines
 * `window.getFaceclawExtensions`, the single entry point for Faceclaw-only
 * capabilities. Its public contract (the `FaceclawExtensions` interface) is
 * the @faceclaw/evenhub-extensions package in evenhub-extensions/. Keep the
 * two in step (tests/evenhub-extensions-shim.test.cjs checks the member list).
 * When adding members, bump API_VERSION and tag them `@since apiVersion N` in
 * the package.
 *
 * It never touches the standard SDK or any prototype — everything lives behind
 * this one global, so apps stay compatible with the stock Even app (where the
 * global is absent).
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
  var API_VERSION = 1;
  var pending = {};
  var nextId = 1;
  window.__fcExtResolve = function (id, ok, value) {
    var entry = pending[id];
    if (!entry) return;
    delete pending[id];
    if (ok) entry[0](value);
    else entry[1](new Error(String(value)));
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
    // Iterate a snapshot, so a listener that unsubscribes mid-dispatch
    // doesn't make the next one get skipped.
    var arr = (listeners[name] || []).slice();
    for (var i = 0; i < arr.length; i++) {
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
  // Events the host only produces on request (compass, touch-down, text
  // input): it is told to start on the first listener and to stop when the
  // last one leaves. Each unsubscribe function works once.
  function counted(name, setMethod) {
    var count = 0;
    return function (cb) {
      var off = on(name, cb);
      if (++count === 1) send(setMethod, [true]);
      var active = true;
      return function () {
        if (!active) return;
        active = false;
        off();
        if (--count === 0) send(setMethod, [false]);
      };
    };
  }
  function setWindowIcon(icon) {
    if (!icon) return call("setWindowIcon", [null]);
    // Typed arrays (ImageData.data) don't survive JSON; send a plain array.
    var data = Array.prototype.slice.call(icon.data || []);
    return call("setWindowIcon", [{ width: icon.width, height: icon.height, data: data }]);
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
    apiVersion: API_VERSION,
    getVersion: function () { return VERSION; },
    returnToAppSwitcher: function () { send("returnToAppSwitcher"); },
    quit: function () { send("quit"); },
    addWindowLifecycleListener: function (cb) { return on("windowLifecycle", cb); },
    getConfiguredApiKeys: function () { return call("getConfiguredApiKeys"); },
    requestApiKeyAccess: function (services) { return call("requestApiKeyAccess", [services || []]); },
    playBuzzer: function (steps) { return call("playBuzzer", [steps || []]); },
    addCompassListener: counted("compass", "setCompass"),
    createLayout: function (layout) { return call("createLayout", [layout || {}]); },
    replaceLayout: function (layout) { return call("replaceLayout", [layout || {}]); },
    setAssistantTools: setAssistantTools,
    addTouchDownListener: counted("touchDown", "setTouchDown"),
    addTextInputListener: counted("textInput", "setTextInput"),
    startVoiceInput: function () { return call("startVoiceInput"); },
    setWindowIcon: setWindowIcon,
    setAttention: function (attention) { send("setAttention", [!!attention]); },
    setKeepScreenOn: function (keepOn) { send("setKeepScreenOn", [!!keepOn]); },
    getFonts: function () { return call("getFonts"); },
    measureText: function (text, font) { return call("measureText", [String(text), font || null]); }
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
  /** Show or clear the attention dot on the window's switcher icon. */
  setAttention: (attention: boolean) => void;
  /** Offer (or stop offering) the window as the shell's "Type Into App" destination. */
  setAcceptsTextInput: (accept: boolean) => void;
  /** Open the shell's voice dialog aimed at the window; false if it can't open now. */
  startVoiceInput: () => boolean;
  /** The app changed its window icon: repaint the switcher. */
  iconChanged: () => void;
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
  /** The page came from Faceclaw's extended layout API, which isn't held to stock limits. */
  private extendedLayout = false;
  private webViewHandle: EvenHubWebViewHandle | null = null;
  private windowHooks: EvenHubWindowHooks | null = null;
  private closed = false;
  private launchContextPushed = false;
  private loadError = '';
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
  /** The app listens for touch-down (extension addTouchDownListener). */
  private touchDownRequested = false;
  /** The app listens for text input, so the shell offers it as a Type Into App destination. */
  private textInputRequested = false;
  /** The app asked for the attention dot on its switcher icon. */
  private attention = false;
  /** The app asked the idle screen timeout to wait while it is in the foreground. */
  private keepScreenOnRequested = false;
  /** The app's own switcher icon; null draws the package icon. */
  private windowIcon: WindowIconRenderer | null = null;
  /** The paired glasses' serial, read once so getGlassesInfo and every status push agree. */
  private glassesSerial: string | null | undefined = undefined;
  /** The last deviceStatusChanged sent, and the subscriptions that refresh it. */
  private lastDeviceStatus: EvenHubDeviceStatus | null = null;
  private readonly deviceStatusOffs: (() => void)[] = [];
  private log: (message: string) => void;

  constructor(
    manifest: EvenHubManifest,
    distDir: string,
    log: (message: string) => void,
    remoteUrl = "",
    private readonly sendBuzzerSequence: (payload: Uint8Array) => Promise<void> | void = () => {},
    private readonly deviceStatusSource: EvenHubDeviceStatusSource = OFFLINE_DEVICE_STATUS_SOURCE,
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

  /**
   * A WebView load failed. Once the app has loaded, a failed or blocked
   * navigation leaves its page running, so only a failure before then (or one
   * the host marks `fatal`) replaces the glasses window with the error.
   */
  webViewFailed(message: string, fatal = false): void {
    if (this.closed) return;
    this.log(`evenhub: ${message}`);
    if (this.launchContextPushed && !fatal) return;
    this.loadError = message; this.windowHooks?.requestRender();
  }

  /** The WebView finished loading the app: push the one-shot launch context. */
  webViewLoaded(): void {
    if (this.loadError) { this.loadError = ''; this.windowHooks?.requestRender(); }
    if (this.launchContextPushed) return;
    this.launchContextPushed = true;
    // Launched to drive the glasses (from the on-glasses file browser), so
    // apps that branch on this should take their glasses path.
    this.pushMessage("evenAppLaunchSource", { launchSource: "glassesMenu" });
    this.pushDeviceStatus();
    this.deviceStatusOffs.push(this.deviceStatusSource.subscribe(() => this.pushDeviceStatus()));
  }

  // ----- glasses window wiring -----

  attachWindow(hooks: EvenHubWindowHooks): void {
    this.windowHooks = hooks;
    this.shellWindowId = hooks.windowId;
    // Requests the app made before the window existed.
    if (this.textInputRequested) hooks.setAcceptsTextInput(true);
    if (this.attention) hooks.setAttention(true);
    if (this.windowIcon) hooks.iconChanged();
  }

  windowClosed(): void {
    this.windowHooks = null;
    this.close();
  }

  paint(size: { width: number; height: number }, focused: boolean): GrayImage {
    // Focus changes always trigger a repaint of the foreground window, so paint
    // is a reliable place to sample shell input-focus for lifecycle events.
    this.updateShellFocus(focused);
    if (this.loadError || !this.pageCreated || !this.page) {
      const image = new GrayImage(size.width, size.height, 0);
      const font = EvenHubFont.get();
      font.drawText(image, 16, 16, `${this.loadError ? 'Could not run' : 'Loading'} ${this.manifest.name}...`, 255);
      font.drawTextWrapped(image, 16, 16 + 2 * font.lineHeight, Math.max(1, size.width - 32),
        this.loadError || "(waiting for the app to build its page)", 120);
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
    // Touch-down has no stock event (an unknown eventType would parse as a
    // click), so it goes only to apps that subscribed through the extension.
    if (event.type === "ring-press") {
      if (this.touchDownRequested) {
        this.pushExtEvent("touchDown", { source: extensionInputSource(event.source), timestampMs: event.timestampMs });
      }
      return;
    }
    if (!this.page) return;
    const capture = eventCaptureContainer(this.page);
    // The stock eventSource can't tell the watch from the ring, and scrolls
    // carry none; the extension field names the device when it is known.
    const inputSource = "source" in event && event.source ? extensionInputSource(event.source) : undefined;
    switch (event.type) {
      case "click":
        if (capture?.kind === "list") {
          this.emitListEvent(capture, CLICK_EVENT, inputSource);
        } else {
          this.emitSysEvent(CLICK_EVENT, gestureSource(event.source), inputSource);
        }
        break;
      case "double-click":
        this.emitSysEvent(DOUBLE_CLICK_EVENT, gestureSource(event.source), inputSource);
        break;
      case "long-press":
      case "short-then-long-press":
      case "long-press-release": {
        // SDK 0.0.14 exposes press and release as ordinary events. The app's
        // press is the context-menu gesture (tap-then-hold; the shell keeps
        // the plain long-press for its system menu): the window still opens
        // its menu on it (that menu is where the app's contextual-menu items
        // live, and it is the way out of an app that owns double-click), so
        // an app hears the press as well as seeing the menu — it cannot be
        // given exclusive use of the gesture.
        const eventType = event.type === "long-press-release" ? LONG_PRESS_RELEASE_EVENT : LONG_PRESS_EVENT;
        if (capture?.kind === "list") {
          this.emitListEvent(capture, eventType, inputSource);
        } else {
          this.emitSysEvent(eventType, gestureSource(event.source), inputSource);
        }
        break;
      }
      case "scroll-up":
      case "scroll-down": {
        const eventType = event.type === "scroll-up" ? SCROLL_TOP_EVENT : SCROLL_BOTTOM_EVENT;
        if (capture?.kind === "list") {
          this.scrollList(capture, eventType, inputSource);
        } else if (capture?.kind === "text") {
          this.scrollText(capture, eventType, inputSource);
        } else {
          this.emitSysEvent(eventType, 0, inputSource);
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * The contextual-menu entries the running page registered (SDK 0.0.14
   * `menuObject`), for the window to merge into its own menu. Empty when the
   * app declared none.
   */
  contextMenuItems(): EvenHubMenuItem[] {
    return this.page?.menuItems ?? [];
  }

  /** The user picked one of the app's contextual-menu entries. */
  selectContextMenuItem(itemID: number): void {
    this.pushMessage("evenHubEvent", { type: "menuItemClickEvent", jsonData: { itemID } });
  }

  /**
   * Stock scrolls a capture text container that overflows by itself, a 28px
   * step per swipe, and tells the app only at the ends (a textEvent naming the
   * container). Text that fits reports every swipe as reaching an end.
   */
  private scrollText(text: EvenHubTextContainer, eventType: number, inputSource?: ExtensionInputSource): void {
    const { maxScroll } = layoutText(text);
    const forward = eventType === SCROLL_BOTTOM_EVENT;
    const atEnd = forward ? maxScroll - text.scrollY < TEXT_SCROLL_EDGE_PX : text.scrollY < TEXT_SCROLL_EDGE_PX;
    if (maxScroll === 0 || atEnd) {
      this.emitTextEvent(text, eventType, inputSource);
      return;
    }
    text.scrollY = forward
      ? Math.min(maxScroll, text.scrollY + TEXT_SCROLL_STEP_PX)
      : Math.max(0, text.scrollY - TEXT_SCROLL_STEP_PX);
    this.windowHooks?.requestRender();
  }

  private scrollList(list: EvenHubListContainer, eventType: number, inputSource?: ExtensionInputSource): void {
    // Swipe up selects the previous item, swipe down the next (stock direction).
    const delta = eventType === SCROLL_TOP_EVENT ? -1 : 1;
    // At a boundary the selection stays put (the list bounces) and the app hears about it.
    if (!stepListSelection(list, containerFace(list.font), delta)) this.emitListEvent(list, eventType, inputSource);
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

  /**
   * A decoded mic frame from the router: hand it to the app as an audioEvent.
   *
   * SDK 0.0.14 added per-frame `direction` and `speakerRole`. Neither is
   * available here — the router hands over plain PCM with no beamforming tag,
   * and speakerRole is an app-level diarization result the stock host computes
   * — so both are sent as the fallbacks the SDK documents for a phone mic and
   * for older hosts.
   */
  deliverAudioPcm(pcm: Uint8Array): void {
    const audioPcm = Array.from(pcm);
    this.pushMessage("evenHubEvent", {
      type: "audioEvent",
      jsonData: { audioPcm, direction: null, speakerRole: "unknown" },
    });
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
      // The Even app's field name (protobuf IMU_Data); the SDK reads it as imuData.
      iMUData: { x: reading.x, y: reading.y, z: reading.z },
    });
  }

  /**
   * imuControl(isOpen, reportFrq): enable/disable the accelerometer report
   * stream. There is no EvenHub IMU permission (nor an Android one), so no
   * consent gate. Enabling registers intent; the router only actually streams
   * to the foreground app. reportFrq is one of 100..1000 (step 100).
   */
  private imuControl(data: Record<string, unknown>): boolean {
    if (global.isIOS) return false;
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
        // As the Even app: `data`, else `payload`.
        const data = asRecord(message.data ?? message.payload);
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
      case "getGlassesInfo": {
        const status = this.deviceStatus();
        return { model: "g2", sn: status.sn, status };
      }
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
      this.layoutLog(() => ["createStartUpPageContainer: repeated call, rejected as stock does"]);
      await delay(DUPLICATE_CREATE_DELAY_MS);
      return 1;
    }
    // The Even app refuses some payloads without sending them; then the
    // firmware may fail to build the page.
    const payloadError = stockPayloadError("create", data);
    if (payloadError) {
      this.layoutLog(() => [`createStartUpPageContainer refused, as the Even app would: ${payloadError}`]);
      return PAGE_CREATE_INVALID;
    }
    const page = parsePage(data);
    const failure = stockPageFailure(page);
    if (failure) {
      this.layoutLog(() => [`createStartUpPageContainer failed, as the firmware would: ${failure.reason}`]);
      return failure.code;
    }
    clampToStockLimits(page);
    this.warnOnDroppedMenuItems(page, data);
    this.layoutLog(() => describePage("createStartUpPageContainer", page, data));
    this.page = page;
    this.pageCreated = true;
    this.extendedLayout = false;
    // The launch focus arrived before the page existed; deliver the ENTER now.
    if (this.foreground && !this.launchEnterSent) {
      this.launchEnterSent = true;
      this.emitSysEvent(FOREGROUND_ENTER_EVENT, 0);
    }
    this.windowHooks?.requestRender();
    return 0;
  }

  private rebuildPage(data: Record<string, unknown>): boolean {
    // Only createStartUpPageContainer starts an EvenHub page on the glasses.
    if (!this.pageCreated) {
      this.layoutLog(() => ["rebuildPageContainer before createStartUpPageContainer: no page to rebuild"]);
      return false;
    }
    const payloadError = stockPayloadError("rebuild", data);
    if (payloadError) {
      this.layoutLog(() => [`rebuildPageContainer refused, as the Even app would: ${payloadError}`]);
      return false;
    }
    const page = parsePage(data);
    const failure = stockPageFailure(page);
    if (failure) {
      // The firmware has already torn the old page down; it reports an
      // abnormal exit and the Even app closes the app.
      this.layoutLog(() => [`rebuildPageContainer failed, as the firmware would: ${failure.reason}; closing the app`]);
      this.page = { containers: [], menuItems: [] };
      this.windowHooks?.requestRender();
      this.emitSysEvent(ABNORMAL_EXIT_EVENT, 0);
      this.systemExitSent = true;
      setTimeout(() => this.close(), ABNORMAL_EXIT_CLOSE_DELAY_MS);
      return false;
    }
    clampToStockLimits(page);
    this.warnOnDroppedMenuItems(page, data);
    this.layoutLog(() => describePage("rebuildPageContainer", page, data));
    this.page = page;
    this.extendedLayout = false;
    this.windowHooks?.requestRender();
    return true;
  }

  private warnOnDroppedMenuItems(page: EvenHubPage, data: Record<string, unknown>): void {
    const declaredMenuCount = declaredMenuItems(data).length;
    if (declaredMenuCount > page.menuItems.length) {
      this.log(
        `evenhub: dropped ${declaredMenuCount - page.menuItems.length} of ${declaredMenuCount} contextual menu ` +
          "items (max 10, itemID must be non-zero and unique, itemName at most 32 UTF-8 bytes)",
      );
    }
  }

  private textUpgrade(data: Record<string, unknown>): boolean {
    const id = readNumber(data, "containerID", 0);
    const name = readString(data, "containerName", "");
    const content = readString(data, "content", "");
    const offset = readOptionalNumber(data, "contentOffset");
    const payloadError = stockPayloadError("textUpgrade", data);
    if (payloadError) {
      this.layoutLog(() => [`textContainerUpgrade refused, as the Even app would: ${payloadError}`]);
      return false;
    }
    // The firmware finds the container by id alone (its first container with
    // that id, of any kind); the name isn't checked anywhere.
    const target = containerById(this.page, id);
    if (!target) {
      this.layoutLog(() => [describeTextUpgrade(id, name, null, offset, content.length)]);
      return false;
    }
    // Aimed at a list or image, the firmware writes into it as if it were
    // text and reports success; nothing we could show.
    if (target.kind !== "text") return true;
    // The content replaces the whole text: stock ignores contentOffset and
    // contentLength (firmware 2.2.9.22 in the emulator showed "XY" alone for
    // every offset/length tried). The firmware re-sets the label, scrolled
    // back to the top, only for non-empty text, so emptying a container
    // leaves its old text showing (apps send " " to clear one).
    if (content !== "") {
      target.content = content;
      target.scrollY = 0;
    }
    // SDK 0.0.14: textColor on an incremental update sets the container's
    // brightness; omitting it keeps whatever level the container has.
    const brightness = readTextBrightness(data);
    if (brightness !== undefined) target.textColor = brightness;
    this.layoutLog(() => [describeTextUpgrade(id, name, target, offset, content.length)]);
    this.windowHooks?.requestRender();
    return true;
  }

  /** EhImageUpdateResult: 0 success, 1 imageException, 2 sizeInvalid, 3 toGray4Failed, 4 sendFailed. */
  private updateImage(data: Record<string, unknown>): number {
    const id = readNumber(data, "containerID", 0);
    const name = readString(data, "containerName", "");
    const raw = data.imageData;
    // Before the page exists (and after shutdown) the Even app fails it outright.
    if (!this.pageCreated || !this.page) {
      this.layoutLog(() => [`updateImageRawData id=${id}: no page yet, sendFailed`]);
      return IMAGE_SEND_FAILED;
    }
    // The Even app sizes the bitmap from the image container it finds by id,
    // then by trimmed name.
    const images = this.page.containers.filter((c): c is EvenHubImageContainer => c.kind === "image");
    const geometry = (id > 0 ? images.find((c) => c.id === id) : undefined) ??
      (name.trim() ? images.find((c) => c.name.trim() === name.trim()) : undefined);
    const prepared = prepareImageUpdate({
      imageData: raw,
      compressMode: readNumber(data, "compressMode", 0),
      requestWidth: readNumber(data, "width", 0),
      requestHeight: readNumber(data, "height", 0),
      geometry: geometry ?? null,
      decodeNative: decodeImageRgba,
      stockLimits: !this.extendedLayout,
    });
    // The firmware takes the transfer only for an id whose first container is
    // an image, and then shows the bitmap only if it's exactly that size.
    const target = containerById(this.page, id);
    let result = prepared.result;
    let shown = false;
    if (result === IMAGE_SUCCESS && target?.kind !== "image") {
      result = IMAGE_SEND_FAILED;
    } else if (result === IMAGE_SUCCESS && target?.kind === "image" && prepared.levels &&
        prepared.width === target.width && prepared.height === target.height) {
      target.pixels = prepared.levels.map((level) => level * 17);
      target.pixelsWidth = prepared.width;
      target.pixelsHeight = prepared.height;
      shown = true;
      this.windowHooks?.requestRender();
    }
    this.layoutLog(() => describeImageUpdate({ sentId: id, sentName: name, raw, target, prepared, shown, result }));
    return result;
  }

  /** Debug-level logcat for layouts and updates; `describe` runs only when logging is on. */
  private layoutLog(describe: () => string[]): void {
    if (!LAYOUT_LOG_ENABLED) return;
    try {
      const prefix = `[${this.manifest.packageId}] `;
      for (const line of describe()) {
        for (let i = 0; i < line.length; i += LOGCAT_CHUNK_CHARS) {
          android.util.Log.d(LAYOUT_LOG_TAG, prefix + line.slice(i, i + LOGCAT_CHUNK_CHARS));
        }
      }
    } catch (error) {
      console.warn(`evenhub: layout log failed: ${error}`);
    }
  }

  private shutDown(exitMode: number): boolean {
    this.layoutLog(() => [`shutDownPageContainer exitMode=${exitMode}`]);
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
    // The package ID must end at the first ':' so that no other package can
    // reach this one's keys (manifest IDs are unvalidated: package "a" asking
    // for key "b:ls:c" must not read package "a:ls:b"'s "c"). IDs containing
    // ':' or '%' are encoded, so they can't collide with the plain IDs either.
    const id = this.manifest.packageId;
    return `evenhub:${/[:%]/.test(id) ? encodeURIComponent(id) : id}:ls:${key}`;
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

  /** Log a problem with the app's own calls where its developer will see it: the app's console. */
  private warnApp(message: string): void {
    this.log(`evenhub: ${message}`);
    this.webViewHandle?.evaluateJs(`window.console && console.warn(${JSON.stringify(`Faceclaw: ${message}`)})`);
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

  private emitSysEvent(eventType: number, eventSource: number, inputSource?: ExtensionInputSource): void {
    this.pushEvenHubEvent("sysEvent", { eventType, eventSource, [INPUT_SOURCE_FIELD]: inputSource });
  }

  private emitTextEvent(text: EvenHubTextContainer, eventType: number, inputSource?: ExtensionInputSource): void {
    this.pushEvenHubEvent("textEvent", {
      containerID: text.id,
      containerName: text.name,
      eventType,
      [INPUT_SOURCE_FIELD]: inputSource,
    });
  }

  private emitListEvent(list: EvenHubListContainer, eventType: number, inputSource?: ExtensionInputSource): void {
    this.pushEvenHubEvent("listEvent", {
      containerID: list.id,
      containerName: list.name,
      currentSelectItemIndex: list.selectedIndex,
      currentSelectItemName: list.itemNames[list.selectedIndex] ?? "",
      eventType,
      [INPUT_SOURCE_FIELD]: inputSource,
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
        result = error instanceof Error ? error.message : String(error);
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
      case "setTouchDown":
        this.touchDownRequested = params[0] === true;
        return null;
      case "setTextInput":
        this.setTextInputRequested(params[0] === true);
        return null;
      case "startVoiceInput":
        // Without a text listener the dialog would have nowhere in the app to send to.
        return this.textInputRequested && (this.windowHooks?.startVoiceInput() ?? false);
      case "setWindowIcon":
        this.setWindowIcon(params[0]);
        return null;
      case "setAttention":
        this.attention = params[0] === true;
        this.windowHooks?.setAttention(this.attention);
        return null;
      case "setKeepScreenOn":
        this.keepScreenOnRequested = params[0] === true;
        return null;
      case "getFonts":
        return availableFontFamilies();
      case "measureText":
        // No font measures in the stock font, as a container without one draws.
        return measureContainerText(String(params[0] ?? ""), parseFontSpec(params[1]));
      default:
        this.log(`evenhub: unknown extension method ${method}`);
        return null;
    }
  }

  // ----- device status (stock getGlassesInfo / deviceStatusChanged) -----

  private deviceStatus(): EvenHubDeviceStatus {
    const input = this.deviceStatusSource.read();
    if (this.glassesSerial === undefined) this.glassesSerial = input.serial;
    return buildEvenHubDeviceStatus({ ...input, serial: this.glassesSerial });
  }

  /** Push deviceStatusChanged if the status differs from the last one sent. */
  private pushDeviceStatus(): void {
    if (this.closed) return;
    const status = this.deviceStatus();
    if (this.lastDeviceStatus && sameDeviceStatus(status, this.lastDeviceStatus)) return;
    this.lastDeviceStatus = status;
    this.pushMessage("deviceStatusChanged", status);
  }

  // ----- window controls and text input (extensions) -----

  /** Whether the idle screen timeout should wait while this window is in the foreground. */
  keepsScreenOn(): boolean {
    return this.keepScreenOnRequested;
  }

  /** The app's own switcher icon at `size`, or null to draw the package icon. */
  renderWindowIcon(size: number): GrayImage | null {
    return this.windowIcon?.render(size) ?? null;
  }

  private setWindowIcon(raw: unknown): void {
    if (raw == null) {
      this.windowIcon = null;
    } else {
      const image = parseWindowIcon(raw);
      if (!image) {
        throw new Error(
          "setWindowIcon: expected {width, height, data} of at most 256x256, with data holding " +
            "width*height grayscale or width*height*4 RGBA bytes",
        );
      }
      this.windowIcon = new WindowIconRenderer(image);
    }
    this.windowHooks?.iconChanged();
  }

  private setTextInputRequested(accept: boolean): void {
    if (this.textInputRequested === accept) return;
    this.textInputRequested = accept;
    this.windowHooks?.setAcceptsTextInput(accept);
  }

  /**
   * Text the shell routed to this window: the voice dialog's Type Into App,
   * the phone keyboard, the watch, or remote input. Only arrives while the
   * app listens (setAcceptsTextInput).
   */
  deliverTextInput(text: string, options?: { submit?: boolean }): void {
    this.pushExtEvent("textInput", options?.submit === undefined ? { text } : { text, submit: options.submit });
  }

  // ----- compass (EvenHubCompassClient) -----

  deliverCompass(reading: EvenHubCompassReading): void {
    this.pushExtEvent("compass", reading);
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
    this.layoutLog(() => describePage("extension layout", page, data));
    this.page = page;
    this.pageCreated = true;
    this.extendedLayout = true;
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
      const problem = appToolProblem(name, record.parameters);
      if (problem) {
        this.warnApp(`setAssistantTools: skipped tool ${JSON.stringify(name)}: ${problem}`);
        continue;
      }
      const availability = record.availability === "open" ? "open" : "foreground";
      specs.push({
        name,
        description: readString(record, "description", ""),
        inputSchema: record.parameters == null ? { type: "object", properties: {} } : asRecord(record.parameters),
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
    if (requested.every((id) => this.grantedApiKeys.has(id))) {
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
    for (let i = 0; i < steps.length; i += CFW_SEQ_MAX) {
      const chunk = steps.slice(i, i + CFW_SEQ_MAX);
      // A send failure rejects the app's promise (handleExtensionCall logs it).
      await this.sendBuzzerSequence(buildSoundSequencePayload(chunk));
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
    for (const off of this.deviceStatusOffs.splice(0)) off();
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

/** App assistant-tool names: what every model provider accepts in a tool name. */
const APP_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Why an app's assistant tool can't be offered, or null if it can. Provider
 * APIs reject a whole request over one bad tool definition, so offering it
 * would break every assistant turn while the app runs.
 */
function appToolProblem(name: string, parameters: unknown): string | null {
  if (!APP_TOOL_NAME.test(name)) return "name must be 1-64 letters, digits, underscores or hyphens";
  if (parameters == null) return null;
  const schema = parameters as Record<string, unknown>;
  if (typeof parameters !== "object" || Array.isArray(parameters) || schema.type !== "object") {
    return 'parameters must be a JSON Schema with type "object"';
  }
  if ("oneOf" in schema || "anyOf" in schema || "allOf" in schema) {
    return "parameters can't use oneOf, anyOf or allOf at the top level";
  }
  const properties = schema.properties;
  if (properties !== undefined && (!properties || typeof properties !== "object" || Array.isArray(properties))) {
    return "parameters.properties must be an object";
  }
  const required = schema.required;
  if (required !== undefined && !(Array.isArray(required) && required.every((key) => typeof key === "string"))) {
    return "parameters.required must be an array of property names";
  }
  return null;
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
 * Input-device names in the extension API: the touchDown event's source, and
 * the `faceclawInputSource` field added to stock gesture events.
 */
type ExtensionInputSource = "ring" | "left-touchpad" | "right-touchpad" | "watch";

const INPUT_SOURCE_FIELD = "faceclawInputSource";

function extensionInputSource(source: InputSource): ExtensionInputSource {
  switch (source) {
    case "ring":
      return "ring";
    case "left-arm":
      return "left-touchpad";
    case "right-arm":
      return "right-touchpad";
    case "watch":
      return "watch";
  }
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

