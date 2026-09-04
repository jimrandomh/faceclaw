/**
 * Pure data model for the Timers app: countdown timers, the stopwatch, and
 * alarms, plus the formatting and scheduling arithmetic they need. No
 * NativeScript imports, so tests/timer-model.test.cjs can run it under plain
 * node. Side effects (persistence, Android alarms, the buzzer, waking the
 * glasses) live in timer-engine.ts; drawing lives in timer-app.ts.
 */

// ---------------------------------------------------------------------------
// Types

/**
 * A countdown timer. Exactly one of the three phases holds at a time:
 * running (endsAtMs set), paused (pausedRemainingMs set), or rung
 * (rungAtMs set). A rung timer stays until dismissed so a missed one still
 * reads "Time's up".
 */
export type CountdownTimer = {
  /** Unique across restarts and safe as a Java long (see newItemId). */
  id: number;
  /** Wearer-given name; "" for an unlabelled timer (shown by duration). */
  label: string;
  durationMs: number;
  endsAtMs: number | null;
  pausedRemainingMs: number | null;
  rungAtMs: number | null;
  createdAtMs: number;
};

export type StopwatchState = {
  /** Time accumulated over previous running stretches. */
  accumulatedMs: number;
  /** Start of the current running stretch, or null while stopped. */
  runningSinceMs: number | null;
  /** Cumulative elapsed time at each lap mark, oldest first. */
  lapsMs: number[];
};

/** Day-of-week bits for Alarm.days, Monday first (Mon = bit 0 ... Sun = bit 6). */
export const DAY_BITS = [1, 2, 4, 8, 16, 32, 64] as const;
export const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"] as const;
export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const DAY_FULL_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export const WEEKDAYS_MASK = 1 | 2 | 4 | 8 | 16;
export const WEEKEND_MASK = 32 | 64;
export const EVERY_DAY_MASK = 127;

export type Alarm = {
  id: number;
  hour: number;
  minute: number;
  /** Repeat days as DAY_BITS; 0 means a one-off alarm (disabled after it rings). */
  days: number;
  label: string;
  enabled: boolean;
  /** Set while a snooze is pending; the alarm rings again at this time. */
  snoozedUntilMs: number | null;
  /** Set while ringing; cleared by dismiss or snooze. */
  ringingSinceMs: number | null;
  /**
   * For a repeating alarm: the occurrence most recently rung (or dismissed
   * from ringing), so the same occurrence does not ring twice after a
   * dismiss that lands before the minute is over.
   */
  lastFiredAtMs: number | null;
};

export type TimersState = {
  timers: CountdownTimer[];
  stopwatch: StopwatchState;
  alarms: Alarm[];
  /** Durations the wearer started most recently, newest first. */
  recentDurationsMs: number[];
};

export function emptyTimersState(): TimersState {
  return {
    timers: [],
    stopwatch: { accumulatedMs: 0, runningSinceMs: null, lapsMs: [] },
    alarms: [],
    recentDurationsMs: [],
  };
}

/** How many recent durations to keep for the "New timer" menu. */
export const RECENT_DURATION_COUNT = 3;

// ---------------------------------------------------------------------------
// Ids

let idSerial = 1;

/**
 * Millisecond epoch plus a small serial: unique across restarts, ordered by
 * creation, and still exactly representable through the JS -> Java long
 * bridge.
 */
export function newItemId(nowMs: number): number {
  return nowMs * 100 + (idSerial++ % 100);
}

// ---------------------------------------------------------------------------
// Duration ladder (the "New timer" dial)

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * The durations the dial scrolls through: fine steps where timers are
 * usually short, coarser steps as they get long, so anything from ten
 * seconds to a day is a few dozen scroll clicks away at most.
 */
export const DURATION_LADDER_MS: readonly number[] = (() => {
  const ladder: number[] = [10 * SECOND, 15 * SECOND, 20 * SECOND, 30 * SECOND, 45 * SECOND, MINUTE, 90 * SECOND];
  for (let minutes = 2; minutes <= 20; minutes++) ladder.push(minutes * MINUTE);
  for (let minutes = 25; minutes <= 60; minutes += 5) ladder.push(minutes * MINUTE);
  for (let minutes = 75; minutes <= 180; minutes += 15) ladder.push(minutes * MINUTE);
  for (let minutes = 210; minutes <= 360; minutes += 30) ladder.push(minutes * MINUTE);
  for (let hours = 7; hours <= 12; hours++) ladder.push(hours * HOUR);
  ladder.push(18 * HOUR, 24 * HOUR);
  return ladder;
})();

