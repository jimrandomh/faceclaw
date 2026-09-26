export type CalendarEvent = {
  /** Android event ID or EventKit event identifier. */
  id: number | string;
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  location: string;
  calendarName: string;
};

export type CalendarReadState = "ready" | "loading" | "error";
