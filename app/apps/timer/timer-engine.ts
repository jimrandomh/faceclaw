/**
 * The Timers app's clock engine: a main-thread singleton that owns the
 * timers / stopwatch / alarms state, persists it, schedules the durable
 * Android alarms behind every expiry, rings the glasses buzzer, and tells
 * listeners (the window, the tray icon, the assistant tools) when anything
 * changes. It is booted at shell start, so everything here works with the
 * window closed; the window is only a view on it.
 *
 * Two expiry paths run side by side, as before: a JS deadline for prompt
 * on-glasses ringing while the process is awake, and an AlarmManager alarm
 * (see FaceclawTimerNotifications.java) that posts the phone notification
 * at the right moment even if the process is asleep or dead. The Java side
 * deduplicates the two.
 */
import { ConfigSettingBoolean, ConfigSettingEnum } from "../../ui/dashboard-settings";
import { getStringSetting, setStringSetting } from "../../native/settings-store";
import {
  cancelTimerNotification,
  fireTimerNotification,
  scheduleTimerNotification,
} from "../../native/timer-notifications";
import { buildSoundSequencePayload, findSoundEffect, effectPhrases } from "../../ui/sound-effects";
import { timeFormatSetting } from "../../ui/dashboard-settings";
import {
  alarmNextRingMs,
  createAlarm,
  createTimer,
  emptyTimersState,
  formatDurationWords,
  formatTimeOfDay,
  parseTimersState,
  pushRecentDuration,
  serializeTimersState,
  stopwatchElapsedMs,
  timerRemainingMs,
  type Alarm,
  type CountdownTimer,
  type TimersState,
} from "./timer-model";

const STATE_KEY = "timers.state";

/**
 * An expiry that passed longer ago than this while the process was down
 * (phone off, app killed) is marked rung silently rather than blaring on
 * the glasses hours late; the phone notification already fired on time.
 */
const RING_GRACE_MS = 5 * 60_000;
/** How often the buzzer repeats while something is ringing. */
const RING_REPEAT_MS = 3_000;
/** Stop buzzing an item this long after it started ringing (it stays "rung"). */
const RING_MAX_MS = 2 * 60_000;
/**
 * Upper bound between deadline checks even with nothing due, so a JS timer
 * delayed by Doze or a clock jump can't leave a due item unnoticed for long.
 */
const MAX_ARM_MS = 30_000;

export const timersSoundSetting = new ConfigSettingBoolean({
  id: "timersSound",
  label: "Sound on glasses",
  storageKey: "timers.soundOnGlasses",
  defaultValue: true,
  description: "Play the glasses buzzer while a timer or alarm is ringing.",
});

export const timersWakeSetting = new ConfigSettingBoolean({
  id: "timersWake",
  label: "Wake glasses when ringing",
  storageKey: "timers.wakeGlasses",
  defaultValue: true,
  description: "Turn the display on and show the Timers app when a timer or alarm goes off.",
});

export type SnoozeMinutes = "5" | "10" | "15";
export const timersSnoozeSetting = new ConfigSettingEnum<SnoozeMinutes>({
  id: "timersSnooze",
  label: "Snooze length",
  storageKey: "timers.snoozeMinutes",
  defaultValue: "10",
  values: ["5", "10", "15"],
  formatValue: (value) => `${value} min`,
});

export type RingingItem = { kind: "timer"; timer: CountdownTimer } | { kind: "alarm"; alarm: Alarm };

export type TimerEngineHooks = {
  /** Play one buzzer sequencer payload on the glasses (no-op when disconnected). */
  playBuzzer: (payload: Uint8Array) => Promise<void> | void;
  /** Something started ringing audibly: bring the app forward, wake the glasses. */
  onRing: (item: RingingItem) => void;
};

const noopHooks: TimerEngineHooks = { playBuzzer: () => {}, onRing: () => {} };

