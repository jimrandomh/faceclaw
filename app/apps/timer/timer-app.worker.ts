/**
 * Timer app worker. The singleton window contains a stopwatch plus a list of
 * independently scheduled countdown timers. Android AlarmManager owns the
 * durable expiry path; worker timeouts keep the live UI prompt.
 */
import "@nativescript/core/globals";
import { type UiFont, GrayImage } from "../../graphics/image";
import { flattenPlanesWithDraws, planesFingerprint, singlePlane, type Plane } from "../../graphics/plane";
import { prepareFrameDraws } from "../../graphics/glyph-wire";
import { getFont } from "../../graphics/bdffont";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import * as frameTimings from "../../native/frame-timings";
import { getActiveDisplay } from "../../native/active-display";
import {
  cancelTimerNotification,
  fireTimerNotification,
  scheduleTimerNotification,
} from "../../native/timer-notifications";
import { defaultWindowMenuItems, WindowMenu } from "../../ui/window-menu";
import type { WorkerAppMessage, WorkerAppReply } from "../../ui/shell/worker-window";
import type { ToolResult, ToolSpec } from "../../assistant/tool-registry";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_SCROLL, type InputEvent } from "../../ui/gestures";
import { clamp } from "../../util/numeric-util";

declare const global: any;
declare const com: any;

const RENDER_INTERVAL_MS = 100;
const TIMER_ROW_HEIGHT = 34;
const TIMER_LIST_TOP = 52;
const FOOTER_HEIGHT = 34;

const largeFont = getFont("terminus32");
const mediumFont = getFont("terminus24");
// Resolved per use so a font-setting change applies without a worker restart.
function smallFont(): UiFont {
  return getDefaultSmallFont();
}

type TimerView = "stopwatch" | "timers" | "editor";

type TimerWindow = {
  windowId: string;
  surfaceId: string;
  viewportWidth: number;
  viewportHeight: number;
  foreground: boolean;
  /** Whether this window is the shell's input target (pushed with each message). */
  focused: boolean;
  /** Long-press window menu; created on first open. */
  menu: WindowMenu | null;
  view: TimerView;
  stopwatchAction: number;
  timerSelection: number;
  editorField: number;
  editorHours: number;
  editorMinutes: number;
  editorSeconds: number;
  editorMessage: string;
  renderTimer: ReturnType<typeof setInterval> | null;
  lastSubmittedFingerprint: string;
};

type CountdownTimer = {
  id: number;
  durationMs: number;
  endAtMs: number;
  expired: boolean;
  expiryTimeout: ReturnType<typeof setTimeout> | null;
};

const TIMER_TOOLS: ToolSpec[] = [
  {
    name: "set_timer",
    description:
      "Start a new countdown timer. Give the duration as hours/minutes/seconds; at least one must be nonzero. Returns the timer's number and when it will finish.",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "number", description: "Hours component of the duration (default 0)." },
        minutes: { type: "number", description: "Minutes component of the duration (default 0)." },
        seconds: { type: "number", description: "Seconds component of the duration (default 0)." },
      },
      additionalProperties: false,
    },
    availability: "open",
  },
  {
    name: "list_timers",
    description:
      "List the countdown timers: each timer's number, its original duration, and the time remaining (or that it has finished).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    availability: "open",
  },
  {
    name: "cancel_timer",
    description:
      "Cancel a running countdown timer, or dismiss a finished one. Give the timer number from list_timers; it may be omitted when only one timer exists. Pass all=true to clear every timer.",
    inputSchema: {
      type: "object",
      properties: {
        timer: { type: "number", description: "1-based timer number, as shown in the timer list." },
        all: { type: "boolean", description: "Clear all timers instead of a single one." },
      },
      additionalProperties: false,
    },
    availability: "open",
  },
];

