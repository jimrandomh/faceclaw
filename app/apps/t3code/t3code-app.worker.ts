/**
 * T3 Code app, hosted in its own worker thread: a glasses client for T3 Code
 * (https://github.com/pingdotgg/t3code), the agent-harness server that runs
 * Claude Code, Codex and friends on a computer.
 *
 * One window ("t3code:main") moves between screens:
 * - list: every thread across the paired environments, needing-you first
 *   (approvals and questions), then working, then recent; snoozed and
 *   settled threads fold away. Unconnected environments get a heading with
 *   their state and a way to retry or re-pair.
 * - thread: one conversation, following its tail as the agent works.
 *   Scroll reads back; click answers a pending approval/question, otherwise
 *   opens the voice dialog to reply. Voice and phone-keyboard text become a
 *   follow-up message (queued while the agent is busy, or steering it when
 *   chosen from the menu). Tap-then-hold has Stop, Settle, etc.
 * - environments / pair: manage paired servers; pairing takes the link from
 *   `t3 pair`, typed into the phone app's text editor.
 * - compose: the first message of a new thread in a chosen project.
 * Double-click backs out a level, and from the list yields focus.
 *
 * Connections (one T3EnvironmentClient per paired environment) live while the
 * window is open, and also with no window while the Glanceboard shows the
 * T3 Code widget (the app's boot hook spawns this worker for it). Either way
 * the worker publishes a thread-list snapshot for that widget. Frames are
 * painted here and submitted straight to the compositor from this worker's
 * thread.
 */
import "@nativescript/core/globals";
import { finishWorkerShutdown } from "../../ui/shell/worker-lifecycle";
import { GrayImage, type UiFont } from "../../graphics/image";
import { flattenPlanesWithDraws, planesFingerprint, type Plane } from "../../graphics/plane";
import { prepareFrameDraws } from "../../graphics/glyph-wire";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { truncateText, wrapText } from "../../graphics/textwrap";
import * as frameTimings from "../../native/frame-timings";
import { getActiveDisplay } from "../../native/active-display";
import { onSettingsStoreChanged } from "../../native/settings-store";
import { openSocket } from "../../native/socket";
import { fetchWithUserAgent } from "../../util/http";
import { drawSubmenuIndicator, submenuItem, type MenuItem } from "../../ui/menu";
import { Menu, type MenuDrawArgs } from "../../ui/menu-core";
import { lineStep, listRowHeight } from "../../ui/metrics";
import { WindowMenu, WindowMenuLayer } from "../../ui/window-menu";
import type { WorkerAppMessage, WorkerAppReply } from "../../ui/shell/worker-window";
import type { ToolResult, ToolSpec } from "../../assistant/tool-registry";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, type InputEvent } from "../../ui/gestures";
import {
  t3codePairingLinkSetting,
  t3codeWakeOnAttentionSetting,
  toggleSettingMenuItem,
} from "../../ui/dashboard-settings";
import { exchangePairingCredential, fetchEnvironmentDescriptor, T3_ORCHESTRATION_PROTOCOL, type T3Fetch } from "./t3-auth";
import { errorMessage, T3EnvironmentClient, type StoredEnvironment, type ThreadHandle } from "./t3-client";
import { loadEnvironments, removeEnvironment, T3_ENVIRONMENTS_KEY, upsertEnvironment } from "./t3-environments";
import { hasT3BackgroundWork } from "./background";
import { buildGlanceSnapshot, glanceSummary, T3_GLANCE_STATE_KEY } from "./t3-glance";
import {
  approvalOptions,
  approvalResponseCommand,
  defaultModelSelection,
  describeRequest,
  formatAge,
  interruptCommand,
  isThreadSettled,
  isThreadUnread,
  launchThreadPayload,
  messageDispatchCommand,
  optionAnswer,
  plainMarkdown,
  providerDisplayName,
  questionAnswerCommand,
  sectionThreads,
  settleCommand,
  threadActivityMs,
  threadMarker,
  threadStatus,
  threadStatusLabel,
  timelineEntries,
  visitCommand,
  type PendingRequest,
  type T3ProjectShell,
  type T3ThreadShell,
  type T3ThreadStatus,
} from "./t3-model";
import { parsePairingInput, baseUrlLabel } from "./t3-pairing";
import type { RpcSocketFactory } from "./t3-rpc";
import { TranscriptLayout } from "./t3-transcript";

declare const global: any;

const APP_TITLE = "T3 Code";
/** Storage key of t3codePairingLinkSetting (the phone editor types into it). */
const PAIRING_DRAFT_KEY = "t3code.pairingDraft";
/** Coalesce stream-driven repaints: agents can update several times a second, and frames cost BLE bandwidth. */
const DATA_RENDER_COALESCE_MS = 150;
/** Repaint relative times ("5m") on the list while it's showing. */
const LIST_REFRESH_MS = 30_000;
const VISIT_THROTTLE_MS = 10_000;
/** How long a transient status ("Sent", an error) stays in a footer. */
const NOTICE_MS = 6_000;
const SETTLED_SHOWN = 25;
const LIST_LEFT = 12;
const LIST_RIGHT = 20;
const TITLE_X = 18;
const TITLE_Y = 10;
const BODY_LEFT = 14;
const BODY_RIGHT = 18;

function font(): UiFont {
  return getDefaultSmallFont();
}

// ---------------------------------------------------------------------------
// State

type Screen =
  | { kind: "list" }
  | { kind: "thread"; envId: string; threadId: string }
  | { kind: "environments" }
  | { kind: "pair"; repairId: string | null }
  | { kind: "compose"; envId: string; projectId: string };

type AppWindow = {
  windowId: string;
  surfaceId: string;
  viewportWidth: number;
  viewportHeight: number;
  foreground: boolean;
  focused: boolean;
  menu: WindowMenu | null;
  lastSubmittedFingerprint: string;
  renderTimer: ReturnType<typeof setTimeout> | null;
};

/** A question request being answered one question at a time. */
type QuestionFlow = {
  pending: PendingRequest;
  index: number;
  answers: Record<string, string | string[]>;
};

type ThreadView = {
  envId: string;
  threadId: string;
  handle: ThreadHandle;
  layout: TranscriptLayout;
  /** Index of the top visible line, or null to follow the tail. */
  firstLine: number | null;
  maxFirstLine: number;
  /** The next text input steers the active run instead of queueing. */
  steerNext: boolean;
  /** The next text input answers this question (voice "Answer by voice"). */
  voiceAnswer: QuestionFlow | null;
  lastVisitMs: number;
  lastSeenCompletion: string | null;
};

type ListItem = {
  key: string;
  kind: "heading" | "thread" | "action";
  label: string;
  /** Dim text at the right edge (project, age, status). */
  right?: string;
  /** Status marker drawn left of a thread title. */
  marker?: string;
  markerValue?: number;
  submenu?: boolean;
  onSelect?: () => void;
};

let window: AppWindow | null = null;
let screen: Screen = { kind: "list" };
let screenOn = true;
let threadView: ThreadView | null = null;
let listMenu: Menu<ListItem> | null = null;
let listSelectionKey: string | null = null;
let showSettled = false;
let showSnoozed = false;
let listRefreshTimer: ReturnType<typeof setInterval> | null = null;
/** Transient footer status (sent, failed, ...), with when it expires. */
let notice: { text: string; untilMs: number } | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
/** Pair / compose screen progress and errors. */
let busyText = "";
let screenError = "";

const clients = new Map<string, T3EnvironmentClient>();
const clientUnsubscribers = new Map<string, () => void>();
/** The label last saved for each environment. */
const persistedLabels = new Map<string, string>();
/** Last seen status per thread, for attention alerts (keyed `${envId}\n${threadId}`). */
const knownStatus = new Map<string, { status: T3ThreadStatus; requestId: string | null }>();
/** Environments whose first thread list has been seen (no alerts for what was already pending). */
const attentionBaselined = new Set<string>();

const fetchAdapter: T3Fetch = (url, init) => fetchWithUserAgent(url, init);

