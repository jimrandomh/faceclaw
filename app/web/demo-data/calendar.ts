import type { CalendarEvent } from "../../native/calendar-types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A plausible couple of weeks, laid out relative to whenever the page opened. */
export function demoCalendarEvents(now: number): CalendarEvent[] {
  const startOfDay = new Date(now).setHours(0, 0, 0, 0);
  const nextHour = Math.ceil(now / HOUR) * HOUR;
  const at = (day: number, hour: number, minutes = 0) => startOfDay + day * DAY + hour * HOUR + minutes * 60_000;
  const events: Omit<CalendarEvent, "id">[] = [
    { title: "Design review", startMs: nextHour, endMs: nextHour + HOUR, allDay: false, location: "Room 4", calendarName: "Work" },
    { title: "Coffee with Sam", startMs: nextHour + 2 * HOUR, endMs: nextHour + 2.5 * HOUR, allDay: false, location: "Blue Door Cafe", calendarName: "Personal" },
    { title: "Water the plants", startMs: startOfDay + DAY, endMs: startOfDay + 2 * DAY, allDay: true, location: "", calendarName: "Personal" },
    { title: "Team standup", startMs: at(1, 9, 30), endMs: at(1, 10), allDay: false, location: "", calendarName: "Work" },
    { title: "Dentist", startMs: at(1, 14), endMs: at(1, 15), allDay: false, location: "450 Sutter St", calendarName: "Personal" },
    { title: "Team standup", startMs: at(2, 9, 30), endMs: at(2, 10), allDay: false, location: "", calendarName: "Work" },
    { title: "Lunch and learn: display lists", startMs: at(2, 12), endMs: at(2, 13), allDay: false, location: "Atrium", calendarName: "Work" },
    { title: "Climbing", startMs: at(3, 18, 30), endMs: at(3, 20), allDay: false, location: "Mission Cliffs", calendarName: "Personal" },
    { title: "Trip to Portland", startMs: startOfDay + 5 * DAY, endMs: startOfDay + 8 * DAY, allDay: true, location: "", calendarName: "Personal" },
    { title: "Flight to PDX", startMs: at(5, 8, 15), endMs: at(5, 10, 5), allDay: false, location: "SFO Terminal 2", calendarName: "Personal" },
    { title: "Quarterly planning", startMs: at(9, 13), endMs: at(9, 16), allDay: false, location: "Room 1", calendarName: "Work" },
  ];
  return events.map((event, index) => ({ id: index + 1, ...event })).sort((a, b) => a.startMs - b.startMs);
}
