import { readUpcomingEventsAsync, type CalendarEvent } from "../native/calendar";
import { hasCalendarPermission } from "../native/calendar-permissions";
import { mediaControllerBridge } from "../native/media-controller";
import { dismissNotification, readActiveNotifications } from "../native/notification-icons";
import { shell } from "../ui/shell/shell";
import { toolRegistry, type ToolRegistry, type ToolResult } from "./tool-registry";

/**
 * Registers the always-available system tools into the registry. Called once at
 * startup. These wrap shell state and the existing native bridges (calendar,
 * media, notifications); nothing here needs an app window to be open.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

let registered = false;

export function registerSystemTools(registry: ToolRegistry = toolRegistry): void {
  if (registered) return;
  registered = true;

  // Keep a media listener warm so "what's playing" works without opening Music.
  if (!global.isIOS) void mediaControllerBridge.start();

  registry.registerSystemTool(
    {
      name: "glasses.get_state",
      description:
        "Get the current state of the glasses: display on/off, foreground app, headset battery, and the current local time.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      proactive: true,
    },
    () => ok(describeState()),
  );

  registry.registerSystemTool(
    {
      name: "glasses.show_alert",
      description:
        "Show a short text popup on the glasses display. Use for a brief notice the user should see; keep it to a sentence or two.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "The message to display." } },
        required: ["text"],
        additionalProperties: false,
      },
      proactive: true,
    },
    (args) => {
      const text = String(args?.text ?? "").trim();
      if (!text) return err("show_alert requires non-empty text");
      shell.showAlert(text);
      return ok("Displayed.");
    },
  );

  registry.registerSystemTool(
    {
      name: "calendar.list_events",
      description:
        "List the user's upcoming calendar events. Returns events from now forward, ordered by start time.",
      inputSchema: {
        type: "object",
        properties: {
          within_hours: {
            type: "number",
            description: "Only include events starting within this many hours (default 168 = one week).",
          },
          max_events: { type: "number", description: "Maximum number of events to return (default 10)." },
        },
        additionalProperties: false,
      },
    },
    async (args) => {
      if (!hasCalendarPermission()) return err("Calendar access is not granted. Open Calendar or Permissions on your phone to allow access.");
      const withinHours = clampNumber(args?.within_hours, 1, 24 * 60, 168);
      const maxEvents = clampNumber(args?.max_events, 1, 50, 10);
      try {
        const events = await readUpcomingEventsAsync(maxEvents, withinHours * 60 * 60 * 1000);
        if (!events.length) return ok("No upcoming events in that window.");
        return ok(events.map(formatEvent).join("\n"));
      } catch {
        return err("Calendar events could not be read. Check calendar access on your phone and try again.");
      }
    },
  );

  // Phone media and Android notification tools are still platform-specific.
  if (global.isIOS) return;

  registry.registerSystemTool(
    {
      name: "media.now_playing",
      description: "What is currently playing (or paused) in the user's media app, if anything.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      proactive: true,
    },
    () => ok(describeNowPlaying()),
  );

  registry.registerSystemTool(
    {
      name: "media.play_pause",
      description: "Toggle play/pause for the user's current media session.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async () => {
      const state = mediaControllerBridge.snapshot();
      if (!state.canPlayPause) return err("No media session can be controlled right now.");
      await mediaControllerBridge.playPause();
      return ok("Toggled play/pause.");
    },
  );

  registry.registerSystemTool(
    {
      name: "media.next",
      description: "Skip to the next track in the user's current media session.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async () => {
      const state = mediaControllerBridge.snapshot();
      if (!state.canSkipNext) return err("The current media session can't skip to the next track.");
      await mediaControllerBridge.skipNext();
      return ok("Skipped to the next track.");
    },
  );

  registry.registerSystemTool(
    {
      name: "notifications.list",
      description: "List the user's current Android notifications mirrored to the glasses.",
      inputSchema: {
        type: "object",
        properties: { max: { type: "number", description: "Maximum notifications to return (default 10)." } },
        additionalProperties: false,
      },
    },
    (args) => {
      const max = clampNumber(args?.max, 1, 50, 10);
      const notifications = readActiveNotifications(max);
      if (!notifications.length) return ok("No current notifications.");
      return ok(notifications.map(formatNotification).join("\n"));
    },
  );

  registry.registerSystemTool(
    {
      name: "notifications.dismiss",
      description:
        "Dismiss a notification by its key (as returned by notifications.list). Returns whether it was dismissed.",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string", description: "The notification key from notifications.list." } },
        required: ["key"],
        additionalProperties: false,
      },
    },
    (args) => {
      const key = String(args?.key ?? "").trim();
      if (!key) return err("notifications.dismiss requires a key");
      return dismissNotification(key) ? ok("Dismissed.") : err("No notification with that key.");
    },
  );
}

function describeState(): string {
  const parts: string[] = [];
  parts.push(`Display: ${shell.isScreenOn() ? "on" : "off"}.`);
  const fg = shell.getForegroundApp();
  parts.push(fg ? `Foreground app: ${fg.appId} ("${fg.title}").` : "Foreground: launcher (no app open).");
  const battery = shell.getBatteryLevels();
  if (battery.headset !== null) {
    const charging = battery.headsetCharging ? ", charging" : "";
    parts.push(`Headset battery: ${battery.headset}%${charging}.`);
  }
  parts.push(`Local time: ${formatDateTime(new Date())}.`);
  return parts.join(" ");
}

function describeNowPlaying(): string {
  const state = mediaControllerBridge.snapshot();
  if (!state.accessEnabled) return "Notification access isn't granted, so media state is unavailable.";
  if (state.playbackState === "playing" || state.playbackState === "paused") {
    const verb = state.playbackState === "playing" ? "Playing" : "Paused";
    const title = state.title || "(unknown title)";
    const artist = state.artist ? ` by ${state.artist}` : "";
    const app = state.appName ? ` in ${state.appName}` : "";
    return `${verb}: ${title}${artist}${app}.`;
  }
  return "Nothing is currently playing.";
}

function formatEvent(event: CalendarEvent): string {
  const when = event.allDay ? `${formatDate(new Date(event.startMs))} (all day)` : formatDateTime(new Date(event.startMs));
  const location = event.location ? ` @ ${event.location}` : "";
  return `- ${event.title || "(untitled)"} — ${when}${location}`;
}

function formatNotification(notification: { key: string; appName: string; title: string; text: string }): string {
  const title = notification.title || "(no title)";
  const body = notification.text ? `: ${notification.text}` : "";
  return `- [${notification.appName}] ${title}${body} (key: ${notification.key})`;
}

function formatDateTime(date: Date): string {
  return `${formatDate(date)}, ${formatTime(date)}`;
}

function formatDate(date: Date): string {
  return `${WEEKDAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

function formatTime(date: Date): string {
  let hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const meridiem = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${hours}:${minutes} ${meridiem}`;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function ok(content: string): ToolResult {
  return { ok: true, content };
}

function err(error: string): ToolResult {
  return { ok: false, error };
}
