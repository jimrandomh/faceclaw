/**
 * The Timers app window: one screen for countdown timers, the stopwatch and
 * alarms. See notes/timers-app-design.md for the design.
 *
 * Layout is stage + list. The right ~40% is a list of rows under three
 * section headers (TIMERS / STOPWATCH / ALARMS); the selected row is shown
 * large on the left stage. Scroll moves the selection, click does the
 * obvious thing for the selected row (pause, resume, start, stop, toggle,
 * dismiss), tap-then-hold opens the row's context menu, double-click leaves
 * the app. Pickers (the duration dial, the fine-tune fields, the alarm time
 * fields) and a ringing item's buttons are transient states of the same
 * screen and double-click cancels them.
 *
 * All state lives in the engine (timer-engine.ts); this file only paints it
 * and turns gestures into engine calls.
 */
import { GrayImage, type UiFont } from "../../graphics/image";
import { getFont } from "../../graphics/bdffont";
import { ensurePreinstalledFonts, installedFontPath } from "../../graphics/installed-fonts";
import { truncateText } from "../../graphics/textwrap";
import { TtfFont } from "../../graphics/ttf-font";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { timeFormatSetting } from "../../ui/dashboard-settings";
import {
  GESTURE_CLICK,
  GESTURE_DOUBLE_CLICK,
  GESTURE_SCROLL,
  GESTURE_SHORT_THEN_LONG_PRESS,
  gestureHints,
  type InputEvent,
} from "../../ui/gestures";
import { type Layer, type LayerContext } from "../../ui/layers";
import {
  drawListScrollbar,
  drawRightValueMenuItem,
  drawSelectionHighlight,
  drawToggleMenuItem,
  scrollToKeepSelectionVisible,
  TextPageLayer,
  type MenuItem,
} from "../../ui/menu";
import { LIST_ROW_TEXT_INSET, lineStep, listRowHeight } from "../../ui/metrics";
import { createInProcessWindow, type InProcessAppOptions, type InProcessWindow } from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";
import { WindowMenuLayer } from "../../ui/window-menu";
import { clamp } from "../../util/numeric-util";
import {
  soonestRunningTimerRemainingMs,
  timerEngine,
  timersSnoozeSetting,
  timersSoundSetting,
  timersWakeSetting,
  type RingingItem,
  type SnoozeMinutes,
} from "./timer-engine";
import {
  alarmNextRingMs,
  DAY_BITS,
  DAY_FULL_NAMES,
  DAY_LETTERS,
  DEFAULT_TIMER_DURATION_MS,
  DURATION_LADDER_MS,
  EVERY_DAY_MASK,
  formatClockAt,
  formatCountdown,
  formatDays,
  formatDurationWords,
  formatElapsed,
  formatSpanWords,
  formatTimeOfDay,
  nearestLadderIndex,
  sortAlarms,
  sortTimers,
  stopwatchElapsedMs,
  stopwatchIsRunning,
  timerDisplayName,
  timerPhase,
  timerRemainingMs,
  timerProgress,
  WEEKDAYS_MASK,
  WEEKEND_MASK,
  type Alarm,
  type CountdownTimer,
} from "./timer-model";

export const TIMER_WINDOW_ID = "timer";
export const TIMER_SURFACE_ID = "window:timer";

/** Width of the list column, as a share of the viewport, and its bounds. */
const LIST_SHARE = 0.4;
const LIST_MIN_WIDTH = 190;
const LIST_MAX_WIDTH = 240;
const LIST_TOP = 6;
const STAGE_X = 10;
/** Gap between the stage's right edge and the list's divider. */
const STAGE_LIST_GAP = 14;
/** Brightness factor for the list while a picker owns the stage. */
const LIST_DIM = 0.4;
/** Big-digit sizes tried largest first until the text fits the stage. */
const DIGIT_SIZES = [96, 80, 64, 52, 40];
/** Field digits in the pickers. */
const FIELD_DIGIT_SIZE = 56;
const MINUTE_MS = 60_000;

type RowKind = "header" | "timer" | "new-timer" | "stopwatch" | "alarm" | "new-alarm";

type Row = {
  key: string;
  kind: RowKind;
  title?: string;
  timer?: CountdownTimer;
  alarm?: Alarm;
};

/**
 * Screen state beyond the selection. "list" is the resting state; the rest
 * are pickers that own the stage and the scroll wheel until they finish or
 * a double-click cancels them.
 */
type Mode =
  | { kind: "list" }
  | { kind: "dial"; index: number; label: string }
  | { kind: "fine"; hours: number; minutes: number; seconds: number; field: number; label: string }
  | { kind: "alarm-time"; alarmId: number | null; hour: number; minute: number; field: number };

type LabelTarget = { kind: "timer" | "alarm"; id: number } | { kind: "new-timer" };

function timerKey(timer: CountdownTimer): string {
  return `timer:${timer.id}`;
}

function alarmKey(alarm: Alarm): string {
  return `alarm:${alarm.id}`;
}

function ringingKey(item: RingingItem): string {
  return item.kind === "timer" ? timerKey(item.timer) : alarmKey(item.alarm);
}

function twelveHour(): boolean {
  return timeFormatSetting.get() === "12h";
}

function smallFont(): UiFont {
  return getDefaultSmallFont();
}

function mediumFont(): UiFont {
  return getDefaultMediumFont();
}

// ---------------------------------------------------------------------------
// Big digits

let digitFontsEnsured = false;

/** The bundled Roboto Bold at a pixel size, or the largest bitmap face off-Android. */
function digitFont(sizePx: number): UiFont {
  if (!digitFontsEnsured) {
    digitFontsEnsured = true;
    try {
      ensurePreinstalledFonts();
    } catch (error) {
      console.warn(`timers digit font preinstall failed: ${error}`);
    }
  }
  return TtfFont.load(installedFontPath("Roboto-Bold.ttf"), sizePx) ?? getFont("terminus32");
}

/** The biggest digit font whose rendering of `text` fits `maxWidth`. */
function fittingDigitFont(text: string, maxWidth: number, sizes: readonly number[] = DIGIT_SIZES): UiFont {
  let font = digitFont(sizes[0]!);
  for (const size of sizes) {
    font = digitFont(size);
    if (font.measureText(text) <= maxWidth) return font;
  }
  return font;
}

// ---------------------------------------------------------------------------
// The layer

export class TimersLayer implements Layer {
  readonly acceptsDirectional = true;

  private selectionKey = "";
  private scrollRow = 0;
  private mode: Mode = { kind: "list" };
  /** Which of the ringing stage's two buttons is highlighted. */
  private ringButton = 0;
  /** Where the next text input (a label) goes; null means the selected item. */
  private labelTarget: LabelTarget | null = null;
  /** Ringing items already jumped to, so a second ring doesn't re-pin. */
  private seenRinging = new Set<string>();
  /** Set the first time this layer paints, to land the selection sensibly. */
  private initialised = false;
  /** Feedback shown on the stage after a picker refuses (e.g. zero duration). */
  private notice = "";

