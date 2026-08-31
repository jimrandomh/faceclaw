/**
 * Terminal app, hosted in its own worker thread. Window model:
 * - "terminal:hub": the window opened from the launcher; shows the list of
 *   live g2mirror sessions across every connected host (grouped by host when
 *   more than one is connected), and hosts the Manage Connections section
 *   where g2mirror:// connections are added, removed, and toggled.
 * - "terminal:view:N": opened by selecting a session in the hub; each has
 *   its own websocket connection (the protocol allows one attached session
 *   per connection) and its own xterm emulator.
 *
 * Connections are g2mirror://<token>@<host>[:port] strings (g2mirrors:// for
 * TLS), stored as JSON in the settings store (see connections.ts). Each
 * enabled connection gets a control websocket that backs the session list and
 * carries unsolicited bell/title notifications; control connections live as
 * long as the worker so bells keep flowing even if the hub window is closed.
 * The host's server_name (from the init reply) is cached per connection and
 * used as its display name, falling back to the connection string's
 * host[:port] before the first successful handshake.
 *
 * Bells for a session with an open, non-foregrounded view window set that
 * window's sidebar attention flag (cleared by the host on foregrounding).
 * Frames are painted here and submitted directly to the Java compositor from
 * this worker's thread.
 *
 * Auto-reconnect (Settings > Terminal, default on): while any terminal window
 * is open, a dropped control connection reconnects with exponential backoff;
 * the first session list after reconnect delivers bells that rang while
 * disconnected (attention + wake) via their advanced lastBellAt. A dropped
 * view connection reconnects immediately while visible, but a hidden view just
 * marks itself stale and reconnects on its next foreground/screen-on — its
 * re-attach snapshot resyncs contents and scrollback only once it's needed.
 */
import "@nativescript/core/globals";
import { GrayImage, type UiFont } from "../../graphics/image";
import { flattenPlanesWithDraws, planesFingerprint, singlePlane, type Plane } from "../../graphics/plane";
import { prepareFrameDraws } from "../../graphics/glyph-wire";
import { getDefaultSmallFont, getTerminalFontConfig } from "../../graphics/ui-fonts";
import { truncateText } from "../../graphics/textwrap";
import { TERMINAL_ICON_GLYPHS } from "../../graphics/icons";
import * as frameTimings from "../../native/frame-timings";
import { getActiveDisplay } from "../../native/active-display";
import { GESTURE_DOUBLE_CLICK, type InputEvent } from "../../ui/gestures";
import { G2MirrorClient, type G2MirrorClientOptions, type G2MirrorSession, type G2MirrorState } from "../../native/g2mirror-client";
import { onSettingsStoreChanged } from "../../native/settings-store";
import { clamp } from "../../util/numeric-util";
import { terminalAutoReconnectSetting, terminalLaunchPresetsSetting, terminalNewConnectionSetting, terminalWakeOnBellSetting } from "../../ui/dashboard-settings";
import { connectionDisplayName, loadConnections, parseConnectionString, saveConnections, TERMINAL_CONNECTIONS_KEY, updateConnection, type TerminalConnection } from "./connections";
import { TerminalEmulator } from "./terminal-emulator";
import { drawListScrollbar, drawSelectionHighlight, scrollToKeepSelectionVisible, type MenuItem } from "../../ui/menu";
import { lineStep, listRowHeight } from "../../ui/metrics";
import { defaultWindowMenuItems, WindowMenu } from "../../ui/window-menu";
import { appViewportSize } from "../../ui/shell/geometry";
import type { WorkerAppMessage, WorkerAppReply } from "../../ui/shell/worker-window";
import type { ToolResult, ToolSpec } from "../../assistant/tool-registry";

declare const global: any;
declare const com: any;

// Cell geometry comes from the terminal font setting (Settings > Terminal >
// Font; the default is Terminus-12's 6x12). Each window derives its grid from
// the viewport in its open-window message (the hub is min-height, session
// views full-height). Grid dimensions are baked into each session's websocket
// handshake, so windows and control connections capture the cell size at
// creation — a font change applies to ones (re)opened afterwards.
function chromeFont(): UiFont {
  return getDefaultSmallFont();
}
// Grid of a session view window (full-height); also declared on the control
// connections so sessions launched from presets come up at view size.
const VIEW_VIEWPORT = appViewportSize("max");
function viewGrid(): { cols: number; rows: number } {
  const { cellWidth, cellHeight } = getTerminalFontConfig();
  return {
    cols: Math.floor(VIEW_VIEWPORT.width / cellWidth),
    rows: Math.floor(VIEW_VIEWPORT.height / cellHeight),
  };
}
const DEVICE_NAME = "Faceclaw G2";
const RENDER_COALESCE_MS = 33;
const HISTORY_PAGE = 200;
// Auto-reconnect backoff: doubles per failed attempt, resets on success.
const RECONNECT_MIN_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
// Storage key of terminalNewConnectionSetting (the Add-connection draft the
// phone text editor types into); its changes just repaint the add screen.
const NEW_CONNECTION_DRAFT_KEY = "terminal.newConnectionDraft";

type BaseWindow = {
  windowId: string;
  surfaceId: string;
  /** Content viewport from the shell's open-window message; grid = viewport / cell. */
  viewportWidth: number;
  viewportHeight: number;
  gridCols: number;
  gridRows: number;
  foreground: boolean;
  /**
   * Whether this window is the shell's input target (vs. the sidebar having
   * focus). Pushed by the shell on every input/render/foreground message;
   * every focus transition triggers one of those, so it never goes stale.
   */
  focused: boolean;
  renderScheduled: boolean;
  lastSubmittedFingerprint: string;
  /** Long-press window menu; created on first open. */
  menu: WindowMenu | null;
};

/**
 * What the hub window is showing: the session list, the Manage Connections
 * section, or the Add-connection screen (type the g2mirror:// string on the
 * phone, click to save).
 */
type HubMode = "sessions" | "connections" | "add";

type HubWindow = BaseWindow & {
  kind: "hub";
  mode: HubMode;
  selectedIndex: number;
  scrollRow: number;
  /**
   * Session recency keys in display order, captured when the window last
   * became visible so the list doesn't reshuffle under the user while it's
   * open. Cleared on foreground/screen-on; orderedSessions() rebuilds it
   * lazily, sorting by recency and appending sessions that appear while
   * visible.
   */
  sessionOrder: string[];
  /** Parse-failure message shown on the Add-connection screen. */
  addError: string;
};

type ViewWindow = BaseWindow & {
  kind: "view";
  /** Grid font and integer cell pitch, captured at window creation. */
  font: UiFont;
  cellWidth: number;
  cellHeight: number;
  connectionId: string;
  socket: string;
  label: string;
  /** Sidebar-icon character (">3"); "" if every glyph was taken at open time. */
  glyph: string;
  client: G2MirrorClient;
  emulator: TerminalEmulator;
  receivedData: boolean;
  attachRequested: boolean;
  status: string;
  unsubscribers: Array<() => void>;
  // Scrollback model. Absolute line indices span the archive and the emulator:
  // indices < historyNext are archived lines; >= historyNext are emulator buffer
  // line (index - historyNext). `archive` holds fetched lines [archiveStart,
  // historyNext). `scrollTop` is the absolute index of the top visible line, or
  // null to follow the live bottom.
  historyNext: number;
  historyOldest: number;
  archive: string[];
  archiveStart: number;
  scrollTop: number | null;
  historyFetchInFlight: boolean;
  /**
   * The websocket dropped and hasn't been reconnected yet. While the view is
   * hidden this just sits set (content resync deferred); the next
   * foreground/screen-on reconnects if auto-reconnect is enabled.
   */
  needsReconnect: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectDelayMs: number;
};

type TerminalWindow = HubWindow | ViewWindow;

type PendingView = {
  connectionId: string;
  socket: string;
  label: string;
  glyph: string;
  /** Client options captured when the view was requested from a live control. */
  options: G2MirrorClientOptions;
};

const windows = new Map<string, TerminalWindow>();
const pendingViews = new Map<string, PendingView>();
// The view an assistant tool acts on when the terminal isn't foregrounded:
// the last view to be foregrounded or receive input.
let activeViewId: string | null = null;
let nextViewSerial = 1;