const windows = new Map<string, TimerWindow>();
const timers: CountdownTimer[] = [];
let screenOn = true;
let stopwatchAccumulatedMs = 0;
let stopwatchRunningSinceMs: number | null = null;
let nextTimerSerial = 1;

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
      windows.set(message.windowId, {
        windowId: message.windowId,
        surfaceId: message.surfaceId,
        viewportWidth: message.viewport.width,
        viewportHeight: message.viewport.height,
        foreground: false,
        focused: false,
        menu: null,
        view: "stopwatch",
        stopwatchAction: 0,
        timerSelection: 0,
        editorField: 0,
        editorHours: 0,
        editorMinutes: 5,
        editorSeconds: 0,
        editorMessage: "",
        renderTimer: null,
        lastSubmittedFingerprint: "",
      });
      post({ type: "set-tools", windowId: message.windowId, tools: TIMER_TOOLS });
      syncExpiredTimers();
      break;
    case "close-window": {
      const window = windows.get(message.windowId);
      if (window?.renderTimer) clearInterval(window.renderTimer);
      windows.delete(message.windowId);
      break;
    }
    case "input": {
      const window = windows.get(message.windowId);
      if (!window) {
        frameTimings.finishFrame(message.frameId, "discarded: unknown timer window");
        break;
      }
      window.focused = message.focused;
      // Marks the main-thread -> worker hop, which is otherwise an
      // unexplained gap inside the shell's handle-input span.
      frameTimings.logFrame(message.frameId, `input received in ${message.windowId} worker`);
      handleInput(window, message.event as InputEvent, message.frameId);
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
      updateRenderTimer(window);
      if (window.foreground) renderAndSubmit(window, 0);
      break;
    }
    case "screen":
      screenOn = message.on;
      for (const window of windows.values()) updateRenderTimer(window);
      break;
    case "tool-call": {
      let result: ToolResult;
      try {
        result = handleTimerTool(message.name, message.args);
      } catch (error) {
        result = { ok: false, error: String((error as Error)?.message ?? error) };
      }
      post({ type: "tool-result", callId: message.callId, result });
      break;
    }
  }
};

// ---------------------------------------------------------------------------
// Tools

function handleTimerTool(name: string, args: any): ToolResult {
  syncExpiredTimers();
  switch (name) {
    case "set_timer": {
      const hours = toolDurationField(args?.hours, "hours");
      const minutes = toolDurationField(args?.minutes, "minutes");
      const seconds = toolDurationField(args?.seconds, "seconds");
      const durationMs = Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
      if (durationMs <= 0) return { ok: false, error: "set_timer requires a duration longer than zero" };
      addTimer(durationMs);
      const timer = timers[timers.length - 1]!;
      refreshWindowsAfterToolChange();
      return {
        ok: true,
        content:
          `Started a ${formatDuration(durationMs)} timer (timer ${timers.length}), ` +
          `finishing at ${formatClock(timer.endAtMs)}.`,
      };
    }
    case "list_timers": {
      if (timers.length === 0) return { ok: true, content: "No timers are set." };
      return { ok: true, content: timers.map(describeTimer).join("\n") };
    }
    case "cancel_timer": {
      if (args?.all === true) {
        if (timers.length === 0) return { ok: true, content: "No timers are set." };
        const count = timers.length;
        for (const timer of [...timers]) removeTimer(timer);
        refreshWindowsAfterToolChange();
        return { ok: true, content: count === 1 ? "Cleared the timer." : `Cleared ${count} timers.` };
      }
      if (timers.length === 0) return { ok: true, content: "No timers are set." };
      let timer: CountdownTimer;
      if (args?.timer === undefined || args?.timer === null) {
        if (timers.length > 1) {
          return {
            ok: false,
            error: `There are ${timers.length} timers; give the timer number.\n${timers.map(describeTimer).join("\n")}`,
          };
        }
        timer = timers[0]!;
      } else {
        const index = Math.floor(Number(args.timer));
        if (!Number.isFinite(index) || index < 1 || index > timers.length) {
          return { ok: false, error: `No timer ${args.timer}; there are ${timers.length} timers.` };
        }
        timer = timers[index - 1]!;
      }
      const description = describeTimer(timer);
      removeTimer(timer);
      refreshWindowsAfterToolChange();
      return { ok: true, content: `${timer.expired ? "Dismissed" : "Canceled"}: ${description}` };
    }
    default:
      return { ok: false, error: `Unknown timer tool: ${name}` };
  }
}