const socketFactory: RpcSocketFactory = (url, handlers) => {
  let ended = false;
  const end = (reason: string) => {
    if (ended) return;
    ended = true;
    handlers.onClose(reason);
  };
  const socket = openSocket(url, {
    onOpen: () => handlers.onOpen(),
    onTextMessage: (text) => handlers.onMessage(text),
    onClosed: (code, reason) => end(reason || `Connection closed (${code}).`),
    onFailure: (message) => end(describeSocketFailure(message)),
  });
  return {
    send: (text) => {
      socket.sendText(text);
    },
    close: () => {
      ended = true;
      socket.close(1000, "closing");
    },
  };
};

function describeSocketFailure(message: string): string {
  const text = String(message).replace(/^[\w.]*(Exception|Error):\s*/, "");
  if (/Expected HTTP 101 response but was '401/.test(text)) return "The server rejected the sign-in.";
  if (/Failed to connect|ECONNREFUSED|Connection refused/i.test(text)) return "Can't reach the server.";
  if (/timeout/i.test(text)) return "Connection timed out.";
  return text || "Connection failed.";
}

function clientOs(): string {
  return global.isIOS ? "iOS" : "Android";
}

function post(message: WorkerAppReply): void {
  global.postMessage(message);
}

// ---------------------------------------------------------------------------
// Assistant tools

const T3_TOOLS: ToolSpec[] = [
  {
    name: "list_threads",
    description:
      "List the T3 Code agent threads (coding-agent conversations on the user's computers) with their status: needs approval, has a question, working, ready, failed.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    availability: "open",
  },
  {
    name: "read_thread",
    description: "Read the recent conversation of a T3 Code thread, found by matching its title.",
    inputSchema: {
      type: "object",
      properties: { thread: { type: "string", description: "Part of the thread's title." } },
      required: ["thread"],
      additionalProperties: false,
    },
    availability: "open",
    timeoutMs: 14_000,
  },
  {
    name: "send_message",
    description:
      "Send a follow-up message to a T3 Code thread's agent, found by matching its title (or the thread open on the glasses when omitted). Queued if the agent is busy.",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "Part of the thread's title; omit for the thread currently open." },
        text: { type: "string", description: "The message to send." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    availability: "open",
    timeoutMs: 14_000,
  },
  {
    name: "start_thread",
    description: "Start a new T3 Code thread in a project (found by matching its name) with a first message for the agent.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Part of the project's name." },
        text: { type: "string", description: "The task for the agent." },
      },
      required: ["project", "text"],
      additionalProperties: false,
    },
    availability: "open",
    timeoutMs: 14_000,
  },
];

// ---------------------------------------------------------------------------
// Worker messages

// The host queues messages until this arrives: posts to a worker whose bundle
// is still evaluating can be silently dropped (see WorkerAppHost).
post({ type: "worker-ready" });

global.onmessage = (event: { data: WorkerAppMessage }) => {
  const message = event.data;
  switch (message.type) {
    case "check-idle":
      reportIdle();
      break;
    case "shutdown":
      stopAllClients();
      finishWorkerShutdown();
      break;
    case "open-window":
      window = {
        windowId: message.windowId,
        surfaceId: message.surfaceId,
        viewportWidth: message.viewport.width,
        viewportHeight: message.viewport.height,
        foreground: false,
        focused: false,
        menu: null,
        lastSubmittedFingerprint: "",
        renderTimer: null,
      };
      post({ type: "set-tools", windowId: message.windowId, tools: T3_TOOLS });
      syncClients();
      updateListRefreshTimer();
      break;
    case "resize-window":
      if (!window || window.windowId !== message.windowId) break;
      window.viewportWidth = message.viewport.width;
      window.viewportHeight = message.viewport.height;
      window.menu?.resize(message.viewport);
      window.lastSubmittedFingerprint = "";
      render();
      break;
    case "close-window":
      if (!window || window.windowId !== message.windowId) break;
      leaveScreenSideEffects();
      window.menu?.close();
      if (window.renderTimer) clearTimeout(window.renderTimer);
      window = null;
      closeThreadView();
      screen = { kind: "list" };
      // The Glanceboard widget may still want the connections.
      if (!hasT3BackgroundWork()) stopAllClients();
      updateListRefreshTimer();
      break;
    case "input":
      if (!window || window.windowId !== message.windowId) {
        frameTimings.finishFrame(message.frameId, "discarded: unknown t3code window");
        break;
      }
      window.focused = message.focused;
      inferForeground(message.focused);
      frameTimings.logFrame(message.frameId, `input received in ${message.windowId} worker`);
      handleInput(window, message.event as InputEvent, message.frameId);
      break;
    case "text-input":
      if (window && window.windowId === message.windowId) handleTextInput(message.text.trim());
      break;
    case "render":
      if (!window || window.windowId !== message.windowId) break;
      window.focused = message.focused;
      inferForeground(message.focused);
      renderNow();
      break;
    case "foreground":
      if (!window || window.windowId !== message.windowId) break;
      window.foreground = message.foreground;
      window.focused = message.focused;
      updateListRefreshTimer();
      if (window.foreground) {
        maybeVisitThread(false);
        renderNow();
      }
      break;
    case "screen":
      screenOn = message.on;
      updateListRefreshTimer();
      if (screenOn) renderNow();
      break;
    case "tool-call": {
      const callId = message.callId;
      Promise.resolve(handleTool(message.name, message.args))
        .then((result) => post({ type: "tool-result", callId, result }))
        .catch((error) => post({ type: "tool-result", callId, result: { ok: false, error: errorMessage(error) } }));
      break;
    }
    case "input-focus":
    case "navigation-sensors":
      break;
  }
};

/** Input and render messages only reach the foreground window; backstops a lost "foreground". */
function inferForeground(focused: boolean): void {
  if (!focused || !window || window.foreground) return;
  window.foreground = true;
  updateListRefreshTimer();
}

onSettingsStoreChanged((key) => {
  if (key.startsWith("glanceboard.")) {
    // The widget was added or removed, or the board switched on or off.
    if (!window) {
      if (hasT3BackgroundWork()) syncClients();
      else {
        stopAllClients();
        reportIdle();
      }
    }
    return;
  }
  if (key === T3_ENVIRONMENTS_KEY) {
    if (window || hasT3BackgroundWork()) syncClients();
    else reportIdle();
    render();
  } else if (key === PAIRING_DRAFT_KEY) {
    // Live keystrokes from the phone editor.
    if (screen.kind === "pair") render();
  } else if (key.startsWith("t3code.")) {
    render();
  }
});

// ---------------------------------------------------------------------------
// Environments and clients

/** Reconcile live clients with the stored environment list (start, stop, update). */
function syncClients(): void {
  const stored = loadEnvironments();
  const ids = new Set(stored.map((environment) => environment.id));
  for (const [id, client] of clients) {
    if (ids.has(id)) continue;
    client.stop();
    clientUnsubscribers.get(id)?.();
    clientUnsubscribers.delete(id);
    clients.delete(id);
    attentionBaselined.delete(id);
    persistedLabels.delete(id);
  }
  for (const environment of stored) {
    let client = clients.get(environment.id);
    if (!client) {
      client = new T3EnvironmentClient(environment, {
        fetch: fetchAdapter,
        openSocket: socketFactory,
        clientOs: clientOs(),
        log: (message) => console.log(message),
      });
      const created = client;
      clients.set(environment.id, created);
      clientUnsubscribers.set(environment.id, created.onChange(() => onClientChanged(created)));
    } else {
      client.updateConfig(environment);
    }
    persistedLabels.set(environment.id, environment.label);
    if (environment.enabled && (window || hasT3BackgroundWork())) client.start();
    else if (!environment.enabled) client.stop();
  }
  schedulePublish();
}

function stopAllClients(): void {
  for (const client of clients.values()) client.stop();
  schedulePublish();
}

/** Let the host shut this worker down once neither a window nor the widget needs it. */
function reportIdle(): void {
  if (!window && !hasT3BackgroundWork()) post({ type: "worker-idle" });
}

// ---------------------------------------------------------------------------
// Glanceboard snapshot

const PUBLISH_COALESCE_MS = 300;
let publishTimer: ReturnType<typeof setTimeout> | null = null;
let lastPublishedSnapshot = "";

/** Publish soon; agents can change the thread list many times a second. */
function schedulePublish(): void {
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = null;
    publishGlanceSnapshot();
  }, PUBLISH_COALESCE_MS);
}