/** Index of the ladder rung closest to a duration (ties go to the shorter). */
export function nearestLadderIndex(durationMs: number): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < DURATION_LADDER_MS.length; index++) {
    const distance = Math.abs(DURATION_LADDER_MS[index]! - durationMs);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

export const DEFAULT_TIMER_DURATION_MS = 10 * MINUTE;
export const MAX_TIMER_DURATION_MS = 24 * HOUR;

// ---------------------------------------------------------------------------
// Timers

export function timerRemainingMs(timer: CountdownTimer, nowMs: number): number {
  if (timer.pausedRemainingMs !== null) return timer.pausedRemainingMs;
  if (timer.endsAtMs !== null) return Math.max(0, timer.endsAtMs - nowMs);
  return 0;
}

export type TimerPhase = "running" | "paused" | "rung";

export function timerPhase(timer: CountdownTimer): TimerPhase {
  if (timer.rungAtMs !== null) return "rung";
  if (timer.pausedRemainingMs !== null) return "paused";
  return "running";
}

/** 0..1 progress toward the end (1 once rung). */
export function timerProgress(timer: CountdownTimer, nowMs: number): number {
  if (timer.rungAtMs !== null || timer.durationMs <= 0) return 1;
  return Math.min(1, Math.max(0, 1 - timerRemainingMs(timer, nowMs) / timer.durationMs));
}

export function createTimer(durationMs: number, label: string, nowMs: number): CountdownTimer {
  return {
    id: newItemId(nowMs),
    label,
    durationMs,
    endsAtMs: nowMs + durationMs,
    pausedRemainingMs: null,
    rungAtMs: null,
    createdAtMs: nowMs,
  };
}

/** Running timers soonest first, then paused, then rung (oldest ring first). */
export function sortTimers(timers: readonly CountdownTimer[], nowMs: number): CountdownTimer[] {
  const rank = (timer: CountdownTimer) => (timer.rungAtMs !== null ? 0 : timer.pausedRemainingMs !== null ? 2 : 1);
  return [...timers].sort((a, b) => {
    const rankDelta = rank(a) - rank(b);
    if (rankDelta !== 0) return rankDelta;
    if (a.rungAtMs !== null && b.rungAtMs !== null) return a.rungAtMs - b.rungAtMs;
    return timerRemainingMs(a, nowMs) - timerRemainingMs(b, nowMs) || a.createdAtMs - b.createdAtMs;
  });
}

export function pushRecentDuration(recent: readonly number[], durationMs: number): number[] {
  return [durationMs, ...recent.filter((value) => value !== durationMs)].slice(0, RECENT_DURATION_COUNT);
}

// ---------------------------------------------------------------------------
// Stopwatch

export function stopwatchElapsedMs(stopwatch: StopwatchState, nowMs: number): number {
  const running = stopwatch.runningSinceMs === null ? 0 : Math.max(0, nowMs - stopwatch.runningSinceMs);
  return stopwatch.accumulatedMs + running;
}

export function stopwatchIsRunning(stopwatch: StopwatchState): boolean {
  return stopwatch.runningSinceMs !== null;
}

// ---------------------------------------------------------------------------
// Alarms

export function createAlarm(hour: number, minute: number, days: number, label: string, nowMs: number): Alarm {
  return {
    id: newItemId(nowMs),
    hour,
    minute,
    days,
    label,
    enabled: true,
    snoozedUntilMs: null,
    ringingSinceMs: null,
    lastFiredAtMs: null,
  };
}

/** Monday-first weekday index (0..6) of a Date, from JS's Sunday-first getDay. */
export function mondayFirstDay(date: Date): number {
  return (date.getDay() + 6) % 7;
}

/**
 * When the alarm next goes off, given the current time: the pending snooze
 * if there is one, otherwise the next wall-clock occurrence of hour:minute
 * on an enabled day (any day for a one-off), strictly after `nowMs` and
 * after the occurrence it last rang for. Null when the alarm is disabled.
 * Wall-clock arithmetic runs in the local zone via Date, so DST changes
 * land on the right local time.
 */
export function alarmNextRingMs(alarm: Alarm, nowMs: number): number | null {
  if (!alarm.enabled) return null;
  if (alarm.snoozedUntilMs !== null) return alarm.snoozedUntilMs;
  const floor = Math.max(nowMs, alarm.lastFiredAtMs ?? 0);
  const start = new Date(nowMs);
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const candidate = new Date(start.getFullYear(), start.getMonth(), start.getDate() + dayOffset, alarm.hour, alarm.minute, 0, 0);
    if (candidate.getTime() <= floor) continue;
    if (alarm.days !== 0 && !(alarm.days & DAY_BITS[mondayFirstDay(candidate)]!)) continue;
    return candidate.getTime();
  }
  return null;
}

