import { ensureCalendarPermission, hasCalendarPermission } from "../../native/calendar-permissions";
import { invalidateCalendarCache, onCalendarChanged } from "../../native/calendar";
import { makeImageWindowIcon, windowIcon } from "../../ui/shell/chrome-layer";
import { CalendarLayer } from "./calendar";
import { renderCalendarDateIcon } from "./calendar-icon";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";

export const CALENDAR_WINDOW_ID = "calendar";
export const CALENDAR_SURFACE_ID = "window:calendar";

/**
 * The Calendar app: a single screen listing upcoming events from the phone's
 * calendars. If calendar permission is missing it shows a prompt and
 * fires the system permission dialog (on launch and on any tap); once granted
 * it re-renders with the event list.
 */
export function createCalendarAppWindow(options: InProcessAppOptions): InProcessWindow {
  let requesting = false;
  let app: InProcessWindow;
  let unsubscribe = () => {};
  let tick: ReturnType<typeof setInterval> | null = null;

  const requestPermission = () => {
    if (requesting || hasCalendarPermission()) return;
    requesting = true;
    void ensureCalendarPermission().then((granted) => {
      if (granted) {
        invalidateCalendarCache();
        app.requestRender();
      }
    }).catch(error => console.warn("Calendar permission failed", error))
      .finally(() => { requesting = false; });
  };

  app = createInProcessWindow({
    appId: "calendar",
    windowId: CALENDAR_WINDOW_ID,
    title: "Calendar",
    iconLetter: "Ca",
    icon: "calendar",
    drawIcon: makeImageWindowIcon(renderCalendarDateIcon, windowIcon("calendar", "Ca")),
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(new CalendarLayer(requestPermission)),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      unsubscribe();
      if (tick !== null) clearInterval(tick);
      options.onClosed();
    },
  });

  unsubscribe = onCalendarChanged(app.requestRender);
  tick = setInterval(app.requestRender, 30_000);
  // Prompt immediately on launch so the user doesn't have to discover the tap.
  requestPermission();
  return app;
}