/** The thread list for the Glanceboard widget, posted only when its JSON changed. */
function publishGlanceSnapshot(): void {
  const snapshot = buildGlanceSnapshot(
    [...clients.values()].map((client) => ({
      id: client.config.id,
      ready: client.ready,
      phase: client.phase,
      enabled: client.config.enabled,
      threads: client.shell.threads.values(),
    })),
    Date.now(),
  );
  const encoded = JSON.stringify(snapshot);
  if (encoded === lastPublishedSnapshot) return;
  lastPublishedSnapshot = encoded;
  post({ type: "publish-state", key: T3_GLANCE_STATE_KEY, state: snapshot });
}

function onClientChanged(client: T3EnvironmentClient): void {
  // Persist a label the server renamed itself to (changes fire per stream update, so compare first).
  if (client.config.label && persistedLabels.get(client.config.id) !== client.config.label) {
    persistedLabels.set(client.config.id, client.config.label);
    const stored = loadEnvironments().find((environment) => environment.id === client.config.id);
    if (stored && stored.label !== client.config.label) upsertEnvironment({ ...stored, label: client.config.label });
  }
  noteAttention(client);
  if (screen.kind === "thread" && threadView && threadView.envId === client.config.id) maybeVisitThread(false);
  schedulePublish();
  scheduleRender();
}

function environmentName(client: T3EnvironmentClient): string {
  return client.config.label || baseUrlLabel(client.config.httpBaseUrl);
}

function environmentStatusWord(client: T3EnvironmentClient): string {
  if (!client.config.enabled) return "off";
  switch (client.phase) {
    case "connected":
      return client.ready ? "connected" : "loading…";
    case "connecting":
      return "connecting…";
    case "retrying":
      return "retrying";
    case "auth-failed":
      return "pair again";
    case "idle":
      return "off";
  }
}

function readyClients(): T3EnvironmentClient[] {
  return [...clients.values()].filter((client) => client.ready);
}

// ---------------------------------------------------------------------------
// Attention: approvals, questions, finished runs

function noteAttention(client: T3EnvironmentClient): void {
  if (client.shell.sequence === null) return;
  const envId = client.config.id;
  const baseline = !attentionBaselined.has(envId);
  attentionBaselined.add(envId);
  let needsUser: T3ThreadShell | null = null;
  let finished = false;
  for (const thread of client.shell.threads.values()) {
    const key = `${envId}\n${thread.id}`;
    const status = threadStatus(thread);
    const requestId = thread.pendingRuntimeRequest?.id ?? null;
    const previous = knownStatus.get(key);
    knownStatus.set(key, { status, requestId });
    if (baseline) continue;
    if ((status === "approval" || status === "input") && requestId && requestId !== (previous?.requestId ?? null)) {
      needsUser = thread;
    } else if (previous?.status === "working" && (status === "ready" || status === "failed" || status === "limited")) {
      finished = true;
    }
  }
  if (!needsUser && !finished) return;
  const viewing = window?.foreground && screenOn;
  if (window && !viewing) post({ type: "set-attention", windowId: window.windowId, attention: true });
  if (window && needsUser && t3codeWakeOnAttentionSetting.get() && !screenOn) {
    // Show the list (the thread is at its top) rather than wherever we were.
    if (screen.kind !== "list" && screen.kind !== "thread") setScreen({ kind: "list" });
    listSelectionKey = threadKey(envId, needsUser.id);
    // The shell drops this unless the glasses are actually asleep.
    post({ type: "wake-window", windowId: window.windowId });
  }
}

// ---------------------------------------------------------------------------
// Screens

function setScreen(next: Screen): void {
  leaveScreenSideEffects();
  if (next.kind !== "thread") closeThreadView();
  screen = next;
  busyText = "";
  screenError = "";
  if (next.kind === "list" || next.kind === "environments") listMenu?.select(0);
  if (window) post({ type: "set-title", windowId: window.windowId, title: next.kind === "thread" ? threadTitle() : APP_TITLE });
  updateListRefreshTimer();
}

/** Undo whatever the current screen started (the phone editor, a pending voice answer). */
function leaveScreenSideEffects(): void {
  if (screen.kind === "pair") {
    t3codePairingLinkSetting.set("");
    post({ type: "end-text-setting-edit" });
  }
}

function goBack(frameId: number): void {
  switch (screen.kind) {
    case "list":
      frameTimings.finishFrame(frameId, "discarded: t3code yielded focus");
      post({ type: "yield-focus", windowId: window!.windowId });
      return;
    case "pair":
      setScreen({ kind: loadEnvironments().length ? "environments" : "list" });
      break;
    case "thread":
    case "environments":
    case "compose":
      setScreen({ kind: "list" });
      break;
  }
  renderNow(frameId);
}

function openThread(envId: string, threadId: string): void {
  const client = clients.get(envId);
  if (!client) return;
  closeThreadView();
  const handle = client.openThread(threadId, () => scheduleRender());
  threadView = {
    envId,
    threadId,
    handle,
    layout: new TranscriptLayout(),
    firstLine: null,
    maxFirstLine: 0,
    steerNext: false,
    voiceAnswer: null,
    lastVisitMs: 0,
    lastSeenCompletion: null,
  };
  setScreen({ kind: "thread", envId, threadId });
  if (window) post({ type: "set-attention", windowId: window.windowId, attention: false });
  maybeVisitThread(true);
}

function closeThreadView(): void {
  threadView?.handle.close();
  threadView = null;
}

function currentShellThread(): T3ThreadShell | null {
  if (!threadView) return null;
  return clients.get(threadView.envId)?.shell.threads.get(threadView.threadId) ?? null;
}

function threadTitle(): string {
  const shell = currentShellThread();
  return shell?.title || String(threadView?.handle.model.thread?.title ?? "") || "Thread";
}

/** Tell the server (and so T3's other clients) the user has seen this thread. Throttled. */
function maybeVisitThread(force: boolean): void {
  if (!threadView || screen.kind !== "thread" || !window?.foreground || !screenOn) return;
  const client = clients.get(threadView.envId);
  const shell = currentShellThread();
  if (!client?.ready || !shell) return;
  const completion = shell.latestRunCompletedAt ?? null;
  const now = Date.now();
  if (!force && completion === threadView.lastSeenCompletion) return;
  if (!force && now - threadView.lastVisitMs < VISIT_THROTTLE_MS) return;
  threadView.lastSeenCompletion = completion;
  threadView.lastVisitMs = now;
  client.dispatch(visitCommand(threadView.threadId, shell.updatedAt ?? new Date(now).toISOString())).catch(() => {
    // Read tracking is best-effort.
  });
}

function showNotice(text: string): void {
  notice = { text, untilMs: Date.now() + NOTICE_MS };
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    notice = null;
    render();
  }, NOTICE_MS);
  render();
}

// ---------------------------------------------------------------------------
// Input

/**
 * Open the window menu on a list of our own (a response or action menu).
 * From inside another menu's item the old menu is still closing (WindowMenu
 * ignores open() until its input handling finishes), so wait a tick.
 */
function openWindowMenu(items: MenuItem[], title: string): void {
  const open = () => {
    if (!window) return;
    windowMenu(window).open(items, title);
    renderNow();
  };
  if (window?.menu?.isOpen()) setTimeout(open, 0);
  else open();
}

function windowMenu(win: AppWindow): WindowMenu {
  win.menu ??= new WindowMenu({
    windowId: win.windowId,
    post,
    title: () => (screen.kind === "thread" ? threadTitle() : APP_TITLE),
    items: () => menuItems(),
    size: { width: win.viewportWidth, height: win.viewportHeight },
    paintBase: () => paintContent(win),
    isFocused: () => win.focused,
  });
  return win.menu;
}

function handleInput(win: AppWindow, event: InputEvent, frameId: number): void {
  if (win.menu?.isOpen()) {
    void win.menu
      .handleInput(event)
      .catch((error) => console.error(`t3code menu input failed: ${error}`))
      .then(() => renderNow(frameId));
    return;
  }
  if (event.type === "short-then-long-press") {
    windowMenu(win).open();
    renderNow(frameId);
    return;
  }
  if (event.type === "double-click") {
    goBack(frameId);
    return;
  }
  switch (screen.kind) {
    case "list":
    case "environments":
      handleListInput(event, frameId);
      return;
    case "thread":
      handleThreadInput(event, frameId);
      return;
    case "pair":
      if (event.type === "click" && !busyText) {
        void pairFromDraft();
        renderNow(frameId);
        return;
      }
      break;
    case "compose":
      if (event.type === "click" && !busyText) {
        post({ type: "start-voice-input", windowId: win.windowId });
        frameTimings.finishFrame(frameId, "discarded: t3code opened voice input");
        return;
      }
      break;
  }
  frameTimings.finishFrame(frameId, "discarded: t3code ignored input");
}