/** Alarms by time of day, then by creation. */
export function sortAlarms(alarms: readonly Alarm[]): Alarm[] {
  return [...alarms].sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute) || a.id - b.id);
}

export function formatDays(days: number): string {
  if (days === 0) return "Once";
  if (days === EVERY_DAY_MASK) return "Every day";
  if (days === WEEKDAYS_MASK) return "Weekdays";
  if (days === WEEKEND_MASK) return "Weekends";
  return DAY_NAMES.filter((_, index) => days & DAY_BITS[index]!).join(" ");
}

// ---------------------------------------------------------------------------
// Formatting

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Countdown / elapsed digits: m:ss below an hour, h:mm:ss above. */
export function formatClockDigits(totalSeconds: number): string {
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${minutes}:${pad2(seconds)}`;
}

/** Remaining time as a countdown reads it: rounds up, so 0:00 means done. */
export function formatCountdown(remainingMs: number): string {
  return formatClockDigits(Math.max(0, Math.ceil(remainingMs / 1000)));
}

/** Elapsed time as a stopwatch reads it: rounds down, plus optional tenths. */
export function formatElapsed(elapsedMs: number, tenths: boolean): string {
  const clamped = Math.max(0, elapsedMs);
  const digits = formatClockDigits(Math.floor(clamped / 1000));
  return tenths ? `${digits}.${Math.floor(clamped / 100) % 10}` : digits;
}

/** A set duration in words: "20 min", "1h 30m", "45s", "2m 30s". */
export function formatDurationWords(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes} min`;
  return `${seconds}s`;
}

