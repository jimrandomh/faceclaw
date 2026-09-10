/**
 * The assistant's timer.* / stopwatch.* / alarm.* tools. They talk to the
 * Timers app's engine directly (it boots with the shell), so every one works
 * with no Timers window open; timer.set and alarm.set also bring the window
 * forward so the wearer sees what was set.
 */
import {
  alarmNextRingMs,
  formatClockAt,
  formatCountdown,
  formatDays,
  formatDurationWords,
  formatElapsed,
  formatSpanWords,
  formatTimeOfDay,
  MAX_TIMER_DURATION_MS,
  parseRepeatDays,
  parseTimeOfDay,
  sortAlarms,
  sortTimers,
  stopwatchElapsedMs,
  stopwatchIsRunning,
  timerDisplayName,
  timerPhase,
  timerRemainingMs,
  type Alarm,
  type CountdownTimer,
} from "../apps/timer/timer-model";
import { timerEngine } from "../apps/timer/timer-engine";
import { timeFormatSetting } from "../ui/dashboard-settings";
import { toolRegistry, type ToolRegistry, type ToolResult } from "./tool-registry";

let registered = false;

function twelveHour(): boolean {
  return timeFormatSetting.get() === "12h";
}

/** Timers in the order the app lists them, so "timer 2" means the same thing in both places. */
function listedTimers(): CountdownTimer[] {
  return sortTimers(timerEngine.state.timers, Date.now());
}

function listedAlarms(): Alarm[] {
  return sortAlarms(timerEngine.state.alarms);
}

function describeTimer(timer: CountdownTimer, number: number, now: number): string {
  const name = timerDisplayName(timer);
  switch (timerPhase(timer)) {
    case "rung":
      return `Timer ${number} (${name}): finished ${formatSpanWords(now - timer.rungAtMs!)} ago, still ringing until dismissed.`;
    case "paused":
      return `Timer ${number} (${name}): paused with ${formatCountdown(timerRemainingMs(timer, now))} left.`;
    default:
      return `Timer ${number} (${name}): ${formatCountdown(timerRemainingMs(timer, now))} left, ends at ${formatClockAt(timer.endsAtMs!, twelveHour())}.`;
  }
}

function describeAlarm(alarm: Alarm, number: number, now: number): string {
  const time = formatTimeOfDay(alarm.hour, alarm.minute, twelveHour());
  const name = alarm.label ? ` (${alarm.label})` : "";
  if (alarm.ringingSinceMs !== null) return `Alarm ${number}: ${time}${name}, ringing now.`;
  if (!alarm.enabled) return `Alarm ${number}: ${time}${name}, ${formatDays(alarm.days).toLowerCase()}, off.`;
  const next = alarmNextRingMs(alarm, now);
  const when = next === null ? "" : `, rings in ${formatSpanWords(next - now)}`;
  const snoozed = alarm.snoozedUntilMs !== null ? " (snoozed)" : "";
  return `Alarm ${number}: ${time}${name}, ${formatDays(alarm.days).toLowerCase()}${when}${snoozed}.`;
}

/** Resolve a 1-based "timer"/"alarm" argument, or the only item when omitted. */
function pickItem<T>(items: T[], raw: unknown, noun: string, describe: (item: T, number: number) => string): T | ToolResult {
  if (items.length === 0) return { ok: false, error: `No ${noun}s are set.` };
  if (raw === undefined || raw === null) {
    if (items.length === 1) return items[0]!;
    return {
      ok: false,
      error: `There are ${items.length} ${noun}s; give the ${noun} number.\n${items.map(describe).join("\n")}`,
    };
  }
  const index = Math.floor(Number(raw));
  if (!Number.isFinite(index) || index < 1 || index > items.length) {
    return { ok: false, error: `No ${noun} ${raw}; there are ${items.length} ${noun}s.` };
  }
  return items[index - 1]!;
}

function isResult(value: unknown): value is ToolResult {
  return !!value && typeof value === "object" && "ok" in (value as object) && !("id" in (value as object));
}