export class TimerEngine {
  state: TimersState;
  private hooks: TimerEngineHooks = noopHooks;
  private readonly listeners = new Set<() => void>();
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private ringTimer: ReturnType<typeof setInterval> | null = null;
  private booted = false;

  constructor(private readonly now: () => number = () => Date.now()) {
    this.state = emptyTimersState();
  }

  /**
   * Install the side-effect hooks and reconcile persisted state against the
   * clock: anything that came due while the process was down rings (or is
   * marked rung silently past the grace window), and the Android alarms are
   * re-armed for what is still pending.
   */
  boot(hooks: TimerEngineHooks): void {
    this.hooks = hooks;
    if (this.booted) return;
    this.booted = true;
    // Loaded here rather than at module evaluation, so the settings store is
    // certainly up before the first read.
    this.state = parseTimersState(getStringSetting(STATE_KEY, ""));
    this.check();
    for (const timer of this.state.timers) {
      if (timer.endsAtMs !== null && timer.rungAtMs === null) this.schedulePhoneNotification(timer);
    }
    for (const alarm of this.state.alarms) this.schedulePhoneAlarm(alarm);
    this.save();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** True while anything on screen changes by itself once a second. */
  isDynamic(): boolean {
    return (
      this.state.stopwatch.runningSinceMs !== null ||
      this.state.timers.some((timer) => timer.endsAtMs !== null && timer.rungAtMs === null) ||
      this.ringingItems().length > 0
    );
  }

  ringingItems(): RingingItem[] {
    const items: RingingItem[] = [];
    for (const timer of this.state.timers) {
      if (timer.rungAtMs !== null) items.push({ kind: "timer", timer });
    }
    for (const alarm of this.state.alarms) {
      if (alarm.ringingSinceMs !== null) items.push({ kind: "alarm", alarm });
    }
    return items;
  }

  // -------------------------------------------------------------------------
  // Timers

  findTimer(id: number): CountdownTimer | undefined {
    return this.state.timers.find((timer) => timer.id === id);
  }

  startTimer(durationMs: number, label = ""): CountdownTimer {
    const timer = createTimer(durationMs, label, this.now());
    this.state.timers.push(timer);
    this.state.recentDurationsMs = pushRecentDuration(this.state.recentDurationsMs, durationMs);
    this.schedulePhoneNotification(timer);
    this.commit();
    return timer;
  }

  pauseTimer(id: number): void {
    const timer = this.findTimer(id);
    if (!timer || timer.endsAtMs === null || timer.rungAtMs !== null) return;
    timer.pausedRemainingMs = Math.max(0, timer.endsAtMs - this.now());
    timer.endsAtMs = null;
    cancelTimerNotification(timer.id);
    this.commit();
  }

  resumeTimer(id: number): void {
    const timer = this.findTimer(id);
    if (!timer || timer.pausedRemainingMs === null) return;
    timer.endsAtMs = this.now() + timer.pausedRemainingMs;
    timer.pausedRemainingMs = null;
    this.schedulePhoneNotification(timer);
    this.commit();
  }

  /** Add time to a timer; a rung timer becomes a running one with just the added time. */
  addTimerTime(id: number, deltaMs: number): void {
    const timer = this.findTimer(id);
    if (!timer) return;
    if (timer.rungAtMs !== null) {
      timer.rungAtMs = null;
      timer.durationMs = deltaMs;
      timer.endsAtMs = this.now() + deltaMs;
      cancelTimerNotification(timer.id);
      this.schedulePhoneNotification(timer);
    } else if (timer.pausedRemainingMs !== null) {
      timer.pausedRemainingMs += deltaMs;
      timer.durationMs += deltaMs;
    } else if (timer.endsAtMs !== null) {
      timer.endsAtMs += deltaMs;
      timer.durationMs += deltaMs;
      this.schedulePhoneNotification(timer);
    }
    this.commit();
  }

  /** Start the timer over at its set duration ("Again" on a rung timer). */
  restartTimer(id: number): void {
    const timer = this.findTimer(id);
    if (!timer) return;
    timer.rungAtMs = null;
    timer.pausedRemainingMs = null;
    timer.endsAtMs = this.now() + timer.durationMs;
    cancelTimerNotification(timer.id);
    this.schedulePhoneNotification(timer);
    this.commit();
  }

  setTimerLabel(id: number, label: string): void {
    const timer = this.findTimer(id);
    if (!timer) return;
    timer.label = label.trim();
    if (timer.endsAtMs !== null && timer.rungAtMs === null) this.schedulePhoneNotification(timer);
    this.commit();
  }

  /** Cancel a timer, or dismiss a rung one. */
  removeTimer(id: number): void {
    const index = this.state.timers.findIndex((timer) => timer.id === id);
    if (index < 0) return;
    cancelTimerNotification(id);
    this.state.timers.splice(index, 1);
    this.commit();
  }

  // -------------------------------------------------------------------------
  // Stopwatch

  stopwatchToggle(): void {
    const stopwatch = this.state.stopwatch;
    const now = this.now();
    if (stopwatch.runningSinceMs === null) {
      stopwatch.runningSinceMs = now;
    } else {
      stopwatch.accumulatedMs += Math.max(0, now - stopwatch.runningSinceMs);
      stopwatch.runningSinceMs = null;
    }
    this.commit();
  }

  stopwatchStart(): void {
    if (this.state.stopwatch.runningSinceMs === null) this.stopwatchToggle();
  }

  stopwatchStop(): void {
    if (this.state.stopwatch.runningSinceMs !== null) this.stopwatchToggle();
  }

  stopwatchLap(): void {
    const stopwatch = this.state.stopwatch;
    if (stopwatch.runningSinceMs === null) return;
    stopwatch.lapsMs.push(stopwatchElapsedMs(stopwatch, this.now()));
    this.commit();
  }

  stopwatchReset(): void {
    this.state.stopwatch = { accumulatedMs: 0, runningSinceMs: null, lapsMs: [] };
    this.commit();
  }

  // -------------------------------------------------------------------------
  // Alarms

  findAlarm(id: number): Alarm | undefined {
    return this.state.alarms.find((alarm) => alarm.id === id);
  }

  addAlarm(hour: number, minute: number, days: number, label = ""): Alarm {
    const alarm = createAlarm(hour, minute, days, label, this.now());
    this.state.alarms.push(alarm);
    this.schedulePhoneAlarm(alarm);
    this.commit();
    return alarm;
  }

  setAlarmTime(id: number, hour: number, minute: number): void {
    const alarm = this.findAlarm(id);
    if (!alarm) return;
    alarm.hour = hour;
    alarm.minute = minute;
    alarm.enabled = true;
    alarm.snoozedUntilMs = null;
    alarm.ringingSinceMs = null;
    alarm.lastFiredAtMs = null;
    this.schedulePhoneAlarm(alarm);
    this.commit();
  }

  setAlarmDays(id: number, days: number): void {
    const alarm = this.findAlarm(id);
    if (!alarm) return;
    alarm.days = days;
    this.schedulePhoneAlarm(alarm);
    this.commit();
  }

  setAlarmEnabled(id: number, enabled: boolean): void {
    const alarm = this.findAlarm(id);
    if (!alarm) return;
    alarm.enabled = enabled;
    alarm.snoozedUntilMs = null;
    alarm.ringingSinceMs = null;
    if (enabled) alarm.lastFiredAtMs = null;
    this.schedulePhoneAlarm(alarm);
    this.commit();
  }

  setAlarmLabel(id: number, label: string): void {
    const alarm = this.findAlarm(id);
    if (!alarm) return;
    alarm.label = label.trim();
    this.schedulePhoneAlarm(alarm);
    this.commit();
  }

  deleteAlarm(id: number): void {
    const index = this.state.alarms.findIndex((alarm) => alarm.id === id);
    if (index < 0) return;
    cancelTimerNotification(id);
    this.state.alarms.splice(index, 1);
    this.commit();
  }

  snoozeAlarm(id: number, minutes = Number(timersSnoozeSetting.get())): void {
    const alarm = this.findAlarm(id);
    if (!alarm || alarm.ringingSinceMs === null) return;
    alarm.ringingSinceMs = null;
    alarm.snoozedUntilMs = this.now() + minutes * 60_000;
    this.schedulePhoneAlarm(alarm);
    this.commit();
  }

  /** Stop a ringing alarm; a one-off alarm switches itself off. */
  dismissAlarm(id: number): void {
    const alarm = this.findAlarm(id);
    if (!alarm || alarm.ringingSinceMs === null) return;
    alarm.ringingSinceMs = null;
    alarm.snoozedUntilMs = null;
    if (alarm.days === 0) alarm.enabled = false;
    this.schedulePhoneAlarm(alarm);
    this.commit();
  }

  /** Dismiss whatever is ringing (timers and alarms alike). Returns how many. */
  dismissAllRinging(): number {
    const items = this.ringingItems();
    for (const item of items) {
      if (item.kind === "timer") this.removeTimer(item.timer.id);
      else this.dismissAlarm(item.alarm.id);
    }
    return items.length;
  }

  // -------------------------------------------------------------------------
  // Deadlines and ringing

  /**
   * Fire anything due and re-arm for the next deadline. Called on every
   * change, on the deadline timer, and by the window before it paints, so a
   * timer never shows 0:00 without also being rung.
   */
  check(): void {
    const now = this.now();
    let changed = false;
    for (const timer of this.state.timers) {
      if (timer.endsAtMs === null || timer.rungAtMs !== null || timer.endsAtMs > now) continue;
      timer.rungAtMs = timer.endsAtMs;
      timer.endsAtMs = null;
      changed = true;
      const late = now - timer.rungAtMs > RING_GRACE_MS;
      fireTimerNotification(timer.id, "Timer finished", timerNotificationText(timer));
      if (!late) this.startRinging({ kind: "timer", timer });
    }
    for (const alarm of this.state.alarms) {
      if (alarm.ringingSinceMs !== null) continue;
      const due = this.alarmDueMs(alarm, now);
      if (due === null || due > now) continue;
      alarm.ringingSinceMs = now;
      alarm.snoozedUntilMs = null;
      alarm.lastFiredAtMs = due;
      changed = true;
      const late = now - due > RING_GRACE_MS;
      fireTimerNotification(alarm.id, "Alarm", alarmNotificationText(alarm));
      if (late) {
        // Missed by too much to ring now: fall through to the next occurrence.
        alarm.ringingSinceMs = null;
        if (alarm.days === 0) alarm.enabled = false;
        this.schedulePhoneAlarm(alarm);
      } else {
        this.startRinging({ kind: "alarm", alarm });
      }
    }
    this.arm(now);
    this.syncRingLoop(now);
    if (changed) this.commit();
  }

  /**
   * The occurrence an alarm should ring for next: the pending snooze, or the
   * first occurrence after (now - grace) that it has not already rung for.
   * Inside the grace window this returns a time in the past, which check()
   * fires; beyond it the missed occurrence is skipped.
   */
  private alarmDueMs(alarm: Alarm, now: number): number | null {
    return alarmNextRingMs(alarm, now - RING_GRACE_MS);
  }

  private startRinging(item: RingingItem): void {
    try {
      this.hooks.onRing(item);
    } catch (error) {
      console.warn(`timers onRing hook failed: ${error}`);
    }
  }

  /** Re-arm the single deadline timer for the soonest pending expiry. */
  private arm(now: number): void {
    if (this.deadlineTimer !== null) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
    const deadlines: number[] = [];
    for (const timer of this.state.timers) {
      if (timer.rungAtMs === null && timer.endsAtMs !== null) deadlines.push(timer.endsAtMs);
    }
    for (const alarm of this.state.alarms) {
      if (alarm.ringingSinceMs !== null) continue;
      const due = this.alarmDueMs(alarm, now);
      if (due !== null) deadlines.push(due);
    }
    if (deadlines.length === 0) return;
    const delay = Math.min(MAX_ARM_MS, Math.max(0, Math.min(...deadlines) - now));
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = null;
      this.check();
    }, delay);
  }

  /** Run the buzzer repeat loop while anything is (still audibly) ringing. */
  private syncRingLoop(now: number): void {
    const audible = this.ringingItems().some((item) => this.ringAgeMs(item, now) < RING_MAX_MS);
    if (audible && this.ringTimer === null) {
      this.playRingSound();
      this.ringTimer = setInterval(() => {
        const at = this.now();
        if (!this.ringingItems().some((item) => this.ringAgeMs(item, at) < RING_MAX_MS)) {
          this.syncRingLoop(at);
          return;
        }
        this.playRingSound();
      }, RING_REPEAT_MS);
    } else if (!audible && this.ringTimer !== null) {
      clearInterval(this.ringTimer);
      this.ringTimer = null;
    }
  }

  private ringAgeMs(item: RingingItem, now: number): number {
    const since = item.kind === "timer" ? item.timer.rungAtMs : item.alarm.ringingSinceMs;
    return since === null ? Infinity : Math.max(0, now - since);
  }

  private playRingSound(): void {
    if (!timersSoundSetting.get()) return;
    const effect = findSoundEffect("alarm");
    if (!effect) return;
    const phrase = effectPhrases(effect.make())[0];
    if (!phrase) return;
    try {
      void this.hooks.playBuzzer(buildSoundSequencePayload(phrase));
    } catch (error) {
      console.warn(`timers buzzer failed: ${error}`);
    }
  }

  // -------------------------------------------------------------------------
  // Phone notifications

  private schedulePhoneNotification(timer: CountdownTimer): void {
    if (timer.endsAtMs === null) return;
    scheduleTimerNotification(timer.id, timer.endsAtMs, "Timer finished", timerNotificationText(timer));
  }

  /** (Re)arm or cancel the phone alarm for an alarm's next occurrence. */
  private schedulePhoneAlarm(alarm: Alarm): void {
    const due = alarm.ringingSinceMs === null ? this.alarmDueMs(alarm, this.now()) : null;
    if (due === null) {
      cancelTimerNotification(alarm.id);
      return;
    }
    scheduleTimerNotification(alarm.id, due, "Alarm", alarmNotificationText(alarm));
  }

  // -------------------------------------------------------------------------
  // Change plumbing

  private commit(): void {
    this.save();
    this.check();
    this.notify();
  }

  private save(): void {
    try {
      setStringSetting(STATE_KEY, serializeTimersState(this.state));
    } catch (error) {
      console.warn(`timers state save failed: ${error}`);
    }
  }

  private notify(): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener();
      } catch (error) {
        console.warn(`timers listener failed: ${error}`);
      }
    }
  }
}

function timerNotificationText(timer: CountdownTimer): string {
  const duration = formatDurationWords(timer.durationMs);
  return timer.label ? `${timer.label} (${duration}) is up` : `${duration} timer is up`;
}

function alarmNotificationText(alarm: Alarm): string {
  const time = formatTimeOfDay(alarm.hour, alarm.minute, timeFormatSetting.get() === "12h");
  return alarm.label ? `${time} · ${alarm.label}` : time;
}

/** Remaining time of the timer that ends soonest, for the tray icon; null when none runs. */
export function soonestRunningTimerRemainingMs(engine: TimerEngine, now = Date.now()): number | null {
  let soonest: number | null = null;
  for (const timer of engine.state.timers) {
    if (timer.endsAtMs === null || timer.rungAtMs !== null) continue;
    const remaining = timerRemainingMs(timer, now);
    if (soonest === null || remaining < soonest) soonest = remaining;
  }
  return soonest;
}

export const timerEngine = new TimerEngine();