function handleListInput(event: InputEvent, frameId: number): void {
  if (event.type !== "scroll-up" && event.type !== "scroll-down" && event.type !== "click") {
    frameTimings.finishFrame(frameId, "discarded: t3code list ignored input");
    return;
  }
  const menu = list();
  const items = screen.kind === "environments" ? environmentItems() : listItems();
  menu.setItems(items, selectionIndex(items));
  // Item actions are synchronous, so the move or action has applied when this returns.
  menu.handleInput(event).catch((error) => console.error("t3code list action failed", error));
  if (event.type !== "click") listSelectionKey = menu.selectedItem?.key ?? null;
  renderNow(frameId);
}

function handleThreadInput(event: InputEvent, frameId: number): void {
  const view = threadView;
  if (!view) {
    frameTimings.finishFrame(frameId, "discarded: t3code no thread");
    return;
  }
  switch (event.type) {
    case "scroll-up":
    case "scroll-down": {
      const step = scrollStep();
      const from = view.firstLine ?? view.maxFirstLine;
      if (event.type === "scroll-up") view.firstLine = Math.max(0, from - step);
      else {
        const next = from + step;
        view.firstLine = next >= view.maxFirstLine ? null : next;
      }
      renderNow(frameId);
      return;
    }
    case "click": {
      const pending = view.handle.model.pendingRequests()[0];
      if (pending) {
        frameTimings.finishFrame(frameId, "discarded: t3code opened response menu");
        openResponseMenu(pending);
      } else {
        frameTimings.finishFrame(frameId, "discarded: t3code opened voice reply");
        startVoiceReply(false);
      }
      return;
    }
    default:
      frameTimings.finishFrame(frameId, "discarded: t3code thread ignored input");
  }
}

function scrollStep(): number {
  const visible = Math.max(1, Math.floor(threadBodyHeight() / lineStep(font())));
  return Math.max(3, Math.floor(visible / 3));
}

function startVoiceReply(steer: boolean): void {
  if (!threadView || !window) return;
  threadView.steerNext = steer;
  threadView.voiceAnswer = null;
  post({ type: "start-voice-input", windowId: window.windowId });
}

function handleTextInput(text: string): void {
  if (!text) return;
  switch (screen.kind) {
    case "pair":
      // Voice input as an alternative to the phone keyboard.
      t3codePairingLinkSetting.set(text);
      render();
      return;
    case "compose":
      void launchNewThread(screen.envId, screen.projectId, text);
      return;
    case "thread": {
      const view = threadView;
      if (!view) return;
      if (view.voiceAnswer) {
        const flow = view.voiceAnswer;
        view.voiceAnswer = null;
        const question = (flow.pending.item.questions ?? [])[flow.index];
        if (question) flow.answers[question.id] = question.multiSelect ? [text] : text;
        continueQuestionFlow({ ...flow, index: flow.index + 1 });
        return;
      }
      const steer = view.steerNext;
      view.steerNext = false;
      void sendMessage(view.envId, view.threadId, text, steer);
      return;
    }
    default:
      showNotice("Open a thread to send it a message.");
  }
}