  // -------------------------------------------------------------------------
  // Rows

  private buildRows(now: number): Row[] {
    const state = timerEngine.state;
    const rows: Row[] = [{ key: "h:timers", kind: "header", title: "TIMERS" }];
    for (const timer of sortTimers(state.timers, now)) rows.push({ key: timerKey(timer), kind: "timer", timer });
    rows.push({ key: "new-timer", kind: "new-timer" });
    rows.push({ key: "h:stopwatch", kind: "header", title: "STOPWATCH" }, { key: "stopwatch", kind: "stopwatch" });
    rows.push({ key: "h:alarms", kind: "header", title: "ALARMS" });
    for (const alarm of sortAlarms(state.alarms)) rows.push({ key: alarmKey(alarm), kind: "alarm", alarm });
    rows.push({ key: "new-alarm", kind: "new-alarm" });
    return rows;
  }

  /** The most urgent row: ringing, then a running timer, a running stopwatch, else New timer. */
  private defaultSelection(rows: Row[]): string {
    const ringing = timerEngine.ringingItems()[0];
    if (ringing) return ringingKey(ringing);
    const running = rows.find((row) => row.timer && timerPhase(row.timer) === "running");
    if (running) return running.key;
    if (stopwatchIsRunning(timerEngine.state.stopwatch)) return "stopwatch";
    return "new-timer";
  }

  /** Keep the selection on a real, selectable row after the rows change. */
  private reconcileSelection(rows: Row[]): number {
    if (!this.initialised) {
      this.initialised = true;
      this.selectionKey = this.defaultSelection(rows);
      for (const item of timerEngine.ringingItems()) this.seenRinging.add(ringingKey(item));
    }
    let index = rows.findIndex((row) => row.key === this.selectionKey);
    if (index < 0) {
      // The row went away (a dismissed timer, a deleted alarm): stay in place.
      index = clamp(this.scrollRow, 0, rows.length - 1);
      while (index < rows.length && rows[index]!.kind === "header") index++;
      if (index >= rows.length) index = rows.findIndex((row) => row.kind !== "header");
      this.selectionKey = rows[index]!.key;
    }
    return index;
  }

  private selectedRow(rows: Row[]): Row {
    return rows[this.reconcileSelection(rows)]!;
  }

  private moveSelection(rows: Row[], delta: number): void {
    const count = rows.length;
    let index = this.reconcileSelection(rows);
    for (let step = 0; step < count; step++) {
      index = (index + delta + count) % count;
      if (rows[index]!.kind !== "header") break;
    }
    this.selectionKey = rows[index]!.key;
  }

  /** Called on every engine change: jump to a newly ringing item. */
  onEngineChanged(): void {
    const ringing = timerEngine.ringingItems();
    const keys = new Set(ringing.map(ringingKey));
    for (const key of Array.from(this.seenRinging)) {
      if (!keys.has(key)) this.seenRinging.delete(key);
    }
    for (const item of ringing) {
      const key = ringingKey(item);
      if (this.seenRinging.has(key)) continue;
      this.seenRinging.add(key);
      this.selectionKey = key;
      this.ringButton = 0;
      this.mode = { kind: "list" };
      this.notice = "";
    }
  }

  private ringingOf(row: Row): RingingItem | null {
    if (row.timer && row.timer.rungAtMs !== null) return { kind: "timer", timer: row.timer };
    if (row.alarm && row.alarm.ringingSinceMs !== null) return { kind: "alarm", alarm: row.alarm };
    return null;
  }

  // -------------------------------------------------------------------------
  // Input

  async handleInput(event: InputEvent, _ctx: LayerContext): Promise<void> {
    timerEngine.check();
    const now = Date.now();
    const rows = this.buildRows(now);
    switch (this.mode.kind) {
      case "dial":
        this.handleDialInput(event, this.mode);
        return;
      case "fine":
        this.handleFineInput(event, this.mode);
        return;
      case "alarm-time":
        this.handleAlarmTimeInput(event, this.mode);
        return;
      default:
        this.handleListInput(event, rows);
    }
  }

  private handleListInput(event: InputEvent, rows: Row[]): void {
    const row = this.selectedRow(rows);
    const ringing = this.ringingOf(row);
    switch (event.type) {
      case "scroll-up":
      case "swipe-up":
        if (ringing) this.ringButton = 0;
        else this.moveSelection(rows, -1);
        return;
      case "scroll-down":
      case "swipe-down":
        if (ringing) this.ringButton = 1;
        else this.moveSelection(rows, 1);
        return;
      case "swipe-left":
        if (ringing) this.ringButton = 0;
        else shell.yieldFocusToSidebar();
        return;
      case "swipe-right":
        if (ringing) this.ringButton = 1;
        else this.activateRow(row);
        return;
      case "click":
        this.activateRow(row);
        return;
      case "double-click":
        shell.yieldFocusToSidebar();
        return;
      default:
        return;
    }
  }

  /** Click on a row: its primary action. */
  private activateRow(row: Row): void {
    this.notice = "";
    switch (row.kind) {
      case "timer": {
        const timer = row.timer!;
        switch (timerPhase(timer)) {
          case "running":
            timerEngine.pauseTimer(timer.id);
            return;
          case "paused":
            timerEngine.resumeTimer(timer.id);
            return;
          case "rung":
            if (this.ringButton === 0) timerEngine.removeTimer(timer.id);
            else timerEngine.restartTimer(timer.id);
            return;
        }
      }
      case "new-timer":
        this.openDial("");
        return;
      case "stopwatch":
        timerEngine.stopwatchToggle();
        return;
      case "alarm": {
        const alarm = row.alarm!;
        if (alarm.ringingSinceMs !== null) {
          if (this.ringButton === 0) timerEngine.dismissAlarm(alarm.id);
          else timerEngine.snoozeAlarm(alarm.id);
          return;
        }
        timerEngine.setAlarmEnabled(alarm.id, !alarm.enabled);
        return;
      }
      case "new-alarm":
        this.openAlarmTime(null);
        return;
      default:
        return;
    }
  }

  private openDial(label: string): void {
    const last = timerEngine.state.recentDurationsMs[0] ?? DEFAULT_TIMER_DURATION_MS;
    this.mode = { kind: "dial", index: nearestLadderIndex(last), label };
  }

  private openFine(label: string, durationMs: number): void {
    const totalSeconds = Math.round(durationMs / 1000);
    this.mode = {
      kind: "fine",
      hours: Math.min(23, Math.floor(totalSeconds / 3600)),
      minutes: Math.floor(totalSeconds / 60) % 60,
      seconds: totalSeconds % 60,
      field: 0,
      label,
    };
  }

