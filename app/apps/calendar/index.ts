import { type AppDefinition } from "../app-definition";
import { CALENDAR_SURFACE_ID, CALENDAR_WINDOW_ID, createCalendarAppWindow } from "./calendar-app";
import { renderCalendarDateIcon } from "./calendar-icon";

const calendarApp: AppDefinition = {
  appId: "calendar",
  title: "Calendar",
  icon: "calendar",
  renderIcon: renderCalendarDateIcon,
  launch: (ctx) => ctx.launchInProcessApp(CALENDAR_WINDOW_ID, CALENDAR_SURFACE_ID, createCalendarAppWindow),
};

export default calendarApp;
