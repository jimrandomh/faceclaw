import { Utils } from "@nativescript/core";
import { hasCalendarPermission } from "../g2/android-permissions";
import { spanCurrent } from "./frame-timings";
import { type CalendarEvent, type CalendarReadState } from "./calendar-types";
export type { CalendarEvent } from "./calendar-types";

declare const com: any;

/**
 * Reads upcoming calendar events through the Android Calendar provider
 * (FaceclawCalendarProvider). Results are cached briefly so repeated paints of
 * the Calendar app don't re-run the content-provider query every frame.
 */

// Android reads synchronously; iOS notifies subscribers after background reads.
export function onCalendarChanged(_listener: () => void): () => void { return () => {}; }
export function getCalendarReadState(): CalendarReadState { return "ready"; }

const DEFAULT_MAX_EVENTS = 50;
const DEFAULT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const CACHE_MS = 30_000;

let cache: { events: CalendarEvent[]; atMs: number; maxEvents: number; windowMs: number } | null = null;

/**
 * Upcoming events from now through the given window, ordered by start time.
 * Returns [] when calendar permission is absent. Cached for CACHE_MS; pass
 * forceRefresh to bypass the cache (e.g. right after the permission grant).
 */
export function readUpcomingEvents(
  maxEvents = DEFAULT_MAX_EVENTS,
  windowMs = DEFAULT_WINDOW_MS,
  forceRefresh = false,
): CalendarEvent[] {
  if (!global.isAndroid || !hasCalendarPermission()) return [];

  const now = Date.now();
  if (
    !forceRefresh &&
    cache &&
    cache.maxEvents === maxEvents &&
    cache.windowMs === windowMs &&
    now - cache.atMs < CACHE_MS
  ) {
    return cache.events;
  }

  const context = Utils.android.getApplicationContext();
  if (!context) return [];

  try {
    const json = spanCurrent("fetch-calendar-events", () =>
      String(
        com.faceclaw.app.FaceclawCalendarProvider.getUpcomingEventsJson(
          context,
          Math.max(0, Math.round(maxEvents)),
          Math.max(0, Math.round(windowMs)),
        ),
      ),
    );
    const parsed = JSON.parse(json);
    const events = Array.isArray(parsed)
      ? parsed.map(normalizeEvent).filter((event): event is CalendarEvent => Boolean(event))
      : [];
    cache = { events, atMs: now, maxEvents, windowMs };
    return events;
  } catch {
    return [];
  }
}

/** Awaitable API shared with the iOS background reader. */
export async function readUpcomingEventsAsync(maxEvents = DEFAULT_MAX_EVENTS, windowMs = DEFAULT_WINDOW_MS): Promise<CalendarEvent[]> {
  return readUpcomingEvents(maxEvents, windowMs);
}

/** Drop the cached events so the next read re-queries the provider. */
export function invalidateCalendarCache(): void {
  cache = null;
}

function normalizeEvent(value: any): CalendarEvent | null {
  if (!value || typeof value !== "object") return null;
  const startMs = Number(value.startMs);
  if (!Number.isFinite(startMs)) return null;
  return {
    id: Number(value.id) || 0,
    title: String(value.title ?? ""),
    startMs,
    endMs: Number(value.endMs) || startMs,
    allDay: Boolean(value.allDay),
    location: String(value.location ?? ""),
    calendarName: String(value.calendarName ?? ""),
  };
}