/**
 * Assistant tools this app contributes, declared on the hub window (which the
 * launcher opens and which persists for the app's life). All `open`-tier so
 * "rerun the build" works while the terminal is backgrounded. send_input and
 * read_screen act on the active view session (see resolveActiveView).
 */
const TERMINAL_TOOLS: ToolSpec[] = [
  {
    name: "list_sessions",
    description: "List the live g2mirror terminal sessions the glasses can see, across every connected host.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    availability: "open",
  },
  {
    name: "send_input",
    description:
      "Type a line into the active terminal session and submit it (as if typed and Enter pressed). Use to run a command in the terminal.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The line to type and run." } },
      required: ["text"],
      additionalProperties: false,
    },
    availability: "open",
  },
  {
    name: "read_screen",
    description: "Return the current visible contents of the active terminal session's screen.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    availability: "open",
  },
  {
    name: "list_launch_presets",
    description:
      "List the named launch presets that can start a new terminal session on a host machine (for launch_session).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    availability: "open",
  },
  {
    name: "launch_session",
    description:
      "Start a new terminal session on a connected host machine from a named launch preset (see list_launch_presets) and open a window viewing it.",
    inputSchema: {
      type: "object",
      properties: {
        preset: { type: "string", description: "Name of the launch preset to start." },
        host: {
          type: "string",
          description: "Which host to launch on (server name), when more than one is connected.",
        },
      },
      required: ["preset"],
      additionalProperties: false,
    },
    availability: "open",
    timeoutMs: 15_000,
  },
];
let screenOn = true;

/**
 * One record per configured connection: the stored config plus the live
 * control client (session listing for the hub, unsolicited bell/title
 * notifications). `client` is null while the connection is disabled or the
 * config doesn't parse.
 */
type ControlConnection = {
  config: TerminalConnection;
  client: G2MirrorClient | null;
  state: G2MirrorState | null;
  unsubscribers: Array<() => void>;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectDelayMs: number;
  sessionsSeeded: boolean;
};

// Keyed by connection id; iteration order mirrors the stored list (rebuilt by
// syncControlsFromSettings). Populated once the app is first opened.
const controls = new Map<string, ControlConnection>();
let controlsInitialized = false;

// When each session last "updated", unix epoch ms: bells, title changes, and
// terminal output from open views. Keys are recencyKey(connectionId, socket).
// Sessions first seen in the initial list after (re)connect are seeded from
// their last bell, since we weren't watching; ones appearing later were just
// created, so they get "now".
const sessionRecency = new Map<string, number>();

// When each session's app last produced output, as LOCAL receive time of the
// server's `activity` push (phone clock — the wire timestamp is host-clock
// and can't be compared against Date.now() across machines). Keys are
// recencyKey(connectionId, socket). A session is "active" (hub rows show an
// animated indicator) while an activity push arrived within the last
// ACTIVITY_ACTIVE_MS; the wrapper reports at most one per 2s while output
// continues, so 5s of slack keeps the indicator lit through the gaps.
const sessionActivity = new Map<string, number>();
const ACTIVITY_ACTIVE_MS = 5_000;
// Alternation period of the hub's activity indicator.
const HUB_ANIMATION_STEP_MS = 800;

function recencyKey(connectionId: string, socket: string): string {
  return `${connectionId}\n${socket}`;
}

function post(message: WorkerAppReply): void {
  global.postMessage(message);
}

// The host queues messages until this arrives: posts to a worker whose bundle
// is still evaluating can be silently dropped (see WorkerAppHost). Top-level
// evaluation is synchronous, so the handler below is installed before any
// queued message can be delivered.
post({ type: "worker-ready" });

global.onmessage = (event: { data: WorkerAppMessage }) => {
  const message = event.data;
  switch (message.type) {
    case "open-window":
      openWindow(message.windowId, message.surfaceId, message.viewport);
      break;
    case "close-window":
      closeWindow(message.windowId);
      break;
    case "input": {
      const window = windows.get(message.windowId);
      if (!window) {
        frameTimings.finishFrame(message.frameId, "discarded: unknown terminal window");
        break;
      }
      window.focused = message.focused;
      // Marks the main-thread -> worker hop, which is otherwise an
      // unexplained gap inside the shell's handle-input span.
      frameTimings.logFrame(message.frameId, `input received in ${message.windowId} worker`);
      handleInput(window, message.event as InputEvent, message.frameId);
      break;
    }
    case "text-input": {
      const window = windows.get(message.windowId);
      // Attached view windows type into their terminal. The hub accepts text
      // only on the Add-connection screen, where it fills the draft (voice
      // input as an alternative to the phone keyboard). submitInput appends
      // Enter ("\r") after a wrapper-side pause so paste-detecting apps
      // (e.g. Claude Code) submit instead of inserting a newline.
      if (window && window.kind === "view") {
        window.client.submitInput(message.text);
      } else if (window && window.kind === "hub" && window.mode === "add") {
        terminalNewConnectionSetting.set(message.text);
        scheduleRender(window);
      }
      break;
    }
    case "render": {
      const window = windows.get(message.windowId);
      if (!window) break;
      window.focused = message.focused;
      renderAndSubmit(window, 0);
      break;
    }
    case "foreground": {
      const window = windows.get(message.windowId);
      if (!window) break;
      window.foreground = message.foreground;
      window.focused = message.focused;
      if (window.foreground && window.kind === "view") {
        activeViewId = window.windowId;
        maybeReconnectView(window);
      }
      if (window.foreground && window.kind === "hub") window.sessionOrder = [];
      if (window.foreground) renderAndSubmit(window, 0);
      updateHubAnimation();
      break;
    }
    case "screen":
      screenOn = message.on;
      if (screenOn) {
        for (const window of windows.values()) {
          if (!window.foreground) continue;
          // Waking counts as becoming visible: let the session list re-sort.
          if (window.kind === "hub") window.sessionOrder = [];
          if (window.kind === "view") maybeReconnectView(window);
          renderAndSubmit(window, 0);
        }
      }
      updateHubAnimation();
      break;
    case "tool-call": {
      const callId = message.callId;
      Promise.resolve(handleTerminalTool(message.name, message.args))
        .then((result) => post({ type: "tool-result", callId, result }))
        .catch((error) =>
          post({
            type: "tool-result",
            callId,
            result: { ok: false, error: String((error as Error)?.message ?? error) },
          }),
        );
      break;
    }
  }
};

// React to setting changes (connections edited here or in another isolate,
// toggles edited in the Settings app, the Add-connection draft typed on the
// phone).
onSettingsStoreChanged((key) => {
  if (!key.startsWith("terminal.")) return;
  switch (key) {
    case TERMINAL_CONNECTIONS_KEY:
      // Only once the app has actually been opened.
      if (controlsInitialized) syncControlsFromSettings();
      renderHubWindows();
      return;
    case NEW_CONNECTION_DRAFT_KEY:
      // Live keystrokes from the phone editor; repaint the add screen.
      renderHubWindows();
      return;
    case "terminal.autoReconnect":
      if (!terminalAutoReconnectSetting.get()) {
        cancelPendingReconnects();
      } else if (windows.size > 0) {
        for (const control of controls.values()) {
          if ((control.state?.phase ?? "idle") === "failed") scheduleControlReconnect(control);
        }
      }
      return;
    default:
      // launchPresets, wakeOnBell: no connection impact.
      return;
  }
});

/** Cancel scheduled retries (auto-reconnect turned off); stale views stay marked. */
function cancelPendingReconnects(): void {
  for (const control of controls.values()) {
    cancelControlReconnect(control);
  }
  for (const window of windows.values()) {
    if (window.kind === "view" && window.reconnectTimer) {
      clearTimeout(window.reconnectTimer);
      window.reconnectTimer = null;
    }
  }
}