async function sendMessage(envId: string, threadId: string, text: string, steer: boolean): Promise<void> {
  const client = clients.get(envId);
  if (!client) return;
  if (threadView?.threadId === threadId) threadView.firstLine = null;
  const shell = client.shell.threads.get(threadId);
  const working = shell ? threadStatus(shell) === "working" : false;
  showNotice("Sending…");
  try {
    await client.dispatch(messageDispatchCommand(threadId, text, { steer }));
    showNotice(working && !steer ? "Sent (queued after the current turn)" : "Sent");
  } catch (error) {
    showNotice(`Not sent: ${errorMessage(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Approvals and questions

function openResponseMenu(pending: PendingRequest): void {
  if (!window || !threadView) return;
  if (!pending.answerable) {
    showNotice("This request can't be answered any more; stop the run from the menu.");
    return;
  }
  if (pending.kind === "approval") {
    const { label, detail } = describeRequest(pending.item);
    const items: MenuItem[] = [];
    if (detail) items.push({ label: detail, disabled: true, onSelect: () => {} });
    for (const option of approvalOptions(pending.item)) {
      items.push({
        label: option.label,
        onSelect: (ctx) => {
          ctx.stack.pop();
          void respond(approvalResponseCommand(threadView!.threadId, pending.request.id, option.decision), "Answered");
        },
      });
    }
    openWindowMenu(items, `${label}?`);
    return;
  }
  continueQuestionFlow({ pending, index: 0, answers: {} });
}

/** Ask question `flow.index` (or send the answers once all are in). */
function continueQuestionFlow(flow: QuestionFlow): void {
  if (!window || !threadView) return;
  const questions = flow.pending.item.questions ?? [];
  const question = questions[flow.index];
  if (!question) {
    void respond(questionAnswerCommand(threadView.threadId, flow.pending.request.id, flow.answers), "Answered");
    return;
  }
  const items: MenuItem[] = [];
  for (const option of question.options ?? []) {
    items.push({
      label: option.description ? `${option.label} - ${option.description}` : option.label,
      onSelect: (ctx) => {
        ctx.stack.pop();
        const answer = optionAnswer(option);
        flow.answers[question.id] = question.multiSelect ? [answer] : answer;
        continueQuestionFlow({ ...flow, index: flow.index + 1 });
      },
    });
  }
  if (question.allowCustomAnswer !== false || !(question.options ?? []).length) {
    items.push({
      label: "Answer by voice…",
      onSelect: (ctx) => {
        ctx.stack.pop();
        if (!threadView || !window) return;
        threadView.voiceAnswer = flow;
        threadView.steerNext = false;
        post({ type: "start-voice-input", windowId: window.windowId });
      },
    });
  }
  if (question.required === false) {
    items.push({
      label: "Skip",
      onSelect: (ctx) => {
        ctx.stack.pop();
        if (flow.pending.messageMode) flow.answers[question.id] = "";
        continueQuestionFlow({ ...flow, index: flow.index + 1 });
      },
    });
  }
  const counter = questions.length > 1 ? ` (${flow.index + 1}/${questions.length})` : "";
  const title = truncateText(font(), `${question.header || question.question}${counter}`, 230);
  openWindowMenu(items, title);
}

async function respond(command: Record<string, unknown>, done: string): Promise<void> {
  const client = threadView ? clients.get(threadView.envId) : null;
  if (!client) return;
  showNotice("Sending…");
  try {
    await client.dispatch(command);
    showNotice(done);
  } catch (error) {
    showNotice(`Failed: ${errorMessage(error)}`);
  }
}

// ---------------------------------------------------------------------------
// App menu

function menuItems(): MenuItem[] {
  switch (screen.kind) {
    case "list":
      return listMenuItems();
    case "thread":
      return threadMenuItems();
    default:
      return [];
  }
}

function listMenuItems(): MenuItem[] {
  const items: MenuItem[] = [];
  if (projectChoices().length) {
    items.push(submenuItem("New thread", (ctx) => ctx.stack.push(new WindowMenuLayer("New thread in", projectMenuItems()))));
  }
  items.push({
    label: "Manage environments",
    onSelect: (ctx) => {
      ctx.stack.pop();
      setScreen({ kind: "environments" });
    },
  });
  if ([...clients.values()].some((client) => client.phase === "retrying")) {
    items.push({
      label: "Reconnect now",
      onSelect: (ctx) => {
        ctx.stack.pop();
        for (const client of clients.values()) if (client.phase === "retrying") client.retryNow();
      },
    });
  }
  items.push(
    submenuItem("Settings", (ctx) => ctx.stack.push(new WindowMenuLayer("T3 Code settings", [toggleSettingMenuItem(t3codeWakeOnAttentionSetting)]))),
  );
  return items;
}

function threadMenuItems(): MenuItem[] {
  const view = threadView;
  const client = view ? clients.get(view.envId) : null;
  if (!view || !client) return [];
  const items: MenuItem[] = [];
  const pending = view.handle.model.pendingRequests()[0];
  if (pending) {
    items.push({
      label: pending.kind === "approval" ? "Respond to approval" : "Answer question",
      onSelect: (ctx) => {
        ctx.stack.pop();
        openResponseMenu(pending);
      },
    });
  }
  items.push({
    label: "Reply by voice",
    onSelect: (ctx) => {
      ctx.stack.pop();
      startVoiceReply(false);
    },
  });
  const activeRunId = view.handle.model.activeRunId();
  if (activeRunId) {
    items.push(
      {
        label: "Steer by voice",
        description: "Your next message goes to the agent right away instead of waiting for this turn to finish.",
        onSelect: (ctx) => {
          ctx.stack.pop();
          startVoiceReply(true);
        },
      },
      {
        label: "Stop",
        onSelect: (ctx) => {
          ctx.stack.pop();
          void respond(interruptCommand(view.threadId, activeRunId), "Stopping…");
        },
      },
    );
  }
  if (view.firstLine !== null) {
    items.push({
      label: "Jump to latest",
      onSelect: (ctx) => {
        ctx.stack.pop();
        view.firstLine = null;
      },
    });
  }
  const shell = currentShellThread();
  if (shell) {
    const settled = isThreadSettled(shell);
    items.push({
      label: settled ? "Unsettle thread" : "Settle thread",
      description: "Settled threads move to the bottom of the list (T3 Code's \"done\" state).",
      onSelect: (ctx) => {
        ctx.stack.pop();
        void respond(settleCommand(view.threadId, !settled), settled ? "Unsettled" : "Settled");
      },
    });
  }
  return items;
}

type ProjectChoice = { client: T3EnvironmentClient; project: T3ProjectShell; lastActivityMs: number };

/** Projects across connected environments, most recently active first. */
function projectChoices(): ProjectChoice[] {
  const choices: ProjectChoice[] = [];
  for (const client of readyClients()) {
    const activity = new Map<string, number>();
    for (const thread of client.shell.threads.values()) {
      activity.set(thread.projectId, Math.max(activity.get(thread.projectId) ?? 0, threadActivityMs(thread)));
    }
    for (const project of client.shell.projects.values()) {
      choices.push({ client, project, lastActivityMs: activity.get(project.id) ?? 0 });
    }
  }
  return choices.sort((a, b) => b.lastActivityMs - a.lastActivityMs || a.project.title.localeCompare(b.project.title));
}

function projectMenuItems(): MenuItem[] {
  const multiEnv = readyClients().length > 1;
  return projectChoices().map(({ client, project }) => ({
    label: multiEnv ? `${project.title} · ${environmentName(client)}` : project.title,
    onSelect: (ctx) => {
      ctx.stack.clearToBase();
      setScreen({ kind: "compose", envId: client.config.id, projectId: project.id });
      if (window) post({ type: "start-voice-input", windowId: window.windowId });
    },
  }));
}

// ---------------------------------------------------------------------------
// Pairing

function beginPairing(repairId: string | null): void {
  t3codePairingLinkSetting.set("");
  setScreen({ kind: "pair", repairId });
  post({ type: "start-text-setting-edit", settingId: t3codePairingLinkSetting.id });
}

async function pairFromDraft(): Promise<void> {
  if (screen.kind !== "pair") return;
  const repairId = screen.repairId;
  const parsed = parsePairingInput(t3codePairingLinkSetting.get());
  // ("in" rather than !parsed.ok: the app isn't strictNullChecks, so ok doesn't narrow.)
  if ("error" in parsed) {
    screenError = parsed.error;
    render();
    return;
  }
  const { target } = parsed;
  busyText = `Contacting ${baseUrlLabel(target.httpBaseUrl)}…`;
  screenError = "";
  render();
  try {
    const descriptor = await fetchEnvironmentDescriptor(fetchAdapter, target.httpBaseUrl);
    if (descriptor.orchestrationProtocolVersion !== T3_ORCHESTRATION_PROTOCOL) {
      throw new Error(
        descriptor.orchestrationProtocolVersion < T3_ORCHESTRATION_PROTOCOL
          ? `That server runs an older T3 Code (${descriptor.serverVersion || "unknown version"}). Update it with \`t3 update\`.`
          : "That server runs a newer T3 Code protocol than Faceclaw supports.",
      );
    }
    if (screen.kind !== "pair") return;
    busyText = `Pairing with ${descriptor.label || baseUrlLabel(target.httpBaseUrl)}…`;
    render();
    const credential = await exchangePairingCredential(fetchAdapter, target.httpBaseUrl, target.credential, {
      label: "Faceclaw (G2 glasses)",
      os: clientOs(),
    });
    const existing = loadEnvironments();
    const replacing =
      (repairId && existing.find((environment) => environment.id === repairId)) ||
      existing.find((environment) => environment.environmentId === descriptor.environmentId);
    const environment: StoredEnvironment = {
      id: replacing ? replacing.id : `e${Date.now()}`,
      environmentId: descriptor.environmentId,
      label: descriptor.label || target.label || baseUrlLabel(target.httpBaseUrl),
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
      accessToken: credential.accessToken,
      expiresAtMs: credential.expiresAtMs,
      enabled: true,
    };
    upsertEnvironment(environment);
    syncClients();
    if (screen.kind === "pair") setScreen({ kind: "list" });
    showNotice(`Paired with ${environment.label}`);
  } catch (error) {
    if (screen.kind !== "pair") return;
    busyText = "";
    screenError = errorMessage(error);
    // The link is one-time: a failed exchange may have spent it.
    render();
  }
}

// ---------------------------------------------------------------------------
// New threads

function composeTarget(): { client: T3EnvironmentClient; project: T3ProjectShell } | null {
  if (screen.kind !== "compose") return null;
  const client = clients.get(screen.envId);
  const project = client?.shell.projects.get(screen.projectId);
  return client && project ? { client, project } : null;
}

async function launchNewThread(envId: string, projectId: string, text: string): Promise<void> {
  const client = clients.get(envId);
  const project = client?.shell.projects.get(projectId);
  if (!client || !project) return;
  const selection = defaultModelSelection(client.settings, client.providers, project);
  if (!selection) {
    screenError = "No usable agent on that computer: sign in to Claude Code, Codex or another provider in T3 Code first.";
    render();
    return;
  }
  busyText = "Starting thread…";
  screenError = "";
  render();
  try {
    const threadId = await client.launchThread(launchThreadPayload(project, text, selection, client.settings));
    if (screen.kind === "compose") openThread(envId, threadId);
    render();
  } catch (error) {
    busyText = "";
    screenError = errorMessage(error);
    render();
  }
}

// ---------------------------------------------------------------------------
// List items

function threadKey(envId: string, threadId: string): string {
  return `thread:${envId}:${threadId}`;
}

function list(): Menu<ListItem> {
  listMenu ??= new Menu<ListItem>({
    wrap: false,
    rowGap: 1,
    getHeight: () => listRowHeight(font()),
    isSelectable: (item) => Boolean(item.onSelect),
    onSelect: (item) => item.onSelect?.(),
    draw: drawListRow,
  });
  return listMenu;
}

/** The selection index for the remembered key (selection follows its thread as the list reorders). */
function selectionIndex(items: readonly ListItem[]): number | undefined {
  if (!listSelectionKey) return undefined;
  const index = items.findIndex((item) => item.key === listSelectionKey);
  return index >= 0 ? index : undefined;
}

function threadItem(client: T3EnvironmentClient, thread: T3ThreadShell, multiEnv: boolean, nowMs: number): ListItem {
  const { marker, value } = threadMarker(threadStatus(thread), { settled: isThreadSettled(thread), unread: isThreadUnread(thread) });
  const project = client.shell.projects.get(thread.projectId)?.title ?? "";
  const where = multiEnv ? [project, environmentName(client)].filter(Boolean).join(" · ") : project;
  const age = formatAge(threadActivityMs(thread), nowMs);
  return {
    key: threadKey(client.config.id, thread.id),
    kind: "thread",
    label: thread.title || "Untitled",
    right: [where, age].filter(Boolean).join(" · "),
    marker,
    markerValue: value,
    onSelect: () => openThread(client.config.id, thread.id),
  };
}