function toolDurationField(value: unknown, label: string): number {
  if (value === undefined || value === null) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label} value: ${value}`);
  }
  return parsed;
}

function describeTimer(timer: CountdownTimer): string {
  const number = timers.indexOf(timer) + 1;
  const duration = formatDuration(timer.durationMs);
  if (timer.expired) return `Timer ${number}: ${duration} timer, finished.`;
  return (
    `Timer ${number}: ${duration} timer, ${formatCountdown(timer.endAtMs - Date.now())} remaining ` +
    `(finishes at ${formatClock(timer.endAtMs)}).`
  );
}

/** Repaint and re-gate every window after a tool call changed the timer list. */
function refreshWindowsAfterToolChange(): void {
  for (const window of windows.values()) {
    window.timerSelection = clamp(window.timerSelection, 0, timers.length + 1);
    updateRenderTimer(window);
    if (window.foreground && screenOn) renderAndSubmit(window, 0);
  }
}

/** The window's long-press menu (default entries only), created lazily. */
function windowMenu(window: TimerWindow): WindowMenu {
  if (!window.menu) {
    window.menu = new WindowMenu({
      size: { width: window.viewportWidth, height: window.viewportHeight },
      paintBase: () => paintContent(window),
      isFocused: () => window.focused,
    });
  }
  return window.menu;
}

function handleInput(window: TimerWindow, event: InputEvent, frameId: number): void {
  // An open window menu owns all input (it closes itself via pop).
  if (window.menu?.isOpen()) {
    window.menu
      .handleInput(event)
      .catch((error) => console.error(`timer menu input failed: ${error}`))
      .then(() => renderAndSubmit(window, frameId));
    return;
  }
  if (event.type === "long-press") {
    windowMenu(window).open(defaultWindowMenuItems(window.windowId, post));
    renderAndSubmit(window, frameId);
    return;
  }
  if (event.type === "double-click") {
    if (window.view === "editor") {
      window.view = "timers";
      window.editorMessage = "";
      updateRenderTimer(window);
      renderAndSubmit(window, frameId);
    } else {
      frameTimings.finishFrame(frameId, "discarded: timer yielded focus");
      post({ type: "yield-focus", windowId: window.windowId });
    }
    return;
  }

  if (window.view === "stopwatch") {
    handleStopwatchInput(window, event, frameId);
  } else if (window.view === "timers") {
    handleTimersInput(window, event, frameId);
  } else {
    handleEditorInput(window, event, frameId);
  }
}

function handleStopwatchInput(window: TimerWindow, event: InputEvent, frameId: number): void {
  if (event.type === "scroll-up" || event.type === "scroll-down") {
    const delta = event.type === "scroll-down" ? 1 : -1;
    window.stopwatchAction = clamp(window.stopwatchAction + delta, 0, 2);
    renderAndSubmit(window, frameId);
    return;
  }
  if (event.type !== "click") {
    frameTimings.finishFrame(frameId, "discarded: timer stopwatch ignored input");
    return;
  }

  if (window.stopwatchAction === 0) {
    if (stopwatchRunningSinceMs === null) {
      stopwatchRunningSinceMs = Date.now();
    } else {
      stopwatchAccumulatedMs += Date.now() - stopwatchRunningSinceMs;
      stopwatchRunningSinceMs = null;
    }
  } else if (window.stopwatchAction === 1) {
    stopwatchAccumulatedMs = 0;
    stopwatchRunningSinceMs = null;
  } else {
    window.view = "timers";
    window.timerSelection = 0;
  }
  updateRenderTimer(window);
  renderAndSubmit(window, frameId);
}

function handleTimersInput(window: TimerWindow, event: InputEvent, frameId: number): void {
  syncExpiredTimers();
  const itemCount = timers.length + 2; // Stopwatch navigation + New timer + timers.
  if (event.type === "scroll-up" || event.type === "scroll-down") {
    const delta = event.type === "scroll-down" ? 1 : -1;
    window.timerSelection = clamp(window.timerSelection + delta, 0, itemCount - 1);
    renderAndSubmit(window, frameId);
    return;
  }
  if (event.type !== "click") {
    frameTimings.finishFrame(frameId, "discarded: timer list ignored input");
    return;
  }

  if (window.timerSelection === 0) {
    window.view = "stopwatch";
  } else if (window.timerSelection === 1) {
    openEditor(window);
  } else {
    const timer = timers[window.timerSelection - 2];
    if (timer) removeTimer(timer);
    window.timerSelection = clamp(window.timerSelection, 0, Math.max(0, timers.length + 1));
  }
  updateRenderTimer(window);
  renderAndSubmit(window, frameId);
}

function handleEditorInput(window: TimerWindow, event: InputEvent, frameId: number): void {
  if (event.type === "scroll-up" || event.type === "scroll-down") {
    const delta = event.type === "scroll-up" ? 1 : -1;
    if (window.editorField === 0) {
      window.editorHours = clamp(window.editorHours + delta, 0, 23);
    } else if (window.editorField === 1) {
      window.editorMinutes = clamp(window.editorMinutes + delta, 0, 59);
    } else if (window.editorField === 2) {
      window.editorSeconds = clamp(window.editorSeconds + delta, 0, 59);
    } else {
      window.editorField = delta > 0 ? 2 : 3;
    }
    window.editorMessage = "";
    renderAndSubmit(window, frameId);
    return;
  }
  if (event.type !== "click") {
    frameTimings.finishFrame(frameId, "discarded: timer editor ignored input");
    return;
  }

  if (window.editorField < 3) {
    window.editorField += 1;
  } else {
    const durationMs =
      ((window.editorHours * 60 + window.editorMinutes) * 60 + window.editorSeconds) * 1000;
    if (durationMs <= 0) {
      window.editorMessage = "Choose a duration";
      window.editorField = 0;
    } else {
      addTimer(durationMs);
      window.view = "timers";
      window.timerSelection = timers.length + 1;
      window.editorMessage = "";
    }
  }
  updateRenderTimer(window);
  renderAndSubmit(window, frameId);
}

function openEditor(window: TimerWindow): void {
  window.view = "editor";
  window.editorField = 0;
  window.editorHours = 0;
  window.editorMinutes = 5;
  window.editorSeconds = 0;
  window.editorMessage = "";
}

function addTimer(durationMs: number): void {
  // Millisecond epoch plus a small serial is unique across worker restarts and
  // still safely representable as a JavaScript/Java long bridge value.
  const id = Date.now() * 100 + (nextTimerSerial++ % 100);
  const endAtMs = Date.now() + durationMs;
  const timer: CountdownTimer = {
    id,
    durationMs,
    endAtMs,
    expired: false,
    expiryTimeout: null,
  };
  timers.push(timer);
  const durationLabel = formatDuration(durationMs);
  scheduleTimerNotification(id, endAtMs, durationLabel);
  timer.expiryTimeout = setTimeout(() => expireTimer(timer), Math.max(0, endAtMs - Date.now()));
}

function expireTimer(timer: CountdownTimer, renderWindows = true): void {
  if (timer.expired) return;
  timer.expired = true;
  timer.expiryTimeout = null;
  fireTimerNotification(timer.id, formatDuration(timer.durationMs));
  for (const window of windows.values()) {
    post({ type: "set-attention", windowId: window.windowId, attention: true });
    updateRenderTimer(window);
    if (renderWindows && window.foreground && screenOn) renderAndSubmit(window, 0);
  }
}

function removeTimer(timer: CountdownTimer): void {
  if (timer.expiryTimeout) clearTimeout(timer.expiryTimeout);
  cancelTimerNotification(timer.id);
  const index = timers.indexOf(timer);
  if (index >= 0) timers.splice(index, 1);
}

function syncExpiredTimers(): void {
  const now = Date.now();
  for (const timer of timers) {
    // The caller is already about to paint, so avoid a nested render when a
    // sleeping/backgrounded timer is first observed as finished.
    if (!timer.expired && timer.endAtMs <= now) expireTimer(timer, false);
  }
}

function updateRenderTimer(window: TimerWindow): void {
  const activeCountdowns = timers.some((timer) => !timer.expired);
  const dynamic =
    (window.view === "stopwatch" && stopwatchRunningSinceMs !== null) ||
    (window.view === "timers" && activeCountdowns);
  const shouldRun = dynamic && window.foreground && screenOn;
  if (shouldRun && window.renderTimer === null) {
    window.renderTimer = setInterval(() => {
      syncExpiredTimers();
      renderAndSubmit(window, 0);
    }, RENDER_INTERVAL_MS);
  } else if (!shouldRun && window.renderTimer !== null) {
    clearInterval(window.renderTimer);
    window.renderTimer = null;
  }
}

function paint(window: TimerWindow): Plane[] {
  if (window.menu?.isOpen()) {
    return window.menu.paint();
  }
  return singlePlane(paintContent(window));
}

function paintContent(window: TimerWindow): GrayImage {
  syncExpiredTimers();
  const image = new GrayImage(window.viewportWidth, window.viewportHeight, 0);
  if (window.view === "stopwatch") {
    paintStopwatch(image, window);
  } else if (window.view === "timers") {
    paintTimers(image, window);
  } else {
    paintEditor(image, window);
  }
  return image;
}

function paintStopwatch(image: GrayImage, window: TimerWindow): void {
  drawTabs(image, "stopwatch");
  const elapsed = stopwatchElapsedMs();
  const timeLabel = formatStopwatchElapsed(elapsed);
  const timeX = Math.max(0, Math.round((window.viewportWidth - largeFont.measureText(timeLabel)) / 2));
  image.drawText(largeFont, timeX, 66, timeLabel, 245);

  const state = stopwatchRunningSinceMs === null ? (elapsed > 0 ? "Paused" : "Ready") : "Running";
  drawCenteredText(image, smallFont(), 112, state, 145);

  const labels = [stopwatchRunningSinceMs === null ? "Start" : "Pause", "Reset", `Timers (${timers.length})`];
  drawButtonRow(image, labels, window.stopwatchAction, 154);
  drawFooter(image, `${GESTURE_SCROLL} action   ${GESTURE_CLICK} select   ${GESTURE_DOUBLE_CLICK} back`);
}

function paintTimers(image: GrayImage, window: TimerWindow): void {
  drawTabs(image, "timers");
  const items = ["< Stopwatch", "+ New timer", ...timers.map(timerRowLabel)];
  const listBottom = image.height - FOOTER_HEIGHT;
  const visibleRows = Math.max(1, Math.floor((listBottom - TIMER_LIST_TOP) / TIMER_ROW_HEIGHT));
  const first = clamp(window.timerSelection - visibleRows + 1, 0, Math.max(0, items.length - visibleRows));

  for (let row = 0; row < visibleRows; row++) {
    const index = first + row;
    if (index >= items.length) break;
    const y = TIMER_LIST_TOP + row * TIMER_ROW_HEIGHT;
    const selected = index === window.timerSelection;
    if (selected) {
      image.fillRoundedRect(18, y, image.width - 36, TIMER_ROW_HEIGHT - 4, 34, 5);
      image.drawRect(18, y, image.width - 36, TIMER_ROW_HEIGHT - 4, 105);
    }
    image.drawText(index >= 2 ? mediumFont : smallFont(), 32, y + (index >= 2 ? 2 : 7), items[index]!, selected ? 245 : 180);
  }

  const selectedTimer = window.timerSelection >= 2 ? timers[window.timerSelection - 2] : null;
  const action = selectedTimer ? (selectedTimer.expired ? "dismiss" : "cancel") : "select";
  drawFooter(image, `${GESTURE_SCROLL} timer   ${GESTURE_CLICK} ${action}   ${GESTURE_DOUBLE_CLICK} back`);
}

function paintEditor(image: GrayImage, window: TimerWindow): void {
  image.drawText(smallFont(), 24, 14, "New timer", 190);
  const fields = [pad2(window.editorHours), pad2(window.editorMinutes), pad2(window.editorSeconds)];
  const labels = ["hours", "minutes", "seconds"];
  const fieldWidth = 118;
  const gap = 22;
  const totalWidth = fieldWidth * 3 + gap * 2;
  const startX = Math.round((image.width - totalWidth) / 2);

  for (let index = 0; index < 3; index++) {
    const x = startX + index * (fieldWidth + gap);
    if (window.editorField === index) {
      image.fillRoundedRect(x, 57, fieldWidth, 68, 35, 6);
      image.drawRect(x, 57, fieldWidth, 68, 120);
    }
    drawCenteredIn(image, largeFont, x, fieldWidth, 65, fields[index]!, window.editorField === index ? 250 : 180);
    drawCenteredIn(image, smallFont(), x, fieldWidth, 105, labels[index]!, 125);
    if (index < 2) image.drawText(mediumFont, x + fieldWidth + 5, 71, ":", 130);
  }

  const startSelected = window.editorField === 3;
  const buttonWidth = 160;
  const buttonX = Math.round((image.width - buttonWidth) / 2);
  if (startSelected) {
    image.fillRoundedRect(buttonX, 151, buttonWidth, 38, 40, 6);
    image.drawRect(buttonX, 151, buttonWidth, 38, 120);
  }
  drawCenteredIn(image, smallFont(), buttonX, buttonWidth, 162, "Start timer", startSelected ? 250 : 175);
  if (window.editorMessage) drawCenteredText(image, smallFont(), 202, window.editorMessage, 190);
  drawFooter(image, `${GESTURE_SCROLL} adjust   ${GESTURE_CLICK} next   ${GESTURE_DOUBLE_CLICK} cancel`);
}

function drawTabs(image: GrayImage, active: "stopwatch" | "timers"): void {
  const stopwatch = "Stopwatch";
  const timerLabel = `Timers (${timers.length})`;
  const left = 24;
  const dividerX = left + smallFont().measureText(stopwatch) + 18;
  image.drawText(smallFont(), left, 15, stopwatch, active === "stopwatch" ? 245 : 105);
  image.drawLine(left, 35, dividerX - 12, 35, active === "stopwatch" ? 200 : 30);
  image.drawText(smallFont(), dividerX, 15, timerLabel, active === "timers" ? 245 : 105);
  image.drawLine(dividerX, 35, dividerX + smallFont().measureText(timerLabel), 35, active === "timers" ? 200 : 30);
}

function drawButtonRow(image: GrayImage, labels: string[], selected: number, y: number): void {
  const gap = 12;
  const margin = 24;
  const width = Math.floor((image.width - margin * 2 - gap * (labels.length - 1)) / labels.length);
  for (let index = 0; index < labels.length; index++) {
    const x = margin + index * (width + gap);
    if (index === selected) {
      image.fillRoundedRect(x, y, width, 40, 38, 6);
      image.drawRect(x, y, width, 40, 115);
    }
    drawCenteredIn(image, smallFont(), x, width, y + 12, labels[index]!, index === selected ? 245 : 155);
  }
}

function drawFooter(image: GrayImage, text: string): void {
  image.drawLine(16, image.height - FOOTER_HEIGHT, image.width - 16, image.height - FOOTER_HEIGHT, 35);
  drawCenteredText(image, smallFont(), image.height - 22, text, 115);
}

function drawCenteredText(image: GrayImage, font: UiFont, y: number, text: string, value: number): void {
  image.drawText(font, Math.round((image.width - font.measureText(text)) / 2), y, text, value);
}

function drawCenteredIn(
  image: GrayImage,
  font: UiFont,
  x: number,
  width: number,
  y: number,
  text: string,
  value: number,
): void {
  image.drawText(font, Math.round(x + (width - font.measureText(text)) / 2), y, text, value);
}

function timerRowLabel(timer: CountdownTimer): string {
  const number = timers.indexOf(timer) + 1;
  if (timer.expired) return `${number}.  00:00  Finished`;
  return `${number}.  ${formatCountdown(timer.endAtMs - Date.now())}  Running`;
}

function renderAndSubmit(window: TimerWindow, inputFrameId: number): void {
  const frameId = inputFrameId > 0 ? inputFrameId : frameTimings.startFrame(`render:${window.windowId}`);
  try {
    const paintStartedAtMs = Date.now();
    const planes = frameTimings.span(frameId, "paint", () =>
      frameTimings.runWithFrame(frameId, () => paint(window)),
    );
    const paintMs = Date.now() - paintStartedAtMs;
    const fingerprint = planesFingerprint(planes);
    if (fingerprint === window.lastSubmittedFingerprint) {
      frameTimings.finishFrame(frameId, "discarded: timer content unchanged");
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
    frameTimings.finishFrame(frameId, "discarded: timer render failed");
    console.error(`timer worker render failed: ${error}`);
  }
}

function stopwatchElapsedMs(): number {
  const runningMs = stopwatchRunningSinceMs === null ? 0 : Date.now() - stopwatchRunningSinceMs;
  return stopwatchAccumulatedMs + runningMs;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatStopwatchElapsed(totalMs: number): string {
  const totalTenths = Math.floor(totalMs / 100);
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(seconds)}.${tenths}`
    : `${pad2(minutes)}:${pad2(seconds)}.${tenths}`;
}

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${pad2(minutes)}:${pad2(seconds)}`;
}

function formatClock(timestampMs: number): string {
  const date = new Date(timestampMs);
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const meridiem = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${hours}:${minutes} ${meridiem}`;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

