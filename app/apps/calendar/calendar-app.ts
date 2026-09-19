import { ensureCalendarPermission, hasCalendarPermission } from "../../g2/android-permissions";
import { invalidateCalendarCache } from "../../native/calendar";
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
 * The Calendar app: a single screen listing upcoming events from the Android
 * Calendar provider. If calendar permission is missing it shows a prompt and
 * fires the system permission dialog (on launch and on any tap); once granted
 * it re-renders with the event list.
 */
export function createCalendarAppWindow(options: InProcessAppOptions): InProcessWindow {
  let requesting = false;
  let app: InProcessWindow;

  const requestPermission = () => {
    if (requesting || hasCalendarPermission()) return;
    requesting = true;
    void ensureCalendarPermission().then((granted) => {
      requesting = false;
      if (granted) {
        invalidateCalendarCache();
        app.requestRender();
      }
    });
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
    onClosed: options.onClosed,
  });

  // Prompt immediately on launch so the user doesn't have to discover the tap.
  requestPermission();
  return app;
}