function listItems(): ListItem[] {
  const items: ListItem[] = [];
  const all = [...clients.values()];
  if (!all.length) {
    items.push({ key: "pair", kind: "action", label: "Pair a T3 Code environment", onSelect: () => beginPairing(null) });
    return items;
  }
  // Environments that aren't delivering threads get a heading and a way forward.
  for (const client of all) {
    if (client.ready) continue;
    items.push({ key: `env:${client.config.id}`, kind: "heading", label: `${environmentName(client)}  (${environmentStatusWord(client)})` });
    if (!client.config.enabled) {
      items.push({ key: `env-on:${client.config.id}`, kind: "action", label: "Connect", onSelect: () => setEnvironmentEnabled(client, true) });
    } else if (client.phase === "auth-failed") {
      items.push({ key: `env-pair:${client.config.id}`, kind: "action", label: "Pair again", onSelect: () => beginPairing(client.config.id) });
    } else if (client.phase === "retrying") {
      items.push({ key: `env-retry:${client.config.id}`, kind: "action", label: "Connect now", onSelect: () => client.retryNow() });
    }
  }
  const nowMs = Date.now();
  const multiEnv = all.length > 1;
  // Section every environment's threads together, remembering whose each is.
  const owner = new Map<T3ThreadShell, T3EnvironmentClient>();
  for (const client of all) {
    if (!client.ready) continue;
    for (const thread of client.shell.threads.values()) owner.set(thread, client);
  }
  const sections = sectionThreads(owner.keys(), nowMs);
  type Entry = { client: T3EnvironmentClient; thread: T3ThreadShell };
  const withOwner = (threads: T3ThreadShell[]): Entry[] => threads.map((thread) => ({ client: owner.get(thread)!, thread }));
  const merged = {
    attention: withOwner(sections.attention),
    working: withOwner(sections.working),
    recent: withOwner(sections.recent),
    snoozed: withOwner(sections.snoozed),
    settled: withOwner(sections.settled),
  };
  const section = (key: string, label: string, entries: Entry[]) => {
    if (!entries.length) return;
    items.push({ key: `section:${key}`, kind: "heading", label });
    for (const { client, thread } of entries) items.push(threadItem(client, thread, multiEnv, nowMs));
  };
  section("attention", "Needs you", merged.attention);
  section("working", "Working", merged.working);
  section("recent", "Recent", merged.recent);
  if (merged.snoozed.length) {
    items.push({
      key: "toggle:snoozed",
      kind: "action",
      label: `${showSnoozed ? "Hide" : "Show"} snoozed (${merged.snoozed.length})`,
      onSelect: () => {
        showSnoozed = !showSnoozed;
      },
    });
    if (showSnoozed) for (const { client, thread } of merged.snoozed) items.push(threadItem(client, thread, multiEnv, nowMs));
  }
  if (merged.settled.length) {
    items.push({
      key: "toggle:settled",
      kind: "action",
      label: `${showSettled ? "Hide" : "Show"} settled (${merged.settled.length})`,
      onSelect: () => {
        showSettled = !showSettled;
      },
    });
    if (showSettled) {
      for (const { client, thread } of merged.settled.slice(0, SETTLED_SHOWN)) items.push(threadItem(client, thread, multiEnv, nowMs));
    }
  }
  if (!items.some((item) => item.kind === "thread") && readyClients().length) {
    items.push({
      key: "empty",
      kind: "heading",
      label: projectChoices().length ? "No threads yet. Tap, then hold, for New thread." : "No projects yet; add one in T3 Code.",
    });
  }
  return items;
}

function environmentItems(): ListItem[] {
  const items: ListItem[] = [];
  for (const client of clients.values()) {
    items.push({
      key: `envrow:${client.config.id}`,
      kind: "action",
      label: environmentName(client),
      right: environmentStatusWord(client),
      submenu: true,
      onSelect: () => openEnvironmentActions(client),
    });
  }
  items.push(
    { key: "pair-new", kind: "action", label: "Pair new environment", onSelect: () => beginPairing(null) },
    { key: "done", kind: "action", label: "Done", onSelect: () => setScreen({ kind: "list" }) },
  );
  return items;
}

function setEnvironmentEnabled(client: T3EnvironmentClient, enabled: boolean): void {
  const stored = loadEnvironments().find((environment) => environment.id === client.config.id);
  if (stored) upsertEnvironment({ ...stored, enabled });
  syncClients();
}

function openEnvironmentActions(client: T3EnvironmentClient): void {
  if (!window) return;
  const name = environmentName(client);
  const items: MenuItem[] = [
    { label: baseUrlLabel(client.config.httpBaseUrl), disabled: true, onSelect: () => {} },
    client.config.enabled
      ? { label: "Disconnect", onSelect: (ctx) => { ctx.stack.pop(); setEnvironmentEnabled(client, false); } }
      : { label: "Connect", onSelect: (ctx) => { ctx.stack.pop(); setEnvironmentEnabled(client, true); } },
    { label: "Pair again", onSelect: (ctx) => { ctx.stack.pop(); beginPairing(client.config.id); } },
    {
      label: `Remove ${name}`,
      onSelect: (ctx) => {
        ctx.stack.pop();
        removeEnvironment(client.config.id);
        syncClients();
      },
    },
  ];
  if (client.status) items.splice(1, 0, { label: client.status, disabled: true, onSelect: () => {} });
  openWindowMenu(items, name);
}

// ---------------------------------------------------------------------------
// Painting

function drawListRow({ image, item, x, y, width, height, selected }: MenuDrawArgs<ListItem>): void {
  const f = font();
  const textY = y + Math.max(0, Math.floor((height - f.lineHeight) / 2));
  if (item.kind === "heading") {
    image.drawText(f, x + 4, textY, truncateText(f, item.label, width - 8), selected ? 255 : 140);
    return;
  }
  const value = selected ? 255 : 200;
  const markerWidth = item.kind === "thread" ? 18 : 0;
  if (item.marker) image.drawText(f, x + 6, textY, item.marker, selected ? 255 : (item.markerValue ?? value));
  const right = item.right ? truncateText(f, item.right, Math.floor(width * 0.42)) : "";
  const rightWidth = right ? f.measureText(right) + 12 : 0;
  const submenuWidth = item.submenu ? 16 : 0;
  const labelX = x + 6 + markerWidth;
  image.drawText(f, labelX, textY, truncateText(f, item.label, Math.max(10, width - (labelX - x) - rightWidth - submenuWidth - 6)), value);
  if (right) image.drawText(f, x + width - 6 - submenuWidth - f.measureText(right), textY, right, selected ? 200 : 120);
  if (item.submenu) drawSubmenuIndicator(image, f, x, y, width, height, value);
}

function paint(win: AppWindow): Plane[] {
  return windowMenu(win).paint();
}

function paintContent(win: AppWindow): GrayImage {
  switch (screen.kind) {
    case "list":
      return paintList(win, "list");
    case "environments":
      return paintList(win, "environments");
    case "thread":
      return paintThread(win);
    case "pair":
      return paintPair(win);
    case "compose":
      return paintCompose(win);
  }
}

function listStatusLine(): string {
  if (notice) return notice.text;
  const all = [...clients.values()];
  if (!all.length) return "";
  let needs = 0;
  let working = 0;
  for (const client of all) {
    if (!client.ready) continue;
    for (const thread of client.shell.threads.values()) {
      const status = threadStatus(thread);
      if (status === "approval" || status === "input") needs++;
      else if (status === "working") working++;
    }
  }
  if (all.every((client) => !client.ready)) {
    return all.some((client) => client.phase === "connecting") ? "Connecting…" : "Not connected";
  }
  return glanceSummary({ needsYou: needs, working });
}