function openWindow(windowId: string, surfaceId: string, viewport: { width: number; height: number }): void {
  const pendingView = pendingViews.get(windowId);
  if (pendingView) {
    pendingViews.delete(windowId);
    windows.set(windowId, createViewWindow(windowId, surfaceId, viewport, pendingView));
    renderHubWindows();
    return;
  }
  const hubCell = getTerminalFontConfig();
  windows.set(windowId, {
    kind: "hub",
    windowId,
    surfaceId,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    gridCols: Math.floor(viewport.width / hubCell.cellWidth),
    gridRows: Math.floor(viewport.height / hubCell.cellHeight),
    foreground: false,
    focused: false,
    renderScheduled: false,
    lastSubmittedFingerprint: "",
    menu: null,
    mode: "sessions",
    selectedIndex: 0,
    scrollRow: 0,
    sessionOrder: [],
    addError: "",
  });
  // The hub carries the app's assistant tools; declare them once it exists.
  post({ type: "set-tools", windowId, tools: TERMINAL_TOOLS });
  if (!controlsInitialized) {
    syncControlsFromSettings();
  }
}

function closeWindow(windowId: string): void {
  const window = windows.get(windowId);
  if (!window) return;
  if (window.kind === "view") {
    for (const unsubscribe of window.unsubscribers.splice(0)) {
      unsubscribe();
    }
    if (window.reconnectTimer) {
      clearTimeout(window.reconnectTimer);
      window.reconnectTimer = null;
    }
    window.client.stop();
  }
  if (window.kind === "hub" && window.mode === "add") {
    // Window closed mid-add: shut the phone editor down.
    endAddConnection(window);
  }
  windows.delete(windowId);
  // Auto-reconnect only runs while at least one terminal window is open.
  if (windows.size === 0) {
    for (const control of controls.values()) {
      cancelControlReconnect(control);
    }
  }
  if (activeViewId === windowId) activeViewId = null;
  if (window.kind === "view") {
    renderHubWindows();
  }
}

/** Client options for a connection string; null if the string doesn't parse. */
function clientOptionsFor(connection: TerminalConnection): G2MirrorClientOptions | null {
  const parsed = parseConnectionString(connection.url);
  if (!parsed) return null;
  return {
    ...parsed,
    deviceName: DEVICE_NAME,
    ...viewGrid(),
  };
}

/**
 * Reconcile the live control clients with the stored connection list: start
 * enabled connections, stop disabled or removed ones, restart ones whose
 * connection string changed. Called on first open and whenever the stored
 * list changes (including our own edits). Rebuilds the map in stored order so
 * UI iteration matches the list the user manages.
 */
function syncControlsFromSettings(): void {
  controlsInitialized = true;
  const stored = loadConnections();
  const storedIds = new Set(stored.map((connection) => connection.id));
  for (const [id, control] of Array.from(controls)) {
    if (!storedIds.has(id)) {
      stopControl(control);
      controls.delete(id);
    }
  }
  const previous = new Map(controls);
  controls.clear();
  for (const connection of stored) {
    let control = previous.get(connection.id);
    if (!control) {
      control = {
        config: connection,
        client: null,
        state: null,
        unsubscribers: [],
        reconnectTimer: null,
        reconnectDelayMs: RECONNECT_MIN_DELAY_MS,
        sessionsSeeded: false,
      };
    }
    const urlChanged = control.config.url !== connection.url;
    control.config = connection;
    controls.set(connection.id, control);
    if (connection.enabled && (urlChanged || !control.client)) {
      startControl(control);
    } else if (!connection.enabled && control.client) {
      stopControl(control);
    }
  }
  renderHubWindows();
}

function startControl(control: ControlConnection): void {
  stopControl(control);
  const options = clientOptionsFor(control.config);
  if (!options) {
    control.state = null;
    return;
  }
  const client = new G2MirrorClient(options);
  const connectionId = control.config.id;
  control.client = client;
  control.state = client.state();
  control.sessionsSeeded = false;
  control.unsubscribers.push(
    client.onStateChange((state) => {
      // Only the current client speaks for the control (stopControl clears
      // listeners, but a stop() emits synchronously before that).
      if (control.client !== client) return;
      noteSessionListRecency(control, state);
      control.state = state;
      if (state.phase === "connected") {
        control.reconnectDelayMs = RECONNECT_MIN_DELAY_MS;
        maybeCacheServerName(control, state.serverName);
      }
      if (state.phase === "failed") scheduleControlReconnect(control);
      renderHubWindows();
    }),
    client.onBell((socket, lastBellAtMs) => {
      routeBell(connectionId, socket, lastBellAtMs);
    }),
    client.onTitle((socket) => {
      noteSessionUpdated(connectionId, socket);
    }),
    client.onActivity((socket) => {
      noteSessionActivity(connectionId, socket);
    }),
  );
  client.start();
}

function stopControl(control: ControlConnection): void {
  cancelControlReconnect(control);
  for (const unsubscribe of control.unsubscribers.splice(0)) {
    unsubscribe();
  }
  control.client?.stop();
  control.client = null;
  control.state = null;
}

/**
 * A successful handshake reported the host's server_name; cache it on the
 * stored connection so the hub can name the host even while disconnected.
 * The resulting settings change re-runs syncControlsFromSettings, which sees
 * an unchanged url and leaves the live client alone.
 */
function maybeCacheServerName(control: ControlConnection, serverName: string): void {
  if (!serverName || control.config.serverName === serverName) return;
  control.config.serverName = serverName;
  updateConnection(control.config.id, { serverName });
}

function noteSessionUpdated(connectionId: string, socket: string): void {
  sessionRecency.set(recencyKey(connectionId, socket), Date.now());
}

function noteSessionListRecency(control: ControlConnection, state: G2MirrorState): void {
  const connectionId = control.config.id;
  for (const session of state.sessions) {
    const key = recencyKey(connectionId, session.socket);
    const known = sessionRecency.get(key);
    if (known === undefined) {
      sessionRecency.set(
        key,
        Math.max(session.lastBellAt ?? 0, control.sessionsSeeded ? Date.now() : 0),
      );
    } else if ((session.lastBellAt ?? 0) > known) {
      // A bell rang while we weren't connected to hear it (the live bell
      // message would have advanced the recency); deliver it late so the
      // missed attention flag / wake still happens.
      routeBell(connectionId, session.socket, session.lastBellAt!);
    }
  }
  if (state.sessions.length) control.sessionsSeeded = true;
}

/**
 * Retry a control connection after a backoff delay. The delay doubles per
 * scheduled attempt and resets when a connection reaches "connected" (or on
 * a manual Connect). No-op when auto-reconnect is off, no terminal window is
 * open, or the connection was disabled/removed meanwhile.
 */
function scheduleControlReconnect(control: ControlConnection): void {
  if (control.reconnectTimer) return;
  if (!terminalAutoReconnectSetting.get()) return;
  if (windows.size === 0) return;
  if (!control.config.enabled) return;
  const delayMs = control.reconnectDelayMs;
  control.reconnectDelayMs = Math.min(control.reconnectDelayMs * 2, RECONNECT_MAX_DELAY_MS);
  control.reconnectTimer = setTimeout(() => {
    control.reconnectTimer = null;
    if (!terminalAutoReconnectSetting.get() || windows.size === 0) return;
    if (controls.get(control.config.id) !== control || !control.config.enabled) return;
    if ((control.state?.phase ?? "idle") === "failed") startControl(control);
  }, delayMs);
}

function cancelControlReconnect(control: ControlConnection): void {
  if (control.reconnectTimer) {
    clearTimeout(control.reconnectTimer);
    control.reconnectTimer = null;
  }
}

function routeBell(connectionId: string, socket: string, lastBellAtMs: number): void {
  const key = recencyKey(connectionId, socket);
  const known = sessionRecency.get(key) ?? 0;
  if (lastBellAtMs > known) sessionRecency.set(key, lastBellAtMs);
  for (const window of windows.values()) {
    if (
      window.kind === "view" &&
      window.connectionId === connectionId &&
      window.socket === socket &&
      !window.foreground
    ) {
      post({ type: "set-attention", windowId: window.windowId, attention: true });
    }
  }
  if (terminalWakeOnBellSetting.get()) {
    // Wake to the belling session's view window, or the hub if it has none.
    // The shell drops the message unless the glasses are actually asleep.
    const viewId = viewWindowIdForSocket(connectionId, socket);
    const hubId = [...windows.values()].find((window) => window.kind === "hub")?.windowId ?? null;
    const target = viewId ?? hubId;
    if (target) post({ type: "wake-window", windowId: target });
  }
}