/** A span until something: "9h 12m", "12m", "45s". Coarse on purpose. */
export function formatSpanWords(spanMs: number): string {
  const totalSeconds = Math.max(0, Math.round(spanMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (hours < 24) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days}d ${restHours}h` : `${days}d`;
}

/** Wall-clock time of day in the wearer's chosen format. */
export function formatTimeOfDay(hour24: number, minute: number, twelveHour: boolean): string {
  const minutes = pad2(minute);
  if (!twelveHour) return `${hour24}:${minutes}`;
  const hour12 = ((hour24 + 11) % 12) + 1;
  return `${hour12}:${minutes} ${hour24 < 12 ? "AM" : "PM"}`;
}

export function formatClockAt(timestampMs: number, twelveHour: boolean): string {
  const date = new Date(timestampMs);
  return formatTimeOfDay(date.getHours(), date.getMinutes(), twelveHour);
}

/** Row/stage label for a timer: its label, else its set duration. */
export function timerDisplayName(timer: CountdownTimer): string {
  return timer.label || formatDurationWords(timer.durationMs);
}

// ---------------------------------------------------------------------------
// Persistence shape

/**
 * Parse a persisted state blob defensively: anything malformed falls back to
 * a field default rather than failing the whole load, so a bad record loses
 * itself and nothing else.
 */
export function parseTimersState(raw: string | null | undefined): TimersState {
  const state = emptyTimersState();
  if (!raw) return state;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return state;
  }
  if (!parsed || typeof parsed !== "object") return state;
  if (Array.isArray(parsed.timers)) {
    for (const item of parsed.timers) {
      if (!item || typeof item !== "object" || !isFiniteNumber(item.id) || !isFiniteNumber(item.durationMs)) continue;
      state.timers.push({
        id: item.id,
        label: typeof item.label === "string" ? item.label : "",
        durationMs: item.durationMs,
        endsAtMs: isFiniteNumber(item.endsAtMs) ? item.endsAtMs : null,
        pausedRemainingMs: isFiniteNumber(item.pausedRemainingMs) ? item.pausedRemainingMs : null,
        rungAtMs: isFiniteNumber(item.rungAtMs) ? item.rungAtMs : null,
        createdAtMs: isFiniteNumber(item.createdAtMs) ? item.createdAtMs : 0,
      });
    }
  }
  const stopwatch = parsed.stopwatch;
  if (stopwatch && typeof stopwatch === "object") {
    state.stopwatch = {
      accumulatedMs: isFiniteNumber(stopwatch.accumulatedMs) ? Math.max(0, stopwatch.accumulatedMs) : 0,
      runningSinceMs: isFiniteNumber(stopwatch.runningSinceMs) ? stopwatch.runningSinceMs : null,
      lapsMs: Array.isArray(stopwatch.lapsMs) ? stopwatch.lapsMs.filter(isFiniteNumber) : [],
    };
  }
  if (Array.isArray(parsed.alarms)) {
    for (const item of parsed.alarms) {
      if (!item || typeof item !== "object" || !isFiniteNumber(item.id)) continue;
      if (!isFiniteNumber(item.hour) || !isFiniteNumber(item.minute)) continue;
      state.alarms.push({
        id: item.id,
        hour: Math.min(23, Math.max(0, Math.floor(item.hour))),
        minute: Math.min(59, Math.max(0, Math.floor(item.minute))),
        days: isFiniteNumber(item.days) ? item.days & EVERY_DAY_MASK : 0,
        label: typeof item.label === "string" ? item.label : "",
        enabled: item.enabled !== false,
        snoozedUntilMs: isFiniteNumber(item.snoozedUntilMs) ? item.snoozedUntilMs : null,
        ringingSinceMs: isFiniteNumber(item.ringingSinceMs) ? item.ringingSinceMs : null,
        lastFiredAtMs: isFiniteNumber(item.lastFiredAtMs) ? item.lastFiredAtMs : null,
      });
    }
  }
  if (Array.isArray(parsed.recentDurationsMs)) {
    state.recentDurationsMs = parsed.recentDurationsMs.filter(isFiniteNumber).slice(0, RECENT_DURATION_COUNT);
  }
  return state;
}

export function serializeTimersState(state: TimersState): string {
  return JSON.stringify(state);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// ---------------------------------------------------------------------------
// Tool-argument parsing (shared by the assistant tools)

/**
 * Parse a time of day from the forms an assistant is likely to pass:
 * "7:30", "07:30", "7:30 am", "7pm", "19:30", "noon", "midnight".
 * Returns null when unparseable.
 */
export function parseTimeOfDay(text: string): { hour: number; minute: number } | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "noon") return { hour: 12, minute: 0 };
  if (trimmed === "midnight") return { hour: 0, minute: 0 };
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/.exec(trimmed);
  if (!match) return null;
  let hour = parseInt(match[1]!, 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3]?.replace(/\./g, "");
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12;
    if (meridiem === "pm") hour += 12;
  } else if (hour > 23) {
    return null;
  }
  return { hour, minute };
}

/** Parse repeat days from names ("mon", "tuesday"), "weekdays", "weekends", "daily"/"every day", "once". */
export function parseRepeatDays(values: readonly string[] | string | null | undefined): number | null {
  if (values === null || values === undefined) return 0;
  const list =
    typeof values === "string"
      ? values.toLowerCase().replace(/every\s*day/g, "daily").split(/[,\s]+/)
      : values.map((value) => String(value).toLowerCase().replace(/every\s*day/g, "daily"));
  let mask = 0;
  for (const raw of list) {
    const value = String(raw).trim().toLowerCase();
    if (!value || value === "once" || value === "none") continue;
    if (value === "weekdays") {
      mask |= WEEKDAYS_MASK;
      continue;
    }
    if (value === "weekends" || value === "weekend") {
      mask |= WEEKEND_MASK;
      continue;
    }
    if (value === "daily" || value === "every day" || value === "everyday" || value === "all") {
      mask |= EVERY_DAY_MASK;
      continue;
    }
    const index = DAY_FULL_NAMES.findIndex((name) => name.toLowerCase().startsWith(value.slice(0, 3)));
    if (index < 0 || value.length < 2) return null;
    mask |= DAY_BITS[index]!;
  }
  return mask;
}