function paintList(win: AppWindow, mode: "list" | "environments"): GrayImage {
  const image = new GrayImage(win.viewportWidth, win.viewportHeight, 0);
  const f = font();
  const step = lineStep(f);
  const title = mode === "environments" ? "T3 Code - Environments" : APP_TITLE;
  image.drawText(f, TITLE_X, TITLE_Y, title, 220);
  const status = mode === "list" ? listStatusLine() : notice?.text ?? "";
  if (status) {
    const statusX = TITLE_X + f.measureText(title) + 16;
    image.drawText(f, statusX, TITLE_Y, truncateText(f, status, win.viewportWidth - statusX - 14), 150);
  }
  let listTop = TITLE_Y + step + 8;
  if (mode === "list" && clients.size === 0) {
    const help = wrapText(
      f,
      "Run `t3 pair` on the computer running T3 Code (serve it on your network with `t3 serve --host 0.0.0.0`, or use Tailscale), then pick Pair below and paste the link into the phone app.",
      win.viewportWidth - TITLE_X * 2,
    );
    help.forEach((line, index) => image.drawText(f, TITLE_X, listTop + index * step, line, 160));
    listTop += help.length * step + 8;
  }
  const items = mode === "environments" ? environmentItems() : listItems();
  const menu = list();
  menu.setItems(items, selectionIndex(items));
  listSelectionKey = menu.selectedItem?.key ?? listSelectionKey;
  const listHeight = win.viewportHeight - 6 - listTop;
  menu.paint(image, { x: LIST_LEFT, y: listTop - 2, width: win.viewportWidth - LIST_LEFT - LIST_RIGHT, height: listHeight }, win.focused);
  menu.drawScrollbar(image, win.viewportWidth - 10, listTop, listHeight - 4);
  return image;
}

const THREAD_HEADER_HEIGHT = 28;

function threadBodyTop(): number {
  return THREAD_HEADER_HEIGHT + 4;
}

/** Body height above the footer (hint line, plus a plan line when there is one). */
function threadBodyHeight(): number {
  if (!window) return 0;
  const step = lineStep(font());
  const footerLines = threadView?.handle.model.todoList() && currentShellThread() && threadStatus(currentShellThread()!) === "working" ? 2 : 1;
  return window.viewportHeight - threadBodyTop() - footerLines * step - 8;
}

function threadFooterHint(): { text: string; value: number } {
  if (notice) return { text: notice.text, value: 200 };
  const view = threadView;
  const client = view ? clients.get(view.envId) : null;
  if (!view || !client) return { text: "", value: 0 };
  if (!client.ready) return { text: client.status || "Not connected", value: 150 };
  const error = view.handle.error();
  if (error) return { text: error, value: 150 };
  const pending = view.handle.model.pendingRequests()[0];
  if (pending) {
    return { text: `${GESTURE_CLICK} ${pending.kind === "approval" ? "respond to approval" : "answer question"}`, value: 255 };
  }
  if (view.firstLine !== null) return { text: `${GESTURE_CLICK} reply   (scrolled back)`, value: 120 };
  return { text: `${GESTURE_CLICK} reply`, value: 110 };
}

function paintThread(win: AppWindow): GrayImage {
  const image = new GrayImage(win.viewportWidth, win.viewportHeight, 0);
  const view = threadView;
  const f = font();
  const step = lineStep(f);
  const width = win.viewportWidth - BODY_LEFT - BODY_RIGHT;
  if (!view) return image;
  const shell = currentShellThread();
  const status = shell ? threadStatusLabel(threadStatus(shell)) : "";
  const statusWidth = status ? f.measureText(status) + 12 : 0;
  image.drawText(f, BODY_LEFT, 6, truncateText(f, threadTitle(), width - statusWidth), 225);
  if (status) image.drawText(f, win.viewportWidth - BODY_RIGHT - f.measureText(status), 6, status, 150);
  image.drawLine(BODY_LEFT - 2, THREAD_HEADER_HEIGHT - 4, win.viewportWidth - BODY_RIGHT + 2, THREAD_HEADER_HEIGHT - 4, 40);

  const model = view.handle.model;
  const bodyTop = threadBodyTop();
  const bodyHeight = threadBodyHeight();
  const visible = Math.max(1, Math.floor(bodyHeight / step));
  if (model.sequence === null) {
    const client = clients.get(view.envId);
    image.drawText(f, BODY_LEFT, bodyTop, client?.ready ? "Loading…" : client?.status || "Not connected", 150);
  } else if (model.deleted) {
    image.drawText(f, BODY_LEFT, bodyTop, "This thread was deleted.", 150);
  } else {
    const lines = view.layout.layout(timelineEntries(model), f, width);
    if (model.hasMoreHistory) lines.unshift({ text: "(earlier messages on the computer)", value: 90, indent: 0 }, { text: "", value: 0, indent: 0 });
    view.maxFirstLine = Math.max(0, lines.length - visible);
    if (view.firstLine !== null && view.firstLine >= view.maxFirstLine) view.firstLine = null;
    const first = view.firstLine ?? view.maxFirstLine;
    for (let row = 0; row < visible; row++) {
      const line = lines[first + row];
      if (line?.text) image.drawText(f, BODY_LEFT + line.indent, bodyTop + row * step, line.text, line.value);
    }
    if (view.maxFirstLine > 0) {
      const track = visible * step;
      const thumb = Math.max(8, Math.floor((track * visible) / lines.length));
      image.fillRect(win.viewportWidth - 8, bodyTop + Math.floor(((track - thumb) * first) / view.maxFirstLine), 2, thumb, 110);
    }
  }

  // Footer: the agent's plan progress while it works, then the hint/status line.
  let footerY = win.viewportHeight - step - 4;
  const hint = threadFooterHint();
  if (hint.text) {
    const text = truncateText(f, hint.text, width);
    image.drawText(f, win.viewportWidth - BODY_RIGHT - f.measureText(text), footerY, text, hint.value);
  }
  const todo = model.todoList();
  if (todo && shell && threadStatus(shell) === "working") {
    footerY -= step;
    const steps = todo.steps ?? [];
    const done = steps.filter((entry) => entry.status === "completed").length;
    const current = steps.find((entry) => entry.status === "running") ?? steps.find((entry) => entry.status === "pending");
    const text = `Plan ${done}/${steps.length}${current ? ` · ${plainMarkdown(current.text)}` : ""}`;
    image.drawText(f, BODY_LEFT, footerY, truncateText(f, text, width), 160);
  }
  return image;
}

function paintMessageScreen(win: AppWindow, title: string, paragraphs: Array<{ text: string; value: number }>, footer: string): GrayImage {
  const image = new GrayImage(win.viewportWidth, win.viewportHeight, 0);
  const f = font();
  const step = lineStep(f);
  const width = win.viewportWidth - TITLE_X * 2;
  image.drawText(f, TITLE_X, TITLE_Y, title, 220);
  let y = TITLE_Y + step + 10;
  for (const paragraph of paragraphs) {
    if (!paragraph.text) continue;
    for (const line of wrapText(f, paragraph.text, width)) {
      if (y > win.viewportHeight - 2 * step) break;
      image.drawText(f, TITLE_X, y, line, paragraph.value);
      y += step;
    }
    y += 6;
  }
  if (footer) image.drawText(f, TITLE_X, win.viewportHeight - step - 6, footer, 110);
  return image;
}

/** The draft link with its one-time token masked. */
function maskedDraft(): string {
  const draft = t3codePairingLinkSetting.get();
  if (!draft) return "(waiting for the link)";
  return draft.replace(/(token=)([^&\s]+)/, (_match, prefix: string, token: string) => `${prefix}${token.slice(0, 2)}…`);
}

function paintPair(win: AppWindow): GrayImage {
  return paintMessageScreen(
    win,
    screen.kind === "pair" && screen.repairId ? "Pair again" : "Pair T3 Code",
    [
      { text: "Run `t3 pair` on the computer running T3 Code and paste the link into the phone app (or type host:port and the code).", value: 170 },
      { text: maskedDraft(), value: t3codePairingLinkSetting.get() ? 225 : 120 },
      { text: busyText, value: 200 },
      { text: screenError, value: 230 },
    ],
    busyText ? "" : `${GESTURE_CLICK} pair   ${GESTURE_DOUBLE_CLICK} cancel`,
  );
}