function renderHubWindows(): void {
  for (const window of windows.values()) {
    if (window.kind === "hub") scheduleRender(window);
  }
}

// Hub activity animation: while a foregrounded hub lists at least one active
// session, a timer re-renders it so the per-row indicator alternates. The
// timer stops itself once every session's activity ages out (its final tick
// renders the rows indicator-free) or the hub leaves the foreground.
let hubAnimationPhase = 0;
let hubAnimationTimer: ReturnType<typeof setInterval> | null = null;

function isSessionActive(connectionId: string, socket: string): boolean {
  const at = sessionActivity.get(recencyKey(connectionId, socket));
  return at !== undefined && Date.now() - at < ACTIVITY_ACTIVE_MS;
}

function hubAnimationShouldRun(): boolean {
  if (!screenOn) return false;
  let hubVisible = false;
  for (const window of windows.values()) {
    if (window.kind === "hub" && window.foreground) hubVisible = true;
  }
  if (!hubVisible) return false;
  const now = Date.now();
  for (const at of sessionActivity.values()) {
    if (now - at < ACTIVITY_ACTIVE_MS) return true;
  }
  return false;
}

/** Start or stop the animation timer to match the current state. */
function updateHubAnimation(): void {
  if (hubAnimationShouldRun()) {
    if (hubAnimationTimer) return;
    hubAnimationTimer = setInterval(() => {
      hubAnimationPhase = (hubAnimationPhase + 1) % 2;
      if (!hubAnimationShouldRun() && hubAnimationTimer) {
        clearInterval(hubAnimationTimer);
        hubAnimationTimer = null;
      }
      // Render even on the stopping tick, to clear expired indicators.
      renderHubWindows();
    }, HUB_ANIMATION_STEP_MS);
  } else if (hubAnimationTimer) {
    clearInterval(hubAnimationTimer);
    hubAnimationTimer = null;
  }
}

/** An activity push arrived for a session: mark it and (re)start the animation. */
function noteSessionActivity(connectionId: string, socket: string): void {
  const key = recencyKey(connectionId, socket);
  const wasActive = isSessionActive(connectionId, socket);
  sessionActivity.set(key, Date.now());
  sessionRecency.set(key, Date.now());
  updateHubAnimation();
  // A session just turned active: show its indicator now rather than up to
  // one animation step later.
  if (!wasActive) renderHubWindows();
}

function createViewWindow(
  windowId: string,
  surfaceId: string,
  viewport: { width: number; height: number },
  view: PendingView,
): ViewWindow {
  const { connectionId, socket, label, glyph } = view;
  // Capture the terminal font at open time: the grid dims go into the
  // websocket handshake and the emulator, so they must not change under a
  // live window (a font-setting change applies to the next window).
  const cell = getTerminalFontConfig();
  const gridCols = Math.floor(viewport.width / cell.cellWidth);
  const gridRows = Math.floor(viewport.height / cell.cellHeight);
  const client = new G2MirrorClient({ ...view.options, cols: gridCols, rows: gridRows });
  const window: ViewWindow = {
    kind: "view",
    windowId,
    surfaceId,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    gridCols,
    gridRows,
    font: cell.font,
    cellWidth: cell.cellWidth,
    cellHeight: cell.cellHeight,
    foreground: false,
    focused: false,
    renderScheduled: false,
    lastSubmittedFingerprint: "",
    menu: null,
    connectionId,
    socket,
    label,
    glyph,
    client,
    emulator: new TerminalEmulator(gridCols, gridRows),
    receivedData: false,
    attachRequested: false,
    status: "Connecting...",
    unsubscribers: [],
    historyNext: 0,
    historyOldest: 0,
    archive: [],
    archiveStart: 0,
    scrollTop: null,
    historyFetchInFlight: false,
    needsReconnect: false,
    reconnectTimer: null,
    reconnectDelayMs: RECONNECT_MIN_DELAY_MS,
  };
  window.unsubscribers.push(
    client.onSnapshot((historyNext, historyOldest) => {
      // A (re)snapshot resets the emulator, so reset the scroll model too:
      // follow the bottom and drop any fetched archive (its splice may move).
      window.historyNext = historyNext;
      window.historyOldest = historyOldest;
      window.archive = [];
      window.archiveStart = historyNext;
      window.scrollTop = null;
      window.historyFetchInFlight = false;
      maybePrefetchHistory(window);
      scheduleRender(window);
    }),
    client.onHistoryLines((reply) => {
      applyHistoryReply(window, reply);
      scheduleRender(window);
    }),
    client.onStateChange((state) => {
      if (state.phase === "connected" && !window.attachRequested) {
        window.attachRequested = true;
        client.connectSession(socket);
      }
      if (state.phase === "connected") window.reconnectDelayMs = RECONNECT_MIN_DELAY_MS;
      if (state.phase === "failed") handleViewConnectionLost(window);
      window.status = state.status;
      scheduleRender(window);
    }),
    client.onSessionAttached(() => {
      client.view();
      scheduleRender(window);
    }),
    client.onTerminalData((data, kind) => {
      if (kind === "snapshot") {
        window.emulator.reset();
      }
      window.receivedData = true;
      noteSessionUpdated(window.connectionId, window.socket);
      window.emulator.write(data, () => scheduleRender(window));
    }),
    client.onSessionDetached((reason) => {
      window.status = `Detached (${reason}).`;
      scheduleRender(window);
    }),
  );
  client.start();
  return window;
}

/**
 * The view's websocket dropped. While visible, retry on the backoff schedule;
 * while hidden, leave it stale (needsReconnect) so contents and scrollback
 * only resync once the view is next looked at. Bells still arrive via the
 * control connection either way.
 */
function handleViewConnectionLost(window: ViewWindow): void {
  window.needsReconnect = true;
  if (window.foreground && screenOn && terminalAutoReconnectSetting.get()) {
    scheduleViewReconnect(window);
  }
}

function scheduleViewReconnect(window: ViewWindow): void {
  if (window.reconnectTimer) return;
  const delayMs = window.reconnectDelayMs;
  window.reconnectDelayMs = Math.min(window.reconnectDelayMs * 2, RECONNECT_MAX_DELAY_MS);
  window.reconnectTimer = setTimeout(() => {
    window.reconnectTimer = null;
    if (!windows.has(window.windowId) || !window.needsReconnect) return;
    if (!terminalAutoReconnectSetting.get()) return;
    // Went invisible while waiting: defer to the next foreground/screen-on.
    if (!window.foreground || !screenOn) return;
    reconnectView(window);
  }, delayMs);
}

/** A stale view just became visible (foreground/screen-on): reconnect it now. */
function maybeReconnectView(window: ViewWindow): void {
  if (!window.needsReconnect || window.reconnectTimer) return;
  if (!terminalAutoReconnectSetting.get()) return;
  window.reconnectDelayMs = RECONNECT_MIN_DELAY_MS;
  reconnectView(window);
}

/**
 * Restart the view's websocket. On success the connected handler re-attaches
 * (attachRequested reset here) and the fresh snapshot resets the emulator and
 * scrollback archive, which is the content resync.
 */
function reconnectView(window: ViewWindow): void {
  window.needsReconnect = false;
  window.attachRequested = false;
  window.status = "Reconnecting...";
  window.client.start();
  scheduleRender(window);
}

/** The window's long-press menu, created lazily so window literals stay simple. */
function windowMenu(window: TerminalWindow): WindowMenu {
  if (!window.menu) {
    window.menu = new WindowMenu({
      size: { width: window.viewportWidth, height: window.viewportHeight },
      paintBase: () => paintContent(window),
      isFocused: () => window.focused,
    });
  }
  return window.menu;
}

/** Controls currently connected (handshake accepted), in stored order. */
function connectedControls(): ControlConnection[] {
  return [...controls.values()].filter((control) => {
    const phase = control.state?.phase;
    return phase === "connected" || phase === "attached";
  });
}