  private openAlarmTime(alarm: Alarm | null): void {
    this.mode = {
      kind: "alarm-time",
      alarmId: alarm?.id ?? null,
      hour: alarm?.hour ?? 7,
      minute: alarm?.minute ?? 0,
      field: 0,
    };
  }

  private startTimer(durationMs: number, label: string): void {
    const timer = timerEngine.startTimer(durationMs, label);
    this.selectionKey = timerKey(timer);
    this.mode = { kind: "list" };
    this.notice = "";
  }

  private handleDialInput(event: InputEvent, mode: Extract<Mode, { kind: "dial" }>): void {
    switch (event.type) {
      case "scroll-up":
      case "swipe-up":
        mode.index = Math.min(DURATION_LADDER_MS.length - 1, mode.index + 1);
        return;
      case "scroll-down":
      case "swipe-down":
        mode.index = Math.max(0, mode.index - 1);
        return;
      case "click":
      case "swipe-right":
        this.startTimer(DURATION_LADDER_MS[mode.index]!, mode.label);
        return;
      case "double-click":
      case "swipe-left":
        this.mode = { kind: "list" };
        return;
      default:
        return;
    }
  }

  private handleFineInput(event: InputEvent, mode: Extract<Mode, { kind: "fine" }>): void {
    const adjust = (delta: number) => {
      if (mode.field === 0) mode.hours = (mode.hours + delta + 24) % 24;
      else if (mode.field === 1) mode.minutes = (mode.minutes + delta + 60) % 60;
      else mode.seconds = (mode.seconds + delta + 60) % 60;
      this.notice = "";
    };
    switch (event.type) {
      case "scroll-up":
      case "swipe-up":
        adjust(1);
        return;
      case "scroll-down":
      case "swipe-down":
        adjust(-1);
        return;
      case "swipe-right":
        mode.field = Math.min(2, mode.field + 1);
        return;
      case "swipe-left":
        mode.field = Math.max(0, mode.field - 1);
        return;
      case "click": {
        if (mode.field < 2) {
          mode.field++;
          return;
        }
        const durationMs = ((mode.hours * 60 + mode.minutes) * 60 + mode.seconds) * 1000;
        if (durationMs <= 0) {
          this.notice = "Choose a duration longer than zero";
          mode.field = 0;
          return;
        }
        this.startTimer(durationMs, mode.label);
        return;
      }
      case "double-click":
        if (mode.field > 0) mode.field--;
        else this.mode = { kind: "list" };
        return;
      default:
        return;
    }
  }

  /** Field count of the alarm time picker: hour, minute tens, minute ones, and AM/PM in 12-hour mode. */
  private alarmFieldCount(): number {
    return twelveHour() ? 4 : 3;
  }

  private handleAlarmTimeInput(event: InputEvent, mode: Extract<Mode, { kind: "alarm-time" }>): void {
    const fields = this.alarmFieldCount();
    const adjust = (delta: number) => {
      const tens = Math.floor(mode.minute / 10);
      const ones = mode.minute % 10;
      if (mode.field === 0) {
        if (twelveHour()) {
          // Step within the current half of the day (1..12 wraps without flipping AM/PM).
          const pm = mode.hour >= 12;
          const hour12 = ((mode.hour + 11) % 12) + 1;
          const next = ((hour12 - 1 + delta + 12) % 12) + 1;
          mode.hour = (next % 12) + (pm ? 12 : 0);
        } else {
          mode.hour = (mode.hour + delta + 24) % 24;
        }
      } else if (mode.field === 1) {
        mode.minute = ((tens + delta + 6) % 6) * 10 + ones;
      } else if (mode.field === 2) {
        mode.minute = tens * 10 + ((ones + delta + 10) % 10);
      } else {
        mode.hour = (mode.hour + 12) % 24;
      }
    };
    switch (event.type) {
      case "scroll-up":
      case "swipe-up":
        adjust(1);
        return;
      case "scroll-down":
      case "swipe-down":
        adjust(-1);
        return;
      case "swipe-right":
        mode.field = Math.min(fields - 1, mode.field + 1);
        return;
      case "swipe-left":
        mode.field = Math.max(0, mode.field - 1);
        return;
      case "click": {
        if (mode.field < fields - 1) {
          mode.field++;
          return;
        }
        if (mode.alarmId === null) {
          const alarm = timerEngine.addAlarm(mode.hour, mode.minute, 0, "");
          this.selectionKey = alarmKey(alarm);
        } else {
          timerEngine.setAlarmTime(mode.alarmId, mode.hour, mode.minute);
        }
        this.mode = { kind: "list" };
        return;
      }
      case "double-click":
        if (mode.field > 0) mode.field--;
        else this.mode = { kind: "list" };
        return;
      default:
        return;
    }
  }