function paintCompose(win: AppWindow): GrayImage {
  const target = composeTarget();
  if (!target) return paintMessageScreen(win, "New thread", [{ text: "That project is no longer available.", value: 170 }], "");
  const { client, project } = target;
  const selection = defaultModelSelection(client.settings, client.providers, project);
  const agent = selection ? `${providerDisplayName(client.providers, selection.instanceId)} · ${selection.model}` : "No usable agent";
  return paintMessageScreen(
    win,
    `New thread: ${project.title}`,
    [
      { text: `Agent: ${agent}`, value: 150 },
      { text: "Say or type what the agent should do.", value: 200 },
      { text: busyText, value: 200 },
      { text: screenError, value: 230 },
    ],
    busyText ? "" : `${GESTURE_CLICK} speak   ${GESTURE_DOUBLE_CLICK} cancel`,
  );
}

// ---------------------------------------------------------------------------
// Rendering

function updateListRefreshTimer(): void {
  const wanted = Boolean(window?.foreground && screenOn && screen.kind === "list");
  if (wanted && !listRefreshTimer) listRefreshTimer = setInterval(() => render(), LIST_REFRESH_MS);
  else if (!wanted && listRefreshTimer) {
    clearInterval(listRefreshTimer);
    listRefreshTimer = null;
  }
}

/** Data changed: repaint soon, coalescing bursts of stream updates. */
function scheduleRender(): void {
  const win = window;
  if (!win || win.renderTimer) return;
  win.renderTimer = setTimeout(() => {
    win.renderTimer = null;
    render();
  }, DATA_RENDER_COALESCE_MS);
}

function render(): void {
  if (window?.foreground && screenOn) renderNow();
}

function renderNow(inputFrameId = 0): void {
  const win = window;
  if (!win || !win.foreground || !screenOn) {
    if (inputFrameId) frameTimings.finishFrame(inputFrameId, "discarded: t3code window not visible");
    return;
  }
  const frameId = inputFrameId > 0 ? inputFrameId : frameTimings.startFrame(`render:${win.windowId}`);
  try {
    const paintStartedAtMs = Date.now();
    const planes = frameTimings.span(frameId, "paint", () => frameTimings.runWithFrame(frameId, () => paint(win)));
    const paintMs = Date.now() - paintStartedAtMs;
    const fingerprint = planesFingerprint(planes);
    if (fingerprint === win.lastSubmittedFingerprint) {
      frameTimings.finishFrame(frameId, "discarded: t3code content unchanged");
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
      win.surfaceId,
      0,
      0,
      image.width,
      image.height,
      fingerprint,
      paintMs,
      frameId,
      frameTimings.span(frameId, "prepareFrameDraws", () => prepareFrameDraws(draws)),
    );
    win.lastSubmittedFingerprint = fingerprint;
  } catch (error) {
    frameTimings.finishFrame(frameId, "discarded: t3code render failed");
    console.error(`t3code worker render failed: ${error}`);
  }
}

// ---------------------------------------------------------------------------
// Tools

type ThreadMatch = { client: T3EnvironmentClient; thread: T3ThreadShell };

function findThread(query: string): ThreadMatch | { error: string } {
  const needle = query.trim().toLowerCase();
  const matches: ThreadMatch[] = [];
  for (const client of readyClients()) {
    for (const thread of client.shell.threads.values()) {
      if (thread.archivedAt || thread.deletedAt) continue;
      if ((thread.title ?? "").toLowerCase().includes(needle)) matches.push({ client, thread });
    }
  }
  if (!matches.length) return { error: `No T3 Code thread title contains "${query}".` };
  const exact = matches.filter((match) => match.thread.title.toLowerCase() === needle);
  if (exact.length === 1) return exact[0]!;
  // Prefer the most recently active among several matches.
  matches.sort((a, b) => threadActivityMs(b.thread) - threadActivityMs(a.thread));
  return matches[0]!;
}

function describeThreadForTool(client: T3EnvironmentClient, thread: T3ThreadShell): string {
  const project = client.shell.projects.get(thread.projectId)?.title ?? "unknown project";
  const status = threadStatus(thread);
  const extra = isThreadSettled(thread) ? ", settled" : isThreadUnread(thread) ? ", unread" : "";
  return `- "${thread.title}" (${project}${clients.size > 1 ? ` on ${environmentName(client)}` : ""}): ${threadStatusLabel(status).toLowerCase()}${extra}`;
}

async function handleTool(name: string, args: any): Promise<ToolResult> {
  if (!readyClients().length) {
    return { ok: false, error: clients.size ? "Not connected to any T3 Code environment right now." : "No T3 Code environment is paired yet." };
  }
  switch (name) {
    case "list_threads": {
      const lines: string[] = [];
      const nowMs = Date.now();
      for (const client of readyClients()) {
        const sections = sectionThreads(client.shell.threads.values(), nowMs);
        for (const thread of [...sections.attention, ...sections.working, ...sections.recent.slice(0, 15)]) {
          lines.push(describeThreadForTool(client, thread));
        }
      }
      return { ok: true, content: lines.length ? lines.join("\n") : "There are no active T3 Code threads." };
    }
    case "read_thread": {
      const match = findThread(String(args?.thread ?? ""));
      if ("error" in match) return { ok: false, error: match.error };
      return { ok: true, content: await readThreadText(match) };
    }
    case "send_message": {
      const text = String(args?.text ?? "").trim();
      if (!text) return { ok: false, error: "send_message needs text." };
      let match: ThreadMatch | { error: string };
      if (args?.thread) match = findThread(String(args.thread));
      else if (threadView && clients.get(threadView.envId) && currentShellThread()) {
        match = { client: clients.get(threadView.envId)!, thread: currentShellThread()! };
      } else return { ok: false, error: "No thread is open on the glasses; say which thread." };
      if ("error" in match) return { ok: false, error: match.error };
      await match.client.dispatch(messageDispatchCommand(match.thread.id, text));
      const busy = threadStatus(match.thread) === "working";
      return { ok: true, content: `Sent to "${match.thread.title}"${busy ? " (queued until the agent finishes its current turn)" : ""}.` };
    }
    case "start_thread": {
      const projectQuery = String(args?.project ?? "").trim().toLowerCase();
      const text = String(args?.text ?? "").trim();
      if (!projectQuery || !text) return { ok: false, error: "start_thread needs project and text." };
      const choice = projectChoices().find(({ project }) => project.title.toLowerCase().includes(projectQuery));
      if (!choice) {
        return { ok: false, error: `No project matches "${args?.project}". Projects: ${projectChoices().map(({ project }) => project.title).join(", ")}` };
      }
      const selection = defaultModelSelection(choice.client.settings, choice.client.providers, choice.project);
      if (!selection) return { ok: false, error: "No usable agent provider on that computer." };
      const threadId = await choice.client.launchThread(launchThreadPayload(choice.project, text, selection, choice.client.settings));
      return { ok: true, content: `Started a thread in ${choice.project.title} (id ${threadId}).` };
    }
    default:
      return { ok: false, error: `Unknown T3 Code tool: ${name}` };
  }
}

/** The thread's recent conversation as plain text, via a short-lived subscription unless it's already open. */
async function readThreadText({ client, thread }: ThreadMatch): Promise<string> {
  const handle = client.openThread(thread.id, () => {});
  try {
    const started = Date.now();
    while (!handle.model.synchronized && Date.now() - started < 10_000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (handle.model.sequence === null) throw new Error(handle.error() || "Timed out loading the thread.");
    const lines: string[] = [`Thread "${thread.title}" — ${threadStatusLabel(threadStatus(thread)).toLowerCase()}.`];
    for (const entry of timelineEntries(handle.model).slice(-30)) {
      switch (entry.kind) {
        case "user":
          lines.push(`User${entry.queued ? " (queued)" : ""}: ${entry.text}`);
          break;
        case "assistant":
          lines.push(`Agent: ${plainMarkdown(entry.text).slice(0, 1500)}`);
          break;
        case "activity":
          lines.push(`[${entry.label}${entry.detail ? `: ${entry.detail}` : ""}${entry.state === "failed" ? " (failed)" : ""}]`);
          break;
        case "request":
          lines.push(`[${entry.resolved ? "Answered: " : "WAITING FOR THE USER: "}${entry.label}${entry.detail ? ` — ${entry.detail}` : ""}]`);
          break;
      }
    }
    return lines.join("\n");
  } finally {
    handle.close();
  }
}

// ---------------------------------------------------------------------------
// Startup (last, so every module-level binding above is initialized)

// Spawned without a window (by the app's boot hook) for the Glanceboard widget.
if (hasT3BackgroundWork()) syncClients();