function windowMenuItems(window: TerminalWindow): MenuItem[] {
  const items: MenuItem[] = [
    {
      label: "Settings",
      onSelect: (ctx) => {
        ctx.stack.pop();
        post({ type: "open-settings", section: "Terminal" });
      },
    },
  ];
  if (window.kind === "hub") {
    const connected = connectedControls();
    const multiHost = connected.length > 1;
    for (const control of connected) {
      for (const preset of launchPresetNames()) {
        const label = multiHost
          ? `Launch ${preset} @ ${connectionDisplayName(control.config)}`
          : `Launch ${preset}`;
        items.push({
          label,
          onSelect: (ctx) => {
            ctx.stack.pop();
            launchAndOpenView(control, preset).catch((error) => {
              // The hub status line also shows the server's error message.
              console.warn(`terminal launch ${preset} failed: ${error}`);
            });
          },
        });
      }
    }
  } else {
    if (window.client.state().phase === "failed") {
      items.push({
        label: "Reconnect",
        onSelect: (ctx) => {
          ctx.stack.pop();
          if (window.reconnectTimer) {
            clearTimeout(window.reconnectTimer);
            window.reconnectTimer = null;
          }
          window.reconnectDelayMs = RECONNECT_MIN_DELAY_MS;
          reconnectView(window);
        },
      });
    }
    items.push(
      {
        label: "Send <Enter>",
        onSelect: (ctx) => {
          ctx.stack.pop();
          window.client.sendInput("\r");
        },
      },
      {
        label: "Send <Esc>",
        onSelect: (ctx) => {
          ctx.stack.pop();
          window.client.sendInput("\u001b");
        },
      },
    );
  }
  items.push(...defaultWindowMenuItems(window.windowId, post));
  return items;
}

function handleInput(window: TerminalWindow, event: InputEvent, frameId: number): void {
  if (window.kind === "view") activeViewId = window.windowId;
  // An open window menu owns all input (it closes itself via pop).
  if (window.menu?.isOpen()) {
    window.menu
      .handleInput(event)
      .catch((error) => console.error(`terminal menu input failed: ${error}`))
      .then(() => renderAndSubmit(window, frameId));
    return;
  }
  if (event.type === "long-press") {
    windowMenu(window).open(windowMenuItems(window));
    renderAndSubmit(window, frameId);
    return;
  }
  if (event.type === "double-click") {
    // Inside the hub's sub-sections, double-click backs out one level; at the
    // top level (and in views) it yields focus to the sidebar as everywhere.
    if (window.kind === "hub" && window.mode === "add") {
      cancelAddConnection(window);
      renderAndSubmit(window, frameId);
      return;
    }
    if (window.kind === "hub" && window.mode === "connections") {
      setHubMode(window, "sessions");
      renderAndSubmit(window, frameId);
      return;
    }
    frameTimings.finishFrame(frameId, "discarded: terminal yielded focus");
    post({ type: "yield-focus", windowId: window.windowId });
    return;
  }
  if (window.kind === "hub") {
    handleHubInput(window, event, frameId);
    return;
  }
  // View windows: scroll gestures page through scrollback; text input arrives
  // via the separate "text-input" message.
  if (event.type === "scroll-up" || event.type === "scroll-down") {
    handleViewScroll(window, event.type === "scroll-up" ? -1 : 1, frameId);
    return;
  }
  frameTimings.finishFrame(frameId, "discarded: terminal view ignored input");
}

/** Top visible absolute line index when following the live bottom. */
function followTop(window: ViewWindow): number {
  return window.historyNext + window.emulator.bufferLength() - window.gridRows;
}

function handleViewScroll(window: ViewWindow, direction: -1 | 1, frameId: number): void {
  const page = Math.max(1, window.gridRows - 1);
  const bottomTop = followTop(window);
  const minTop = window.archiveStart;
  const currentTop = window.scrollTop ?? bottomTop;
  const newTop = clamp(currentTop + direction * page, Math.min(minTop, bottomTop), bottomTop);
  // Snapping to (or below) the live bottom re-locks to follow mode.
  window.scrollTop = newTop >= bottomTop ? null : newTop;
  maybePrefetchHistory(window);
  renderAndSubmit(window, frameId);
}

/** Fetch an older page of archive when the view nears the top of what's loaded. */
function maybePrefetchHistory(window: ViewWindow): void {
  if (window.historyFetchInFlight) return;
  if (window.archiveStart <= window.historyOldest) return; // nothing older retained
  const top = window.scrollTop ?? followTop(window);
  if (window.archive.length === 0 || top - window.archiveStart <= window.gridRows) {
    window.historyFetchInFlight = true;
    window.client.requestHistory(window.archiveStart, HISTORY_PAGE);
  }
}

function applyHistoryReply(window: ViewWindow, reply: { start: number; oldest: number; lines: string[] }): void {
  window.historyFetchInFlight = false;
  window.historyOldest = reply.oldest;
  if (!reply.lines.length) {
    // Nothing older was returned; stop asking below what we already have.
    window.historyOldest = window.archiveStart;
    return;
  }
  // The page ends just before our request (archiveStart); prepend it.
  if (reply.start < window.archiveStart) {
    window.archive = reply.lines.concat(window.archive);
    window.archiveStart = reply.start;
  }
}

type HubItem = {
  label: string;
  /** Group heading (host name): drawn differently and skipped by selection. */
  heading?: boolean;
  /** Session with recent output: an animated indicator marks the row. */
  active?: boolean;
  onSelect?: () => void;
};

/** Switch the hub between its sections, resetting selection state. */
function setHubMode(window: HubWindow, mode: HubMode): void {
  window.mode = mode;
  window.selectedIndex = 0;
  window.scrollRow = 0;
  window.addError = "";
}

/**
 * One control connection's sessions in this hub window's display order:
 * most-recently-updated first as of when the window became visible, with
 * sessions that appeared since then at the end. The captured order lives in
 * window.sessionOrder (cleared when the window becomes visible; keys are
 * connection-scoped) so the list doesn't reshuffle while the user is looking
 * at it.
 */
function orderedSessions(window: HubWindow, control: ControlConnection): G2MirrorSession[] {
  const connectionId = control.config.id;
  const sessions = control.state?.sessions ?? [];
  const position = new Map<string, number>();
  for (const key of window.sessionOrder) {
    if (!position.has(key)) position.set(key, position.size);
  }
  const fresh = sessions
    .filter((session) => !position.has(recencyKey(connectionId, session.socket)))
    .sort(
      (a, b) =>
        (sessionRecency.get(recencyKey(connectionId, b.socket)) ?? 0) -
        (sessionRecency.get(recencyKey(connectionId, a.socket)) ?? 0),
    );
  for (const session of fresh) {
    const key = recencyKey(connectionId, session.socket);
    position.set(key, position.size);
    window.sessionOrder.push(key);
  }
  return sessions
    .slice()
    .sort(
      (a, b) =>
        position.get(recencyKey(connectionId, a.socket))! - position.get(recencyKey(connectionId, b.socket))!,
    );
}

function hubItems(window: HubWindow): HubItem[] {
  return window.mode === "connections" ? hubConnectionItems(window) : hubSessionItems(window);
}

function hubSessionItems(window: HubWindow): HubItem[] {
  const items: HubItem[] = [
    {
      label: "Manage Connections",
      onSelect: () => setHubMode(window, "connections"),
    },
  ];
  const connected = connectedControls();
  const multiHost = connected.length > 1;
  for (const control of connected) {
    if (multiHost) {
      items.push({ label: connectionDisplayName(control.config), heading: true });
    }
    const sessions = orderedSessions(window, control);
    for (const session of sessions) {
      const openWindowId = viewWindowIdForSocket(control.config.id, session.socket);
      items.push({
        label: openWindowId ? `${sessionLabel(session)}  [open]` : sessionLabel(session),
        active: isSessionActive(control.config.id, session.socket),
        onSelect: () => {
          const windowId = viewWindowIdForSocket(control.config.id, session.socket);
          if (windowId) {
            post({ type: "focus-window", windowId });
          } else {
            openViewWindowFor(control, session);
          }
        },
      });
    }
    if (!sessions.length) {
      items.push({
        label: multiHost ? "(no live sessions)" : "(no live sessions; run g2mirror <command>)",
        onSelect: () => control.client?.listSessions(),
      });
    }
  }
  // Disconnected/failed connections get a one-click Connect shortcut here;
  // full management (remove, add) lives in Manage Connections.
  for (const control of controls.values()) {
    if (connected.includes(control)) continue;
    if (control.config.enabled && control.state?.phase === "connecting") continue;
    items.push({
      label: `Connect ${connectionDisplayName(control.config)}`,
      onSelect: () => connectControl(control),
    });
  }
  return items;
}