function durationField(value: unknown, label: string): number {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid ${label} value: ${value}`);
  return parsed;
}

const NUMBER_ARG = (noun: string, listTool: string) => ({
  type: "number",
  description: `1-based ${noun} number, as shown by ${listTool}. May be omitted when only one ${noun} exists.`,
});

export function registerTimerTools(launchApp: (appId: string) => Promise<void>, registry: ToolRegistry = toolRegistry): void {
  if (registered) return;
  registered = true;

  const showApp = () => {
    void launchApp("timer").catch((error) => console.warn(`timer tool launch failed: ${error}`));
  };

  // --- timers ---

  registry.registerSystemTool(
    {
      name: "timer.set",
      description:
        "Start a countdown timer on the glasses. Give the duration as hours/minutes/seconds (at least one nonzero) and optionally a label such as \"pasta\". Returns the timer's number and when it will finish.",
      inputSchema: {
        type: "object",
        properties: {
          hours: { type: "number", description: "Hours component of the duration (default 0)." },
          minutes: { type: "number", description: "Minutes component of the duration (default 0)." },
          seconds: { type: "number", description: "Seconds component of the duration (default 0)." },
          label: { type: "string", description: "Optional short name for the timer." },
        },
        additionalProperties: false,
      },
      proactive: true,
    },
    (args) => {
      const durationMs = Math.round(
        ((durationField(args?.hours, "hours") * 60 + durationField(args?.minutes, "minutes")) * 60 +
          durationField(args?.seconds, "seconds")) *
          1000,
      );
      if (durationMs <= 0) return { ok: false, error: "timer.set requires a duration longer than zero." };
      if (durationMs > MAX_TIMER_DURATION_MS) return { ok: false, error: "Timers can run for at most 24 hours." };
      const label = typeof args?.label === "string" ? args.label.trim() : "";
      const timer = timerEngine.startTimer(durationMs, label);
      showApp();
      const number = listedTimers().indexOf(timer) + 1;
      return {
        ok: true,
        content: `Started a ${formatDurationWords(durationMs)} timer${label ? ` "${label}"` : ""} (timer ${number}), finishing at ${formatClockAt(timer.endsAtMs!, twelveHour())}.`,
      };
    },
  );

  registry.registerSystemTool(
    {
      name: "timer.list",
      description:
        "List the countdown timers on the glasses: each timer's number, name, time remaining (or paused / finished), and end time.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      proactive: true,
    },
    () => {
      const timers = listedTimers();
      if (timers.length === 0) return { ok: true, content: "No timers are set." };
      const now = Date.now();
      return { ok: true, content: timers.map((timer, index) => describeTimer(timer, index + 1, now)).join("\n") };
    },
  );

  registry.registerSystemTool(
    {
      name: "timer.cancel",
      description:
        "Cancel a countdown timer, or dismiss a finished one. Give the timer number from timer.list (omit it when only one exists), or all=true to clear every timer.",
      inputSchema: {
        type: "object",
        properties: {
          timer: NUMBER_ARG("timer", "timer.list"),
          all: { type: "boolean", description: "Clear all timers instead of a single one." },
        },
        additionalProperties: false,
      },
      proactive: true,
    },
    (args) => {
      const timers = listedTimers();
      if (args?.all === true) {
        if (timers.length === 0) return { ok: true, content: "No timers are set." };
        for (const timer of timers) timerEngine.removeTimer(timer.id);
        return { ok: true, content: timers.length === 1 ? "Cleared the timer." : `Cleared ${timers.length} timers.` };
      }
      const now = Date.now();
      const picked = pickItem(timers, args?.timer, "timer", (timer, number) => describeTimer(timer, number, now));
      if (isResult(picked)) return picked;
      const description = describeTimer(picked, timers.indexOf(picked) + 1, now);
      timerEngine.removeTimer(picked.id);
      return { ok: true, content: `${timerPhase(picked) === "rung" ? "Dismissed" : "Canceled"}: ${description}` };
    },
  );

  registry.registerSystemTool(
    {
      name: "timer.pause",
      description: "Pause a running countdown timer, or resume a paused one. Give the timer number from timer.list (omit it when only one exists).",
      inputSchema: {
        type: "object",
        properties: {
          timer: NUMBER_ARG("timer", "timer.list"),
          resume: { type: "boolean", description: "true to resume a paused timer instead of pausing." },
        },
        additionalProperties: false,
      },
      proactive: true,
    },
    (args) => {
      const timers = listedTimers();
      const now = Date.now();
      const picked = pickItem(timers, args?.timer, "timer", (timer, number) => describeTimer(timer, number, now));
      if (isResult(picked)) return picked;
      const phase = timerPhase(picked);
      if (phase === "rung") return { ok: false, error: "That timer has already finished; dismiss it with timer.cancel." };
      const resume = args?.resume === true || phase === "paused";
      if (resume) timerEngine.resumeTimer(picked.id);
      else timerEngine.pauseTimer(picked.id);
      const updated = timerEngine.findTimer(picked.id)!;
      return { ok: true, content: `${resume ? "Resumed" : "Paused"} ${describeTimer(updated, timers.indexOf(picked) + 1, Date.now())}` };
    },
  );

  registry.registerSystemTool(
    {
      name: "timer.add_time",
      description: "Add minutes to a countdown timer (a finished one restarts with just the added time). Give the timer number from timer.list (omit it when only one exists).",
      inputSchema: {
        type: "object",
        properties: {
          timer: NUMBER_ARG("timer", "timer.list"),
          minutes: { type: "number", description: "Minutes to add (default 1)." },
        },
        additionalProperties: false,
      },
      proactive: true,
    },
    (args) => {
      const timers = listedTimers();
      const now = Date.now();
      const picked = pickItem(timers, args?.timer, "timer", (timer, number) => describeTimer(timer, number, now));
      if (isResult(picked)) return picked;
      const minutes = args?.minutes === undefined ? 1 : Number(args.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) return { ok: false, error: `Invalid minutes value: ${args?.minutes}` };
      timerEngine.addTimerTime(picked.id, Math.round(minutes * 60_000));
      const updated = timerEngine.findTimer(picked.id)!;
      return { ok: true, content: `Added ${formatDurationWords(minutes * 60_000)}. ${describeTimer(updated, listedTimers().indexOf(updated) + 1, Date.now())}` };
    },
  );

  registry.registerSystemTool(
    {
      name: "timer.dismiss",
      description: "Stop whatever is ringing on the glasses right now: finished timers are cleared and ringing alarms dismissed.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      proactive: true,
    },
    () => {
      const count = timerEngine.dismissAllRinging();
      return { ok: true, content: count === 0 ? "Nothing is ringing." : `Dismissed ${count === 1 ? "it" : `${count} items`}.` };
    },
  );

  // --- stopwatch ---

  registry.registerSystemTool(
    {
      name: "stopwatch.control",
      description:
        "Control the stopwatch on the glasses: action start, stop, lap, reset, or read (report the elapsed time and laps without changing anything).",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "stop", "lap", "reset", "read"], description: "What to do." },
        },
        required: ["action"],
        additionalProperties: false,
      },
      proactive: true,
    },
    (args) => {
      const action = String(args?.action ?? "read");
      switch (action) {
        case "start":
          timerEngine.stopwatchStart();
          showApp();
          break;
        case "stop":
          timerEngine.stopwatchStop();
          break;
        case "lap":
          if (!stopwatchIsRunning(timerEngine.state.stopwatch)) return { ok: false, error: "The stopwatch is not running." };
          timerEngine.stopwatchLap();
          break;
        case "reset":
          timerEngine.stopwatchReset();
          break;
        case "read":
          break;
        default:
          return { ok: false, error: `Unknown stopwatch action: ${action}` };
      }
      const stopwatch = timerEngine.state.stopwatch;
      const elapsed = formatElapsed(stopwatchElapsedMs(stopwatch, Date.now()), true);
      const state = stopwatchIsRunning(stopwatch) ? "running" : "stopped";
      const laps = stopwatch.lapsMs.length > 0 ? ` Laps: ${stopwatch.lapsMs.map((lap) => formatElapsed(lap, true)).join(", ")}.` : "";
      return { ok: true, content: `Stopwatch ${state} at ${elapsed}.${laps}` };
    },
  );

  // --- alarms ---

  registry.registerSystemTool(
    {
      name: "alarm.set",
      description:
        "Set an alarm on the glasses. Give the time of day (e.g. \"7:30\", \"7:30 am\", \"19:30\"), optional repeat days (day names, \"weekdays\", \"weekends\", \"every day\"; default once), and an optional label.",
      inputSchema: {
        type: "object",
        properties: {
          time: { type: "string", description: "Time of day, 12- or 24-hour." },
          days: {
            type: "array",
            items: { type: "string" },
            description: "Repeat days: day names or weekdays / weekends / every day. Omit for a one-off alarm.",
          },
          label: { type: "string", description: "Optional short name for the alarm." },
        },
        required: ["time"],
        additionalProperties: false,
      },
      proactive: true,
    },
    (args) => {
      const time = parseTimeOfDay(String(args?.time ?? ""));
      if (!time) return { ok: false, error: `Could not understand the time "${args?.time}". Use a form like 7:30 am or 19:30.` };
      const days = parseRepeatDays(args?.days);
      if (days === null) return { ok: false, error: `Could not understand the repeat days ${JSON.stringify(args?.days)}.` };
      const label = typeof args?.label === "string" ? args.label.trim() : "";
      const alarm = timerEngine.addAlarm(time.hour, time.minute, days, label);
      showApp();
      const now = Date.now();
      return { ok: true, content: `Set. ${describeAlarm(alarm, listedAlarms().indexOf(alarm) + 1, now)}` };
    },
  );

  registry.registerSystemTool(
    {
      name: "alarm.list",
      description: "List the alarms on the glasses: each alarm's number, time, repeat days, label, and whether it is on.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      proactive: true,
    },
    () => {
      const alarms = listedAlarms();
      if (alarms.length === 0) return { ok: true, content: "No alarms are set." };
      const now = Date.now();
      return { ok: true, content: alarms.map((alarm, index) => describeAlarm(alarm, index + 1, now)).join("\n") };
    },
  );

  registry.registerSystemTool(
    {
      name: "alarm.enable",
      description: "Turn an alarm on or off without deleting it. Give the alarm number from alarm.list (omit it when only one exists).",
      inputSchema: {
        type: "object",
        properties: {
          alarm: NUMBER_ARG("alarm", "alarm.list"),
          enabled: { type: "boolean", description: "true to turn the alarm on, false to turn it off." },
        },
        required: ["enabled"],
        additionalProperties: false,
      },
      proactive: true,
    },
    (args) => {
      const alarms = listedAlarms();
      const now = Date.now();
      const picked = pickItem(alarms, args?.alarm, "alarm", (alarm, number) => describeAlarm(alarm, number, now));
      if (isResult(picked)) return picked;
      timerEngine.setAlarmEnabled(picked.id, args?.enabled !== false);
      const updated = timerEngine.findAlarm(picked.id)!;
      return { ok: true, content: describeAlarm(updated, alarms.indexOf(picked) + 1, Date.now()) };
    },
  );

  registry.registerSystemTool(
    {
      name: "alarm.delete",
      description: "Delete an alarm. Give the alarm number from alarm.list (omit it when only one exists).",
      inputSchema: {
        type: "object",
        properties: { alarm: NUMBER_ARG("alarm", "alarm.list") },
        additionalProperties: false,
      },
      proactive: true,
    },
    (args) => {
      const alarms = listedAlarms();
      const now = Date.now();
      const picked = pickItem(alarms, args?.alarm, "alarm", (alarm, number) => describeAlarm(alarm, number, now));
      if (isResult(picked)) return picked;
      const description = describeAlarm(picked, alarms.indexOf(picked) + 1, now);
      timerEngine.deleteAlarm(picked.id);
      return { ok: true, content: `Deleted: ${description}` };
    },
  );

  registry.registerSystemTool(
    {
      name: "alarm.snooze",
      description: "Snooze the alarm that is ringing now. Optionally give the snooze length in minutes (default: the Timers app's snooze setting).",
      inputSchema: {
        type: "object",
        properties: { minutes: { type: "number", description: "Snooze length in minutes." } },
        additionalProperties: false,
      },
      proactive: true,
    },
    (args) => {
      const ringing = timerEngine.state.alarms.filter((alarm) => alarm.ringingSinceMs !== null);
      if (ringing.length === 0) return { ok: false, error: "No alarm is ringing." };
      const minutes = args?.minutes === undefined ? undefined : Number(args.minutes);
      if (minutes !== undefined && (!Number.isFinite(minutes) || minutes <= 0)) return { ok: false, error: `Invalid minutes value: ${args?.minutes}` };
      for (const alarm of ringing) timerEngine.snoozeAlarm(alarm.id, minutes);
      const updated = timerEngine.findAlarm(ringing[0]!.id)!;
      return { ok: true, content: `Snoozed until ${formatClockAt(updated.snoozedUntilMs!, twelveHour())}.` };
    },
  );
}
