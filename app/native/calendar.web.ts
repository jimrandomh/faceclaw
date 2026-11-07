import { demoCalendarEvents } from "../web/demo-data/calendar";
import type { CalendarEvent, CalendarReadState } from "./calendar-types";

export type { CalendarEvent } from "./calendar-types";

const DEFAULT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export function onCalendarChanged(_listener: () => void): () => void { return () => {}; }
export function getCalendarReadState(): CalendarReadState { return "ready"; }
export function invalidateCalendarCache(): void {}

export function readUpcomingEvents(maxEvents = 50, windowMs = DEFAULT_WINDOW_MS, _forceRefresh = false): CalendarEvent[] {
  const now = Date.now();
  return demoCalendarEvents(now).filter((event) => event.endMs >= now && event.startMs <= now + windowMs).slice(0, maxEvents);
}

export async function readUpcomingEventsAsync(maxEvents = 50, windowMs = DEFAULT_WINDOW_MS): Promise<CalendarEvent[]> {
  return readUpcomingEvents(maxEvents, windowMs);
}