function hubConnectionItems(window: HubWindow): HubItem[] {
  const items: HubItem[] = [];
  for (const control of controls.values()) {
    items.push({
      label: `${connectionDisplayName(control.config)}  (${controlStatusWord(control)})`,
      onSelect: () => openConnectionActions(window, control),
    });
  }
  items.push(
    {
      label: "Add connection",
      onSelect: () => beginAddConnection(window),
    },
    {
      label: "Done",
      onSelect: () => setHubMode(window, "sessions"),
    },
  );
  return items;
}

function controlStatusWord(control: ControlConnection): string {
  if (!control.config.enabled) return "off";
  switch (control.state?.phase) {
    case "connected":
    case "attached":
      return "connected";
    case "connecting":
      return "connecting";
    case "failed":
      return control.reconnectTimer ? "retrying" : "failed";
    default:
      return clientOptionsFor(control.config) ? "off" : "bad connection string";
  }
}

/** Per-connection action menu (reuses the window-menu machinery). */
function openConnectionActions(window: HubWindow, control: ControlConnection): void {
  const name = connectionDisplayName(control.config);
  const items: MenuItem[] = [
    control.config.enabled
      ? {
          label: "Disconnect",
          onSelect: (ctx) => {
            ctx.stack.pop();
            disconnectControl(control);
          },
        }
      : {
          label: "Connect",
          onSelect: (ctx) => {
            ctx.stack.pop();
            connectControl(control);
          },
        },
    {
      label: `Remove ${name}`,
      onSelect: (ctx) => {
        ctx.stack.pop();
        removeControl(control);
      },
    },
    {
      label: "Cancel",
      onSelect: (ctx) => {
        ctx.stack.pop();
      },
    },
  ];
  windowMenu(window).open(items);
}

/** Enable and (re)connect now; also the manual retry path, so reset backoff. */
function connectControl(control: ControlConnection): void {
  control.reconnectDelayMs = RECONNECT_MIN_DELAY_MS;
  if (!control.config.enabled) {
    control.config.enabled = true;
    updateConnection(control.config.id, { enabled: true });
  }
  startControl(control);
  renderHubWindows();
}

function disconnectControl(control: ControlConnection): void {
  control.config.enabled = false;
  updateConnection(control.config.id, { enabled: false });
  stopControl(control);
  renderHubWindows();
}

function removeControl(control: ControlConnection): void {
  stopControl(control);
  controls.delete(control.config.id);
  saveConnections(loadConnections().filter((connection) => connection.id !== control.config.id));
  renderHubWindows();
}

/**
 * Enter the Add-connection screen: clear the draft and ask the shell to open
 * the phone text editor on it. The user types (or voice-inputs) the
 * g2mirror:// string, then clicks to save or double-clicks to cancel.
 */
function beginAddConnection(window: HubWindow): void {
  terminalNewConnectionSetting.set("");
  setHubMode(window, "add");
  post({ type: "start-text-setting-edit", settingId: terminalNewConnectionSetting.id });
}

function saveAddConnection(window: HubWindow): void {
  const url = terminalNewConnectionSetting.get();
  if (!parseConnectionString(url)) {
    window.addError = url
      ? "Not a g2mirror://token@host connection string."
      : "Enter a g2mirror:// connection string first.";
    scheduleRender(window);
    return;
  }
  const connections = loadConnections();
  connections.push({ id: `c${Date.now()}`, url, serverName: null, enabled: true });
  saveConnections(connections);
  endAddConnection(window);
  setHubMode(window, "connections");
  // Start it immediately rather than waiting for the settings-change tick.
  syncControlsFromSettings();
}

function cancelAddConnection(window: HubWindow): void {
  endAddConnection(window);
  setHubMode(window, "connections");
}

/** Common teardown for leaving the add screen: clear draft, close phone editor. */
function endAddConnection(window: HubWindow): void {
  window.addError = "";
  terminalNewConnectionSetting.set("");
  post({ type: "end-text-setting-edit" });
}

/** Move the hub selection to the next selectable item in `direction`. */
function moveHubSelection(window: HubWindow, items: HubItem[], direction: -1 | 1): void {
  let index = window.selectedIndex + direction;
  while (index >= 0 && index < items.length && !items[index]!.onSelect) {
    index += direction;
  }
  if (index >= 0 && index < items.length) {
    window.selectedIndex = index;
  }
}

/** Clamp the selection into range and off heading rows (prefer moving down). */
function clampHubSelection(window: HubWindow, items: HubItem[]): void {
  if (!items.length) {
    window.selectedIndex = 0;
    return;
  }
  let index = Math.max(0, Math.min(window.selectedIndex, items.length - 1));
  if (!items[index]!.onSelect) {
    let forward = index;
    while (forward < items.length && !items[forward]!.onSelect) forward++;
    let backward = index;
    while (backward >= 0 && !items[backward]!.onSelect) backward--;
    index = forward < items.length ? forward : Math.max(0, backward);
  }
  window.selectedIndex = index;
}

function handleHubInput(window: HubWindow, event: InputEvent, frameId: number): void {
  if (window.mode === "add") {
    if (event.type === "click") {
      saveAddConnection(window);
      renderAndSubmit(window, frameId);
      return;
    }
    frameTimings.finishFrame(frameId, "discarded: terminal add-connection ignored input");
    return;
  }
  const items = hubItems(window);
  clampHubSelection(window, items);
  switch (event.type) {
    case "scroll-up":
      moveHubSelection(window, items, -1);
      renderAndSubmit(window, frameId);
      return;
    case "scroll-down":
      moveHubSelection(window, items, 1);
      renderAndSubmit(window, frameId);
      return;
    case "click": {
      const item = items[window.selectedIndex];
      item?.onSelect?.();
      renderAndSubmit(window, frameId);
      return;
    }
    default:
      frameTimings.finishFrame(frameId, "discarded: terminal hub ignored input");
      return;
  }
}

/**
 * Window id of the view already showing this session's terminal, if any.
 * Includes views that were requested but whose surface hasn't opened yet, so
 * a quick double-select can't spawn two windows for one session.
 */
function viewWindowIdForSocket(connectionId: string, socket: string): string | null {
  for (const window of windows.values()) {
    if (window.kind === "view" && window.connectionId === connectionId && window.socket === socket) {
      return window.windowId;
    }
  }
  for (const [windowId, pending] of pendingViews) {
    if (pending.connectionId === connectionId && pending.socket === socket) return windowId;
  }
  return null;
}

function openViewWindowFor(control: ControlConnection, session: G2MirrorSession): void {
  openViewWindow(control, session.socket, sessionLabel(session));
}

/**
 * Lowest unused sidebar-icon character for a new view window (its terminal
 * icon shows ">N"). Glyphs free up when their window closes, since usage is
 * recomputed from the live windows; "" (plain ">_" icon) if all are taken.
 */
function allocateViewGlyph(): string {
  const used = new Set<string>();
  for (const window of windows.values()) {
    if (window.kind === "view") used.add(window.glyph);
  }
  for (const pending of pendingViews.values()) used.add(pending.glyph);
  for (const glyph of TERMINAL_ICON_GLYPHS) {
    if (!used.has(glyph)) return glyph;
  }
  return "";
}

function openViewWindow(control: ControlConnection, socket: string, label: string): void {
  const options = clientOptionsFor(control.config);
  if (!options) return;
  const windowId = `terminal:view:${nextViewSerial++}`;
  const glyph = allocateViewGlyph();
  pendingViews.set(windowId, { connectionId: control.config.id, socket, label, glyph, options });
  post({
    type: "open-window-request",
    windowId,
    title: label,
    iconLetter: "T",
    icon: "terminal",
    iconGlyph: glyph || undefined,
    focus: true,
    // Terminal views are the one full-height window kind: more rows matter
    // more than a small on-screen footprint.
    heightMode: "max",
  });
}

