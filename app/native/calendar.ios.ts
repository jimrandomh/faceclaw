import { hasCalendarPermission } from "./calendar-permissions";
import { type CalendarEvent, type CalendarReadState } from "./calendar-types";
export type { CalendarEvent } from "./calendar-types";

declare const FaceclawCalendar: any;

const DEFAULT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const CACHE_MS = 30_000;
type Cache = {
  events: CalendarEvent[];
  atMs: number;
  maxEvents: number;
  windowMs: number;
  state: CalendarReadState;
  pending: boolean;
};
let cache: Cache | null = null;
let bound = false;
const listeners = new Set<() => void>();

function calendar(): any {
  const bridge = FaceclawCalendar.shared();
  if (!bound) {
    bound = true;
    bridge.changeHandler = invalidateCalendarCache;
  }
  return bridge;
}

export function onCalendarChanged(listener: () => void): () => void {
  calendar();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyChanged(): void {
  for (const listener of listeners) listener();
}

export function invalidateCalendarCache(): void {
  // In-flight callbacks retain their old entry, so cannot restore invalid data.
  cache = null;
  notifyChanged();
}

export function getCalendarReadState(): CalendarReadState {
  return cache?.state ?? "ready";
}

/** Return cached events immediately, refreshing asynchronously when needed. */
export function readUpcomingEvents(maxEvents = 50, windowMs = DEFAULT_WINDOW_MS, forceRefresh = false): CalendarEvent[] {
  if (!hasCalendarPermission()) {
    cache = null;
    return [];
  }
  maxEvents = Number.isFinite(maxEvents) ? Math.min(200, Math.max(0, Math.round(maxEvents))) : 0;
  windowMs = Number.isFinite(windowMs) ? Math.min(366 * 24 * 60 * 60 * 1000, Math.max(0, Math.round(windowMs))) : 0;
  if (!maxEvents || !windowMs) return [];

  const now = Date.now();
  const sameQuery = cache?.maxEvents === maxEvents && cache?.windowMs === windowMs;
  if (!sameQuery || !cache!.pending && (forceRefresh || now - cache!.atMs >= CACHE_MS)) {
    const entry: Cache = {
      events: sameQuery ? cache!.events : [], atMs: now, maxEvents, windowMs,
      state: sameQuery && cache!.events.length ? "ready" : "loading", pending: true,
    };
    cache = entry;
    const finish = (json: string, error: string | null) => {
      if (cache !== entry) return;
      if (!hasCalendarPermission()) { invalidateCalendarCache(); return; }
      try {
        entry.events = parseEvents(json, error, maxEvents, now + windowMs);
        entry.state = "ready";
      } catch {
        entry.events = [];
        entry.state = "error";
      }
      entry.pending = false;
      entry.atMs = Date.now();
      notifyChanged();
    };
    try { calendar().readUpcomingEventsWindowMsCompletion(maxEvents, windowMs, finish); }
    catch { finish("[]", "Calendar unavailable"); }
  }
  return (cache?.events ?? []).filter(event => event.endMs > now);
}

/** Assistant queries await their own result without replacing the display cache. */
export async function readUpcomingEventsAsync(maxEvents = 50, windowMs = DEFAULT_WINDOW_MS): Promise<CalendarEvent[]> {
  if (!hasCalendarPermission()) throw new Error("Calendar permission is required.");
  maxEvents = Number.isFinite(maxEvents) ? Math.min(200, Math.max(0, Math.round(maxEvents))) : 0;
  windowMs = Number.isFinite(windowMs) ? Math.min(366 * 24 * 60 * 60 * 1000, Math.max(0, Math.round(windowMs))) : 0;
  if (!maxEvents || !windowMs) return [];
  const endMs = Date.now() + windowMs;
  return new Promise((resolve, reject) => {
    calendar().readUpcomingEventsWindowMsCompletion(maxEvents, windowMs, (json: string, error: string | null) => {
      try {
        if (!hasCalendarPermission()) throw new Error("Calendar permission is required.");
        resolve(parseEvents(json, error, maxEvents, endMs));
      } catch (error) { reject(error); }
    });
  });
}

function parseEvents(json: string, error: string | null, maxEvents: number, endMs: number): CalendarEvent[] {
  if (error) throw new Error(String(error));
  const rows = JSON.parse(String(json));
  if (!Array.isArray(rows)) throw new Error("Invalid calendar response");
  return rows.map(normalizeEvent).filter((event): event is CalendarEvent => event !== null)
    .filter(event => event.endMs > Date.now() && event.startMs < endMs)
    .sort((a, b) => a.startMs - b.startMs).slice(0, maxEvents);
}

function normalizeEvent(value: any): CalendarEvent | null {
  if (!value || typeof value !== "object" || typeof value.startMs !== "number" || typeof value.endMs !== "number" ||
      !Number.isFinite(value.startMs) || !Number.isFinite(value.endMs) || value.endMs < value.startMs) return null;
  return {
    id: String(value.id ?? ""), title: String(value.title ?? ""),
    startMs: value.startMs, endMs: value.endMs, allDay: Boolean(value.allDay),
    location: String(value.location ?? ""), calendarName: String(value.calendarName ?? ""),
  };
}