  /** A mirror touch: on the list, select the row under it. */
  hitTest(x: number, y: number, ctx: LayerContext): boolean {
    if (this.mode.kind !== "list") return false;
    const { width, height } = ctx.stack.getBaseSize();
    const listX = width - listWidthFor(width);
    if (x < listX) return false;
    const rows = this.buildRows(Date.now());
    this.reconcileSelection(rows);
    const rowHeight = listRowHeight(smallFont());
    const index = this.scrollRow + Math.floor((y - LIST_TOP) / rowHeight);
    const row = rows[index];
    if (!row || row.kind === "header" || y < LIST_TOP || y > height) return true;
    if (this.selectionKey === row.key) {
      this.activateRow(row);
    } else {
      this.selectionKey = row.key;
      this.ringButton = 0;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Text input (labels)

  receiveTextInput(text: string): void {
    const label = text.trim();
    const target = this.labelTarget;
    this.labelTarget = null;
    if (target?.kind === "new-timer" || (!target && (this.mode.kind === "dial" || this.mode.kind === "fine"))) {
      if (this.mode.kind === "dial" || this.mode.kind === "fine") this.mode.label = label;
      return;
    }
    if (target?.kind === "timer") {
      timerEngine.setTimerLabel(target.id, label);
      return;
    }
    if (target?.kind === "alarm") {
      timerEngine.setAlarmLabel(target.id, label);
      return;
    }
    const row = this.selectedRow(this.buildRows(Date.now()));
    if (row.timer) timerEngine.setTimerLabel(row.timer.id, label);
    else if (row.alarm) timerEngine.setAlarmLabel(row.alarm.id, label);
  }

  /** Aim the shell's text-entry dialog at a label, then open it. */
  private askForLabel(target: LabelTarget): void {
    this.labelTarget = target;
    shell.startVoiceInput();
  }

  // -------------------------------------------------------------------------
  // Context menus

  menuItems(): MenuItem[] {
    if (this.mode.kind === "alarm-time") return [];
    if (this.mode.kind === "dial" || this.mode.kind === "fine") return this.pickerMenuItems(this.mode);
    const now = Date.now();
    const row = this.selectedRow(this.buildRows(now));
    const items: MenuItem[] = [];
    switch (row.kind) {
      case "timer":
        items.push(...this.timerMenuItems(row.timer!));
        break;
      case "new-timer":
        for (const durationMs of timerEngine.state.recentDurationsMs) {
          items.push({
            label: `Start ${formatDurationWords(durationMs)}`,
            onSelect: (ctx) => {
              ctx.stack.pop();
              this.startTimer(durationMs, "");
            },
          });
        }
        items.push({
          label: "Fine-tune a duration",
          onSelect: (ctx) => {
            ctx.stack.pop();
            this.openFine("", timerEngine.state.recentDurationsMs[0] ?? DEFAULT_TIMER_DURATION_MS);
          },
        });
        break;
      case "stopwatch":
        items.push(...this.stopwatchMenuItems());
        break;
      case "alarm":
        items.push(...this.alarmMenuItems(row.alarm!));
        break;
      default:
        break;
    }
    items.push({
      label: "Settings",
      onSelect: (ctx) => ctx.stack.push(new WindowMenuLayer("Timers settings", this.settingsMenuItems())),
    });
    return items;
  }

  private pickerMenuItems(mode: Extract<Mode, { kind: "dial" | "fine" }>): MenuItem[] {
    const items: MenuItem[] = [];
    if (mode.kind === "dial") {
      items.push({
        label: "Fine-tune (h:mm:ss)",
        onSelect: (ctx) => {
          ctx.stack.pop();
          this.openFine(mode.label, DURATION_LADDER_MS[mode.index]!);
        },
      });
    }
    items.push({
      label: mode.label ? `Label: ${mode.label}` : "Set a label",
      onSelect: (ctx) => {
        ctx.stack.pop();
        this.askForLabel({ kind: "new-timer" });
      },
    });
    items.push({
      label: "Cancel",
      onSelect: (ctx) => {
        ctx.stack.pop();
        this.mode = { kind: "list" };
      },
    });
    return items;
  }

  private timerMenuItems(timer: CountdownTimer): MenuItem[] {
    const phase = timerPhase(timer);
    const items: MenuItem[] = [];
    if (phase === "rung") {
      items.push(
        { label: "Dismiss", onSelect: (ctx) => { ctx.stack.pop(); timerEngine.removeTimer(timer.id); } },
        { label: "Again", onSelect: (ctx) => { ctx.stack.pop(); timerEngine.restartTimer(timer.id); } },
      );
    }
    items.push({
      label: "+1 minute",
      onSelect: (ctx) => {
        ctx.stack.pop();
        timerEngine.addTimerTime(timer.id, MINUTE_MS);
      },
    });
    if (phase === "running") {
      items.push({ label: "Pause", onSelect: (ctx) => { ctx.stack.pop(); timerEngine.pauseTimer(timer.id); } });
    } else if (phase === "paused") {
      items.push({ label: "Resume", onSelect: (ctx) => { ctx.stack.pop(); timerEngine.resumeTimer(timer.id); } });
    }
    if (phase !== "rung") {
      items.push({ label: "Restart", onSelect: (ctx) => { ctx.stack.pop(); timerEngine.restartTimer(timer.id); } });
    }
    items.push({
      label: timer.label ? `Label: ${timer.label}` : "Set a label",
      onSelect: (ctx) => {
        ctx.stack.pop();
        this.askForLabel({ kind: "timer", id: timer.id });
      },
    });
    if (phase !== "rung") {
      items.push({ label: "Delete", onSelect: (ctx) => { ctx.stack.pop(); timerEngine.removeTimer(timer.id); } });
    }
    return items;
  }

  private stopwatchMenuItems(): MenuItem[] {
    const stopwatch = timerEngine.state.stopwatch;
    const running = stopwatchIsRunning(stopwatch);
    const items: MenuItem[] = [];
    if (running) {
      items.push({ label: "Lap", onSelect: (ctx) => { ctx.stack.pop(); timerEngine.stopwatchLap(); } });
    }
    items.push({
      label: running ? "Stop" : "Start",
      onSelect: (ctx) => {
        ctx.stack.pop();
        timerEngine.stopwatchToggle();
      },
    });
    items.push({
      label: "Reset",
      disabled: () => stopwatchElapsedMs(timerEngine.state.stopwatch, Date.now()) === 0,
      onSelect: (ctx) => {
        ctx.stack.pop();
        timerEngine.stopwatchReset();
      },
    });
    return items;
  }

  private alarmMenuItems(alarm: Alarm): MenuItem[] {
    const items: MenuItem[] = [];
    if (alarm.ringingSinceMs !== null) {
      items.push(
        { label: "Dismiss", onSelect: (ctx) => { ctx.stack.pop(); timerEngine.dismissAlarm(alarm.id); } },
        {
          label: `Snooze ${timersSnoozeSetting.get()} min`,
          onSelect: (ctx) => { ctx.stack.pop(); timerEngine.snoozeAlarm(alarm.id); },
        },
      );
    } else {
      items.push({
        label: alarm.enabled ? "Turn off" : "Turn on",
        onSelect: (ctx) => {
          ctx.stack.pop();
          timerEngine.setAlarmEnabled(alarm.id, !alarm.enabled);
        },
      });
    }
    items.push({
      label: "Change time",
      onSelect: (ctx) => {
        ctx.stack.pop();
        this.openAlarmTime(alarm);
      },
    });
    items.push({
      label: `Repeat: ${formatDays(alarm.days)}`,
      onSelect: (ctx) => ctx.stack.push(new WindowMenuLayer("Repeat", this.repeatMenuItems(alarm.id))),
    });
    items.push({
      label: alarm.label ? `Label: ${alarm.label}` : "Set a label",
      onSelect: (ctx) => {
        ctx.stack.pop();
        this.askForLabel({ kind: "alarm", id: alarm.id });
      },
    });
    items.push({ label: "Delete", onSelect: (ctx) => { ctx.stack.pop(); timerEngine.deleteAlarm(alarm.id); } });
    return items;
  }

  /** Repeat presets, then one toggle per weekday; the menu stays open while toggling. */
  private repeatMenuItems(alarmId: number): MenuItem[] {
    const days = () => timerEngine.findAlarm(alarmId)?.days ?? 0;
    const preset = (label: string, mask: number): MenuItem => ({
      label,
      onSelect: (ctx) => {
        ctx.stack.pop();
        timerEngine.setAlarmDays(alarmId, mask);
      },
    });
    const items: MenuItem[] = [
      preset("Once", 0),
      preset("Weekdays", WEEKDAYS_MASK),
      preset("Weekends", WEEKEND_MASK),
      preset("Every day", EVERY_DAY_MASK),
    ];
    for (let index = 0; index < 7; index++) {
      const bit = DAY_BITS[index]!;
      items.push({
        label: DAY_FULL_NAMES[index]!,
        onSelect: () => timerEngine.setAlarmDays(alarmId, days() ^ bit),
        render: (args) =>
          drawToggleMenuItem(args.image, smallFont(), args.x, args.y, args.width, args.text, (days() & bit) !== 0, args.selected),
      });
    }
    return items;
  }

  private settingsMenuItems(): MenuItem[] {
    const toggle = (label: string, get: () => boolean, set: (value: boolean) => void): MenuItem => ({
      label,
      onSelect: () => set(!get()),
      render: (args) => drawToggleMenuItem(args.image, smallFont(), args.x, args.y, args.width, args.text, get(), args.selected),
    });
    return [
      toggle(timersSoundSetting.label, () => timersSoundSetting.get(), (value) => timersSoundSetting.set(value)),
      toggle(timersWakeSetting.label, () => timersWakeSetting.get(), (value) => timersWakeSetting.set(value)),
      {
        label: timersSnoozeSetting.label,
        onSelect: () => {
          const values = timersSnoozeSetting.values;
          const next = values[(values.indexOf(timersSnoozeSetting.get()) + 1) % values.length] as SnoozeMinutes;
          timersSnoozeSetting.set(next);
        },
        render: (args) =>
          drawRightValueMenuItem(args.image, smallFont(), args.x, args.y, args.width, args.text, timersSnoozeSetting.displayValue()),
      },
      toggle("12-hour clock", () => twelveHour(), (value) => timeFormatSetting.set(value ? "12h" : "24h")),
      {
        label: "Phone alarm check",
        onSelect: (ctx) => {
          timerEngine.refreshReliability(true);
          const issues = timerEngine.phoneReliabilityIssues();
          const body =
            issues.length === 0
              ? "No problems found: the phone can ring for alarms when the glasses cannot."
              : issues.map((issue) => `- ${issue.message}`).join("\n") +
                "\n\nFix these from the warning triangle on the phone's home screen.";
          ctx.stack.push(new TextPageLayer("Phone alarm check", body));
        },
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Painting

  paint(ctx: LayerContext): GrayImage {
    timerEngine.check();
    const now = Date.now();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const rows = this.buildRows(now);
    const selectedIndex = this.reconcileSelection(rows);
    const listWidth = listWidthFor(width);
    const listX = width - listWidth;
    const picking = this.mode.kind !== "list";

    this.paintList(image, rows, selectedIndex, listX, listWidth, height, ctx.stack.isFocused(), picking ? LIST_DIM : 1, now);
    image.drawLine(listX - 7, 8, listX - 7, height - 8, picking ? 20 : 40);

    const stage = { x: STAGE_X, y: 0, width: listX - 7 - STAGE_LIST_GAP - STAGE_X, height };
    switch (this.mode.kind) {
      case "dial":
        this.paintDial(image, stage, this.mode, now);
        break;
      case "fine":
        this.paintFine(image, stage, this.mode);
        break;
      case "alarm-time":
        this.paintAlarmTime(image, stage, this.mode, now);
        break;
      default:
        this.paintStage(image, stage, rows[selectedIndex]!, now, ctx.stack.isFocused());
    }
    return image;
  }

  private paintList(
    image: GrayImage,
    rows: Row[],
    selectedIndex: number,
    listX: number,
    listWidth: number,
    height: number,
    focused: boolean,
    dim: number,
    now: number,
  ): void {
    const font = smallFont();
    const rowHeight = listRowHeight(font);
    const visible = Math.max(1, Math.floor((height - 2 * LIST_TOP) / rowHeight));
    this.scrollRow = scrollToKeepSelectionVisible(this.scrollRow, selectedIndex, visible, rows.length);
    const shade = (value: number) => Math.round(value * dim);
    const textX = listX + 8;
    const textWidth = listWidth - 24;
    const last = Math.min(rows.length, this.scrollRow + visible);
    for (let index = this.scrollRow; index < last; index++) {
      const row = rows[index]!;
      const y = LIST_TOP + (index - this.scrollRow) * rowHeight;
      const textY = y + LIST_ROW_TEXT_INSET;
      if (row.kind === "header") {
        image.drawText(font, textX, textY, row.title!, shade(90));
        continue;
      }
      const selected = index === selectedIndex;
      if (selected && dim === 1) {
        drawSelectionHighlight(image, listX, y, listWidth - 12, rowHeight - 1, focused, 6);
      }
      const bright = shade(selected ? 250 : 210);
      const soft = shade(selected ? 170 : 130);
      switch (row.kind) {
        case "timer": {
          const timer = row.timer!;
          const phase = timerPhase(timer);
          const digits = phase === "rung" ? "0:00" : formatCountdown(timerRemainingMs(timer, now));
          const digitsValue = phase === "rung" ? (Math.floor(now / 1000) % 2 ? bright : soft) : phase === "paused" ? soft : bright;
          image.drawText(font, textX, textY, digits, digitsValue);
          const digitsWidth = font.measureText(digits) + 8;
          const nameWidth = textWidth - digitsWidth - (phase === "paused" ? 12 : 0);
          if (nameWidth > 12) {
            image.drawText(font, textX + digitsWidth, textY, truncateText(font, timerDisplayName(timer), nameWidth), soft);
          }
          if (phase === "paused") drawPauseMark(image, listX + listWidth - 22, y + Math.floor(rowHeight / 2) - 5, soft);
          break;
        }
        case "new-timer":
          image.drawText(font, textX, textY, "+ New timer", shade(selected ? 220 : 150));
          break;
        case "stopwatch": {
          const stopwatch = timerEngine.state.stopwatch;
          const running = stopwatchIsRunning(stopwatch);
          const elapsed = formatElapsed(stopwatchElapsedMs(stopwatch, now), false);
          image.drawText(font, textX, textY, "Stopwatch", running ? bright : soft);
          image.drawText(font, listX + listWidth - 16 - font.measureText(elapsed), textY, elapsed, running ? bright : soft);
          break;
        }
        case "alarm": {
          const alarm = row.alarm!;
          const on = alarm.enabled;
          const time = formatTimeOfDay(alarm.hour, alarm.minute, twelveHour());
          image.drawText(font, textX, textY, time, on ? bright : soft);
          const timeWidth = font.measureText(time) + 8;
          const daysWidth = textWidth - timeWidth - 14;
          if (daysWidth > 12) {
            image.drawText(font, textX + timeWidth, textY, truncateText(font, alarm.label || formatDays(alarm.days), daysWidth), on ? soft : shade(80));
          }
          const dotX = listX + listWidth - 22;
          const dotY = y + Math.floor(rowHeight / 2) - 4;
          if (alarm.ringingSinceMs !== null || on) image.fillRoundedRect(dotX, dotY, 8, 8, on ? shade(220) : shade(90), 4);
          else image.drawRoundedRect(dotX, dotY, 8, 8, shade(90), 4);
          break;
        }
        case "new-alarm":
          image.drawText(font, textX, textY, "+ New alarm", shade(selected ? 220 : 150));
          break;
        default:
          break;
      }
    }
    if (rows.length > visible) {
      drawListScrollbar(image, listX + listWidth - 7, LIST_TOP, visible * rowHeight - 4, this.scrollRow, visible, rows.length);
    }
  }

  private paintStage(image: GrayImage, stage: StageRect, row: Row, now: number, focused: boolean): void {
    switch (row.kind) {
      case "timer":
        this.paintTimerStage(image, stage, row.timer!, now, focused);
        return;
      case "new-timer": {
        const last = timerEngine.state.recentDurationsMs[0] ?? DEFAULT_TIMER_DURATION_MS;
        const block = new StageBlock(stage);
        block.title(image, "New timer", 200);
        block.digits(image, formatCountdown(last), 110);
        block.line(image, `${formatDurationWords(last)} last time`, 120);
        block.hints(image, [[GESTURE_CLICK, "choose duration"], [GESTURE_SHORT_THEN_LONG_PRESS, "recent"]]);
        return;
      }
      case "stopwatch":
        this.paintStopwatchStage(image, stage, now);
        return;
      case "alarm":
        this.paintAlarmStage(image, stage, row.alarm!, now, focused);
        return;
      case "new-alarm": {
        const block = new StageBlock(stage);
        block.title(image, "New alarm", 200);
        block.digits(image, twelveHour() ? "7:00" : "07:00", 110);
        block.line(image, "Rings once unless you set a repeat", 120);
        block.hints(image, [[GESTURE_CLICK, "set time"]]);
        return;
      }
      default:
        return;
    }
  }

  private paintTimerStage(image: GrayImage, stage: StageRect, timer: CountdownTimer, now: number, focused: boolean): void {
    const block = new StageBlock(stage);
    const phase = timerPhase(timer);
    if (phase === "rung") {
      const flash = Math.floor(now / 1000) % 2 === 0;
      block.title(image, "Time's up", flash ? 255 : 170);
      block.digits(image, `+${formatCountdown(now - timer.rungAtMs!)}`, 200);
      block.line(image, `${timerDisplayName(timer)} · rang at ${formatClockAt(timer.rungAtMs!, twelveHour())}`, 150);
      block.buttons(image, ["Dismiss", "Again"], this.ringButton, focused);
      block.hints(image, [[GESTURE_SCROLL, "choose"], [GESTURE_CLICK, "select"]]);
      return;
    }
    const remaining = timerRemainingMs(timer, now);
    block.title(image, phase === "paused" ? `${timerDisplayName(timer)} · Paused` : timerDisplayName(timer), 200);
    block.digits(image, formatCountdown(remaining), phase === "paused" ? 150 : 250);
    block.progress(image, timerProgress(timer, now), phase === "paused" ? 120 : 200);
    const info =
      phase === "paused"
        ? `${formatDurationWords(timer.durationMs)} timer · ${formatCountdown(remaining)} left`
        : `${formatDurationWords(timer.durationMs)} timer · ends ${formatClockAt(timer.endsAtMs!, twelveHour())}`;
    block.line(image, info, 150);
    block.hints(image, [[GESTURE_CLICK, phase === "paused" ? "resume" : "pause"], [GESTURE_SHORT_THEN_LONG_PRESS, "options"]]);
  }

  private paintStopwatchStage(image: GrayImage, stage: StageRect, now: number): void {
    const stopwatch = timerEngine.state.stopwatch;
    const running = stopwatchIsRunning(stopwatch);
    const elapsed = stopwatchElapsedMs(stopwatch, now);
    const block = new StageBlock(stage);
    block.title(image, running ? "Stopwatch · Running" : elapsed > 0 ? "Stopwatch · Stopped" : "Stopwatch", 200);
    // Tenths only while stopped: the display updates once a second while running.
    block.digits(image, formatElapsed(elapsed, !running), running ? 250 : elapsed > 0 ? 200 : 130);
    const laps = stopwatch.lapsMs;
    if (laps.length > 0) {
      const font = smallFont();
      const shown = laps.slice(-Math.max(1, Math.min(4, block.linesLeft())));
      for (let index = 0; index < shown.length; index++) {
        const lapIndex = laps.length - shown.length + index;
        const total = shown[index]!;
        const split = total - (lapIndex > 0 ? laps[lapIndex - 1]! : 0);
        block.columns(image, font, [`Lap ${lapIndex + 1}`, formatElapsed(split, true), formatElapsed(total, true)], index === shown.length - 1 ? 190 : 130);
      }
    } else {
      block.line(image, running ? "" : "Laps appear here", 110);
    }
    block.hints(image, [[GESTURE_CLICK, running ? "stop" : "start"], [GESTURE_SHORT_THEN_LONG_PRESS, running ? "lap" : "reset"]]);
  }

  private paintAlarmStage(image: GrayImage, stage: StageRect, alarm: Alarm, now: number, focused: boolean): void {
    const block = new StageBlock(stage);
    const ringing = alarm.ringingSinceMs !== null;
    const flash = Math.floor(now / 1000) % 2 === 0;
    block.title(image, ringing ? (alarm.label ? `Alarm · ${alarm.label}` : "Alarm") : alarm.label || "Alarm", ringing ? (flash ? 255 : 170) : 200);
    const time = formatTimeOfDay(alarm.hour, alarm.minute, false);
    const suffix = twelveHour() ? (alarm.hour < 12 ? "AM" : "PM") : "";
    block.digits(image, twelveHour() ? formatTimeOfDay(alarm.hour, alarm.minute, true).replace(/ [AP]M$/, "") : time, alarm.enabled ? 250 : 130, suffix);
    block.days(image, alarm.days, alarm.enabled ? 230 : 110);
    if (ringing) {
      block.buttons(image, ["Dismiss", `Snooze ${timersSnoozeSetting.get()}m`], this.ringButton, focused);
      block.hints(image, [[GESTURE_SCROLL, "choose"], [GESTURE_CLICK, "select"]]);
      return;
    }
    let status: string;
    if (!alarm.enabled) status = "Off";
    else if (alarm.snoozedUntilMs !== null) status = `Snoozed until ${formatClockAt(alarm.snoozedUntilMs, twelveHour())}`;
    else {
      const next = alarmNextRingMs(alarm, now);
      status = next === null ? "Off" : `Rings in ${formatSpanWords(next - now)}`;
    }
    block.line(image, status, 150);
    const warning = timerEngine.phoneReliabilityIssues()[0];
    if (alarm.enabled && warning) block.line(image, `Phone: ${warning.message}`, 120);
    block.hints(image, [[GESTURE_CLICK, alarm.enabled ? "turn off" : "turn on"], [GESTURE_SHORT_THEN_LONG_PRESS, "edit"]]);
  }

  private paintDial(image: GrayImage, stage: StageRect, mode: Extract<Mode, { kind: "dial" }>, now: number): void {
    const durationMs = DURATION_LADDER_MS[mode.index]!;
    const block = new StageBlock(stage);
    block.title(image, mode.label ? `New timer · ${mode.label}` : "New timer", 200);
    block.digits(image, formatCountdown(durationMs), 250);
    block.line(image, `${formatDurationWords(durationMs)} · ends ${formatClockAt(now + durationMs, twelveHour())}`, 150);
    block.hints(image, [[GESTURE_SCROLL, "duration"], [GESTURE_CLICK, "start"], [GESTURE_DOUBLE_CLICK, "cancel"]]);
  }

  private paintFine(image: GrayImage, stage: StageRect, mode: Extract<Mode, { kind: "fine" }>): void {
    const block = new StageBlock(stage);
    block.title(image, mode.label ? `New timer · ${mode.label}` : "New timer", 200);
    block.fields(image, [pad2(mode.hours), pad2(mode.minutes), pad2(mode.seconds)], [":", ":"], mode.field, ["hours", "min", "sec"]);
    block.line(image, this.notice, 190);
    block.hints(image, [[GESTURE_SCROLL, "adjust"], [GESTURE_CLICK, mode.field < 2 ? "next" : "start"], [GESTURE_DOUBLE_CLICK, "back"]]);
  }

  private paintAlarmTime(image: GrayImage, stage: StageRect, mode: Extract<Mode, { kind: "alarm-time" }>, now: number): void {
    const block = new StageBlock(stage);
    block.title(image, mode.alarmId === null ? "New alarm" : "Alarm time", 200);
    const tens = String(Math.floor(mode.minute / 10));
    const ones = String(mode.minute % 10);
    if (twelveHour()) {
      const hour12 = ((mode.hour + 11) % 12) + 1;
      block.fields(image, [String(hour12), tens, ones, mode.hour < 12 ? "AM" : "PM"], [":", "", " "], mode.field, ["hour", "", "min", ""]);
    } else {
      block.fields(image, [pad2(mode.hour), tens, ones], [":", ""], mode.field, ["hour", "", "min"]);
    }
    const preview = alarmNextRingMs(
      { id: 0, hour: mode.hour, minute: mode.minute, days: 0, label: "", enabled: true, snoozedUntilMs: null, ringingSinceMs: null, lastFiredAtMs: null },
      now,
    );
    block.line(image, preview === null ? "" : `Rings in ${formatSpanWords(preview - now)}`, 150);
    const last = this.alarmFieldCount() - 1;
    block.hints(image, [[GESTURE_SCROLL, "adjust"], [GESTURE_CLICK, mode.field < last ? "next" : "save"], [GESTURE_DOUBLE_CLICK, "back"]]);
  }
}

// ---------------------------------------------------------------------------
// Stage layout helpers

type StageRect = { x: number; y: number; width: number; height: number };

/**
 * Lays the stage out top to bottom: a title line, the big digits, then
 * whatever lines follow, with the gesture hints pinned to the bottom. Keeps
 * a cursor so each element stacks under the previous one.
 */
class StageBlock {
  private cursorY: number;
  private readonly hintsTop: number;

  constructor(private readonly rect: StageRect) {
    this.cursorY = rect.y + 12;
    this.hintsTop = rect.y + rect.height - 10 - lineStep(smallFont());
  }

  title(image: GrayImage, text: string, value: number): void {
    const font = mediumFont();
    image.drawText(font, this.rect.x + 4, this.cursorY, truncateText(font, text, this.rect.width - 8), value);
    this.cursorY += font.lineHeight + 10;
  }

  /** The big number, centred; `suffix` (AM/PM) sits beside it in the medium font. */
  digits(image: GrayImage, text: string, value: number, suffix = ""): void {
    const suffixFont = mediumFont();
    const suffixWidth = suffix ? suffixFont.measureText(suffix) + 10 : 0;
    const font = fittingDigitFont(text, this.rect.width - 8 - suffixWidth);
    const textWidth = font.measureText(text);
    const x = this.rect.x + Math.max(0, Math.floor((this.rect.width - textWidth - suffixWidth) / 2));
    image.drawText(font, x, this.cursorY, text, value);
    if (suffix) {
      image.drawText(suffixFont, x + textWidth + 10, this.cursorY + font.ascent - suffixFont.ascent, suffix, Math.round(value * 0.8));
    }
    this.cursorY += font.lineHeight + 8;
  }

  progress(image: GrayImage, fraction: number, value: number): void {
    const x = this.rect.x + 6;
    const width = this.rect.width - 12;
    image.fillRoundedRect(x, this.cursorY, width, 6, 40, 3);
    const filled = Math.round(width * clamp(fraction, 0, 1));
    if (filled > 0) image.fillRoundedRect(x, this.cursorY, Math.max(6, filled), 6, value, 3);
    this.cursorY += 14;
  }

  line(image: GrayImage, text: string, value: number): void {
    if (!text) return;
    const font = smallFont();
    image.drawText(font, this.rect.x + 6, this.cursorY, truncateText(font, text, this.rect.width - 12), value);
    this.cursorY += lineStep(font);
  }

  /** How many small-font lines fit between the cursor and the hints. */
  linesLeft(): number {
    return Math.floor((this.hintsTop - 6 - this.cursorY) / lineStep(smallFont()));
  }

  /** A three-column row (lap table). */
  columns(image: GrayImage, font: UiFont, cells: string[], value: number): void {
    if (this.cursorY + font.lineHeight > this.hintsTop - 4) return;
    const x = this.rect.x + 6;
    const width = this.rect.width - 12;
    const columnWidth = Math.floor(width / cells.length);
    for (let index = 0; index < cells.length; index++) {
      const text = cells[index]!;
      const cellX = index === 0 ? x : x + index * columnWidth + columnWidth - font.measureText(text);
      image.drawText(font, cellX, this.cursorY, text, value);
    }
    this.cursorY += lineStep(font);
  }

  /** The seven weekday letters, lit for the days in `mask`; "Once" for none. */
  days(image: GrayImage, mask: number, value: number): void {
    const font = smallFont();
    if (mask === 0) {
      this.line(image, "Once", Math.round(value * 0.7));
      return;
    }
    const step = Math.min(26, Math.floor((this.rect.width - 12) / 7));
    const x = this.rect.x + 6;
    for (let index = 0; index < 7; index++) {
      const on = (mask & DAY_BITS[index]!) !== 0;
      const letter = DAY_LETTERS[index]!;
      const letterX = x + index * step + Math.floor((step - font.measureText(letter)) / 2);
      if (on) image.fillRoundedRect(x + index * step + 1, this.cursorY - 2, step - 4, font.lineHeight + 4, 40, 4);
      image.drawText(font, letterX, this.cursorY, letter, on ? value : Math.round(value * 0.35));
    }
    this.cursorY += lineStep(font) + 4;
  }

  /** Picker fields: boxed values with separators between and captions beneath. */
  fields(image: GrayImage, values: string[], separators: string[], activeField: number, captions: string[]): void {
    const font = digitFont(FIELD_DIGIT_SIZE);
    const sepFont = mediumFont();
    const small = smallFont();
    const padX = 8;
    const widths = values.map((value) => font.measureText(value) + 2 * padX);
    const sepWidths = separators.map((separator) => (separator ? sepFont.measureText(separator) + 8 : 6));
    const total = widths.reduce((sum, width) => sum + width, 0) + sepWidths.reduce((sum, width) => sum + width, 0);
    let x = this.rect.x + Math.max(0, Math.floor((this.rect.width - total) / 2));
    const boxHeight = font.lineHeight + 4;
    for (let index = 0; index < values.length; index++) {
      const width = widths[index]!;
      const active = index === activeField;
      if (active) {
        image.fillRoundedRect(x, this.cursorY - 2, width, boxHeight, 35, 6);
        image.drawRoundedRect(x, this.cursorY - 2, width, boxHeight, 130, 6);
      }
      image.drawText(font, x + padX, this.cursorY, values[index]!, active ? 250 : 170);
      const caption = captions[index] ?? "";
      if (caption) {
        image.drawText(small, x + Math.floor((width - small.measureText(caption)) / 2), this.cursorY + boxHeight + 2, caption, 110);
      }
      x += width;
      if (index < separators.length) {
        const separator = separators[index]!;
        if (separator.trim()) {
          image.drawText(sepFont, x + 4, this.cursorY + font.ascent - sepFont.ascent, separator, 130);
        }
        x += sepWidths[index]!;
      }
    }
    this.cursorY += boxHeight + 2 + small.lineHeight + 10;
  }

  /** A row of buttons; the highlighted one is filled, the rest outlined. */
  buttons(image: GrayImage, labels: string[], selected: number, focused: boolean): void {
    const font = smallFont();
    const gap = 12;
    const height = font.lineHeight + 14;
    const width = Math.floor((this.rect.width - 12 - gap * (labels.length - 1)) / labels.length);
    const y = Math.max(this.cursorY + 4, this.hintsTop - 10 - height);
    for (let index = 0; index < labels.length; index++) {
      const x = this.rect.x + 6 + index * (width + gap);
      const active = index === selected;
      if (active) {
        image.fillRoundedRect(x, y, width, height, focused ? 40 : 15, 8);
        image.drawRoundedRect(x, y, width, height, 150, 8);
      } else {
        image.drawRoundedRect(x, y, width, height, 70, 8);
      }
      const label = labels[index]!;
      image.drawText(font, x + Math.floor((width - font.measureText(label)) / 2), y + 7, label, active ? 250 : 170);
    }
    this.cursorY = y + height + 6;
  }

  hints(image: GrayImage, pairs: Array<[string, string]>): void {
    image.drawText(smallFont(), this.rect.x + 6, this.hintsTop, gestureHints(pairs), 110);
  }
}

function listWidthFor(viewportWidth: number): number {
  return clamp(Math.round(viewportWidth * LIST_SHARE), LIST_MIN_WIDTH, LIST_MAX_WIDTH);
}

function drawPauseMark(image: GrayImage, x: number, y: number, value: number): void {
  image.fillRect(x, y, 3, 10, value);
  image.fillRect(x + 5, y, 3, 10, value);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// Window

export function createTimerAppWindow(options: InProcessAppOptions): InProcessWindow {
  const layer = new TimersLayer();
  let tick: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  const stopTick = () => {
    if (tick !== null) {
      clearInterval(tick);
      tick = null;
    }
  };
  const visible = () => shell.isScreenOn() && shell.foregroundWindow()?.windowId === TIMER_WINDOW_ID;
  const app = createInProcessWindow({
    appId: "timer",
    windowId: TIMER_WINDOW_ID,
    title: "Timers",
    iconLetter: "T",
    icon: "timer",
    closeable: true,
    actions: options.actions,
    baseLayer: layer,
    menuItems: () => layer.menuItems(),
    receiveTextInput: (text) => {
      layer.receiveTextInput(text);
      app.requestRender();
    },
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    reconfigureSurface: options.reconfigureSurface,
    onClosed: () => {
      stopTick();
      unsubscribe?.();
      unsubscribe = null;
      options.onClosed();
    },
  });
  // Once a second while something on screen moves by itself and the window
  // is actually visible; the shell's wake path repaints on its own.
  tick = setInterval(() => {
    if (visible() && timerEngine.isDynamic()) app.requestRender();
  }, 1000);
  unsubscribe = timerEngine.onChange(() => {
    layer.onEngineChanged();
    if (visible()) app.requestRender();
  });
  return app;
}

// ---------------------------------------------------------------------------
// Tray icon

let trayText: string | null = null;
let trayTick: ReturnType<typeof setInterval> | null = null;

/**
 * Keep a small "soonest timer" readout in the top bar while a timer runs,
 * so any app can glance at it. Minute granularity until the last minute,
 * so the shell isn't repainted every second for an hour.
 */
export function startTimersTrayIcon(): void {
  const sync = () => {
    const remaining = soonestRunningTimerRemainingMs(timerEngine);
    let text: string | null = null;
    if (remaining !== null) {
      text = remaining >= MINUTE_MS ? `${Math.ceil(remaining / MINUTE_MS)}m` : `${Math.max(0, Math.ceil(remaining / 1000))}s`;
    }
    if (text === trayText) return;
    trayText = text;
    shell.setTrayIcon("timer", text === null ? null : renderTrayIcon(text));
    if (text !== null && trayTick === null) {
      trayTick = setInterval(sync, 1000);
    } else if (text === null && trayTick !== null) {
      clearInterval(trayTick);
      trayTick = null;
    }
  };
  timerEngine.onChange(sync);
  sync();
}

function renderTrayIcon(text: string): GrayImage {
  const font = getFont("terminus12");
  const dial = 12;
  const gap = 4;
  const width = dial + gap + font.measureText(text);
  const icon = new GrayImage(width, 16, 0);
  // A little dial: a ring with a hand pointing up-right.
  icon.drawRoundedRect(0, 2, dial, dial, 200, 6);
  icon.drawLine(6, 8, 6, 5, 200);
  icon.drawLine(6, 8, 8, 8, 200);
  icon.drawText(font, dial + gap, 2, text, 220);
  return icon;
}
