import { notificationListenerState, requestNotificationListenerAccess } from "../../native/notification-access";
import { type AppDefinition } from "../app-definition";
import { createNotificationsAppWindow, NOTIFICATIONS_SURFACE_ID, NOTIFICATIONS_WINDOW_ID } from "./notifications-app";

const notificationsApp: AppDefinition = {
  appId: "notifications",
  title: "Notifications",
  icon: "bell",
  launch: (ctx) => {
    // Without notification-listener access (or with a listener Android won't
    // rebind) the tray reads as empty; open the access screen on the phone so
    // the on-glasses message is actionable. The app still opens to show it.
    const listenerState = notificationListenerState();
    if (listenerState === "no-access" || listenerState === "stuck") {
      requestNotificationListenerAccess();
    }
    return ctx.launchInProcessApp(NOTIFICATIONS_WINDOW_ID, NOTIFICATIONS_SURFACE_ID, createNotificationsAppWindow);
  },
};

export default notificationsApp;