/** Preset names the user listed in Settings > Terminal (the wire protocol has no way to enumerate the server's). */
function launchPresetNames(): string[] {
  const names: string[] = [];
  for (const piece of terminalLaunchPresetsSetting.get().split(",")) {
    const name = piece.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Launch a preset on a host and open a view window on the new session. */
async function launchAndOpenView(control: ControlConnection, preset: string): Promise<string> {
  if (!control.client) throw new Error("Not connected to the g2mirror server.");
  const socket = await control.client.launchSession(preset);
  openViewWindow(control, socket, preset);
  return socket;
}

function paint(window: TerminalWindow): Plane[] {
  if (window.menu?.isOpen()) {
    return window.menu.paint();
  }
  return singlePlane(paintContent(window));
}

function paintContent(window: TerminalWindow): GrayImage {
  return window.kind === "hub" ? paintHub(window) : paintView(window);
}

function paintHub(window: HubWindow): GrayImage {
  if (window.mode === "add") {
    return paintAddConnection(window);
  }
  const image = new GrayImage(window.viewportWidth, window.viewportHeight, 0);
  const font = chromeFont();
  const step = lineStep(font);
  // No border box: the shell chrome (top bar + sidebar) already frames the app.
  // Title and status share the top line.
  const title = window.mode === "connections" ? "Terminal - Connections" : "Terminal";
  image.drawText(font, 18, 10, title, 220);
  const statusX = 18 + font.measureText(title) + 16;
  image.drawText(font, statusX, 10, truncateText(font, hubStatusLine(window), Math.max(0, window.viewportWidth - statusX - 12)), 170);

  let listTop = 16 + step;
  if (window.mode === "sessions" && controls.size === 0) {
    image.drawText(font, 24, listTop, "Add a g2mirror:// connection to get started, see:", 150);
    image.drawText(font, 24, listTop + step, "https://github.com/jimrandomh/g2mirror", 190);
    listTop += 2 * step + 6;
  }

  const items = hubItems(window);
  clampHubSelection(window, items);
  const hubRowH = listRowHeight(chromeFont());
  const visibleRowCount = Math.max(1, ((window.viewportHeight - 6 - listTop) / hubRowH) | 0);
  window.scrollRow = scrollToKeepSelectionVisible(window.scrollRow, window.selectedIndex, visibleRowCount, items.length);
  const lastVisibleRow = Math.min(items.length, window.scrollRow + visibleRowCount);
  for (let index = window.scrollRow; index < lastVisibleRow; index++) {
    const y = listTop + (index - window.scrollRow) * hubRowH;
    const item = items[index]!;
    if (item.heading) {
      image.drawText(chromeFont(), 20, y + 2, item.label, 140);
      continue;
    }
    const selected = index === window.selectedIndex;
    if (selected) {
      // Match the shell convention: fill only when this window has focus, so
      // an outline-only selection signals the sidebar owns input.
      drawSelectionHighlight(image, 20, y - 2, window.viewportWidth - 40, hubRowH - 1, window.focused, 8);
    }
    image.drawText(chromeFont(), 32, y + 2, item.label, selected ? 255 : 200);
    if (item.active) {
      // Activity indicator in the gutter left of the label, alternating
      // filled/outline each animation step (drawn shapes, not a font glyph,
      // so the two states render distinctly in every UI font).
      const size = 6;
      const iy = y + 2 + Math.max(0, ((font.lineHeight - size) / 2) | 0);
      const value = selected ? 255 : 200;
      if (hubAnimationPhase === 0) {
        image.fillRect(22, iy, size, size, value);
      } else {
        image.drawRect(22, iy, size, size, value);
      }
    }
  }
  if (items.length > visibleRowCount) {
    drawListScrollbar(
      image,
      window.viewportWidth - 10,
      listTop,
      visibleRowCount * hubRowH - 4,
      window.scrollRow,
      visibleRowCount,
      items.length,
    );
  }

  return image;
}

function paintAddConnection(window: HubWindow): GrayImage {
  const image = new GrayImage(window.viewportWidth, window.viewportHeight, 0);
  const font = chromeFont();
  const step = lineStep(font);
  image.drawText(font, 18, 10, "Add connection", 220);
  const instructionsY = 20 + step;
  image.drawText(font, 24, instructionsY, "Type the g2mirror://token@host string in the", 170);
  image.drawText(font, 24, instructionsY + step, "phone app (or use voice input from the menu).", 170);
  const draftY = instructionsY + 3 * step;
  const draft = terminalNewConnectionSetting.get();
  image.drawText(font, 24, draftY, truncateLabel(draft || "(empty)", 52), 220);
  if (window.addError) {
    image.drawText(font, 24, draftY + step + 6, window.addError, 150);
  }
  image.drawText(font, 24, window.viewportHeight - font.lineHeight - 12, `click save  ${GESTURE_DOUBLE_CLICK} cancel`, 110);
  return image;
}

function truncateLabel(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function hubStatusLine(window: HubWindow): string {
  if (window.mode === "connections") {
    return "Select a connection to connect, disconnect, or remove.";
  }
  if (controls.size === 0) {
    return "No connections configured.";
  }
  const anyRetrying = [...controls.values()].some((control) => control.reconnectTimer);
  if (controls.size === 1) {
    const control = [...controls.values()][0]!;
    const status = control.config.enabled ? (control.state?.status ?? "Not connected.") : "Disconnected.";
    return anyRetrying ? `${status} Retrying...` : status;
  }
  const summary = `${connectedControls().length} of ${controls.size} hosts connected.`;
  return anyRetrying ? `${summary} Retrying...` : summary;
}

/**
 * Draw one terminal row at a fixed integer cell pitch, so glyph columns stay
 * aligned with the emulator's grid arithmetic even when a TTF face has
 * fractional advances. Identical to drawText for the 6px bitmap default.
 */
function drawGridRow(
  image: GrayImage,
  font: UiFont,
  cellWidth: number,
  rowY: number,
  text: string,
  value: number,
): void {
  let col = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 32;
    if (codePoint !== 32) {
      const glyph = font.getGlyph(codePoint);
      if (glyph && glyph.bbxWidth > 0) {
        image.drawGlyph(font, glyph, col * cellWidth, rowY, value);
      }
    }
    col++;
  }
}

function paintView(window: ViewWindow): GrayImage {
  const image = new GrayImage(window.viewportWidth, window.viewportHeight, 0);
  if (!window.receivedData) {
    const font = chromeFont();
    image.drawText(font, 24, 110, window.status, 170);
    return image;
  }

  const rows = window.gridRows;
  const historyNext = window.historyNext;
  const bufferLength = window.emulator.bufferLength();
  const bottomTop = historyNext + bufferLength - rows;
  const following = window.scrollTop === null;
  const top = following ? bottomTop : clamp(window.scrollTop!, window.archiveStart, bottomTop);

  // Draw the cursor only if its line is within the visible window.
  const cursorScreenRow = historyNext + window.emulator.cursorRow() - top;
  if (cursorScreenRow >= 0 && cursorScreenRow < rows) {
    image.fillRect(window.emulator.cursorCol() * window.cellWidth, cursorScreenRow * window.cellHeight, window.cellWidth, window.cellHeight, 70);
  }

  // Stale content stays visible across a disconnect, so flag it: a status
  // line over the bottom row whenever the session isn't actually attached.
  // Text is deferred glyphs (always on top of raster), so the covered rows
  // must be suppressed rather than painted over.
  const statusBannerY = window.client.state().phase !== "attached"
    ? window.viewportHeight - window.cellHeight
    : null;

  for (let row = 0; row < rows; row++) {
    const rowY = row * window.cellHeight;
    if (statusBannerY !== null && rowY + window.cellHeight > statusBannerY) continue;
    const absolute = top + row;
    let text = "";
    if (absolute >= historyNext) {
      const bufferIndex = absolute - historyNext;
      if (bufferIndex >= 0 && bufferIndex < bufferLength) text = window.emulator.lineAt(bufferIndex);
    } else if (absolute >= window.archiveStart) {
      text = window.archive[absolute - window.archiveStart] ?? "";
    }
    if (text.length) drawGridRow(image, window.font, window.cellWidth, rowY, text, 200);
  }

  if (!following) {
    drawScrollIndicator(image, top, window.archiveStart, bottomTop);
  }
  if (statusBannerY !== null) {
    image.fillRect(0, statusBannerY, window.viewportWidth, window.cellHeight, 0);
    image.drawText(chromeFont(), 0, statusBannerY, window.status, 170);
  }
  return image;
}

/** Right-edge scrollbar showing the view position within the scrollback. */
function drawScrollIndicator(image: GrayImage, top: number, minTop: number, maxTop: number): void {
  const trackX = image.width - 3;
  image.fillRect(trackX, 0, 3, image.height, 30);
  const fraction = clamp((top - minTop) / Math.max(1, maxTop - minTop), 0, 1);
  const thumbHeight = 24;
  const thumbY = Math.round((image.height - thumbHeight) * fraction);
  image.fillRect(trackX, thumbY, 3, thumbHeight, 150);
}

/** Coalesce bursty repaint triggers (terminal output) into ~30fps renders. */
function scheduleRender(window: TerminalWindow): void {
  if (window.renderScheduled) return;
  window.renderScheduled = true;
  setTimeout(() => {
    window.renderScheduled = false;
    renderAndSubmit(window, 0);
  }, RENDER_COALESCE_MS);
}

function renderAndSubmit(window: TerminalWindow, inputFrameId: number): void {
  if (!window.foreground || !screenOn) {
    frameTimings.finishFrame(inputFrameId, "discarded: terminal window not visible");
    return;
  }
  const frameId = inputFrameId > 0 ? inputFrameId : frameTimings.startFrame(`render:${window.windowId}`);
  try {
    const paintStartedAtMs = Date.now();
    const planes = frameTimings.span(frameId, "paint", () =>
      frameTimings.runWithFrame(frameId, () => paint(window)),
    );
    const paintMs = Date.now() - paintStartedAtMs;
    const fingerprint = planesFingerprint(planes);
    if (fingerprint === window.lastSubmittedFingerprint) {
      frameTimings.finishFrame(frameId, "discarded: terminal content unchanged");
      return;
    }
    const communicator = getActiveDisplay();
    if (!communicator) {
      frameTimings.finishFrame(frameId, "discarded: no active display");
      return;
    }
    const { image, draws } = frameTimings.span(frameId, "flatten", () => flattenPlanesWithDraws(planes));
    const buffer = frameTimings.span(frameId, "to8bpp", () => image.to8bppBuffer());
    communicator.submitSurfaceFrame(
      buffer.buffer,
      window.surfaceId,
      0,
      0,
      image.width,
      image.height,
      fingerprint,
      paintMs,
      frameId,
      frameTimings.span(frameId, "prepareFrameDraws", () => prepareFrameDraws(draws)),
    );
    window.lastSubmittedFingerprint = fingerprint;
  } catch (error) {
    frameTimings.finishFrame(frameId, "discarded: terminal render failed");
    console.error(`terminal worker render failed: ${error}`);
  }
}

function sessionLabel(session: G2MirrorSession): string {
  if (session.title) {
    return session.title;
  }
  const hint = session.cwdHint.replace(/^_+/, "").replace(/_+/g, "/");
  return hint || "session";
}

/** Dispatch an assistant tool-call (unprefixed name) to its handler. */
function handleTerminalTool(name: string, args: any): ToolResult | Promise<ToolResult> {
  switch (name) {
    case "list_sessions":
      return toolListSessions();
    case "send_input":
      return toolSendInput(args);
    case "read_screen":
      return toolReadScreen();
    case "list_launch_presets":
      return toolListLaunchPresets();
    case "launch_session":
      return toolLaunchSession(args);
    default:
      return { ok: false, error: `Unknown terminal tool: ${name}` };
  }
}

function toolListLaunchPresets(): ToolResult {
  const presets = launchPresetNames();
  if (!presets.length) {
    return { ok: true, content: "No launch presets configured (Settings > Terminal > Launch presets)." };
  }
  return { ok: true, content: presets.map((preset) => `- ${preset}`).join("\n") };
}

/**
 * Pick the host a launch_session call targets: by (partial) server-name match
 * when `host` is given, else the sole connected host; ambiguity is an error
 * listing the choices.
 */
function resolveLaunchControl(host: string): ControlConnection | { error: string } {
  const connected = connectedControls();
  if (!connected.length) return { error: "Not connected to any g2mirror server." };
  if (host) {
    const matches = connected.filter((control) =>
      connectionDisplayName(control.config).toLowerCase().includes(host.toLowerCase()),
    );
    if (matches.length === 1) return matches[0]!;
    return {
      error: `Host "${host}" ${matches.length ? "is ambiguous among" : "does not match any of"}: ${connected
        .map((control) => connectionDisplayName(control.config))
        .join(", ")}`,
    };
  }
  if (connected.length === 1) return connected[0]!;
  return {
    error: `Multiple hosts connected; pass host: ${connected
      .map((control) => connectionDisplayName(control.config))
      .join(", ")}`,
  };
}

async function toolLaunchSession(args: any): Promise<ToolResult> {
  const preset = String(args?.preset ?? "").trim();
  if (!preset) return { ok: false, error: "launch_session requires a preset name." };
  const control = resolveLaunchControl(String(args?.host ?? "").trim());
  if ("error" in control) return { ok: false, error: control.error };
  const socket = await launchAndOpenView(control, preset);
  return { ok: true, content: `Launched "${preset}" (session ${socket}) and opened a window viewing it.` };
}

function toolListSessions(): ToolResult {
  const connected = connectedControls();
  const multiHost = connected.length > 1;
  const lines: string[] = [];
  for (const control of connected) {
    const sessions = control.state?.sessions ?? [];
    if (multiHost) {
      lines.push(`${connectionDisplayName(control.config)}:`);
    }
    for (const session of sessions) {
      const open = viewWindowIdForSocket(control.config.id, session.socket) ? " [open]" : "";
      lines.push(`- ${sessionLabel(session)}${open}`);
    }
    if (!sessions.length && multiHost) {
      lines.push("- (no live sessions)");
    }
  }
  if (!lines.length) {
    return { ok: true, content: "No live terminal sessions (run g2mirror <command> on a host)." };
  }
  return { ok: true, content: lines.join("\n") };
}

function toolSendInput(args: any): ToolResult {
  const text = String(args?.text ?? "");
  if (!text) return { ok: false, error: "send_input requires non-empty text." };
  const view = resolveActiveView();
  if (!view) return { ok: false, error: "No terminal session is open to send input to." };
  view.client.submitInput(text);
  return { ok: true, content: `Sent to ${view.label}.` };
}

function toolReadScreen(): ToolResult {
  const view = resolveActiveView();
  if (!view) return { ok: false, error: "No terminal session is open." };
  const length = view.emulator.bufferLength();
  const start = Math.max(0, length - view.gridRows);
  const lines: string[] = [];
  for (let index = start; index < length; index++) {
    lines.push(view.emulator.lineAt(index));
  }
  const text = lines.join("\n").replace(/\s+$/, "");
  return { ok: true, content: text || "(screen is empty)" };
}

/**
 * The terminal view an `open`-tier tool acts on: a foregrounded view if any,
 * else the last view to be active, else the sole open view. Null when no view
 * is open (the model gets a tool error it can relay).
 */
function resolveActiveView(): ViewWindow | null {
  const views: ViewWindow[] = [];
  let foreground: ViewWindow | null = null;
  for (const window of windows.values()) {
    if (window.kind !== "view") continue;
    views.push(window);
    if (window.foreground) foreground = window;
  }
  if (foreground) return foreground;
  if (activeViewId) {
    const window = windows.get(activeViewId);
    if (window && window.kind === "view") return window;
  }
  return views.length === 1 ? views[0]! : null;
}
