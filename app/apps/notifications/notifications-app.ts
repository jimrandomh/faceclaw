import { NotificationsListLayer } from "../../ui/notifications";
import { NotificationFilterLayer } from "../../ui/notification-filter";
import { onAndroidNotificationPosted } from "../../native/notification-icons";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";

export const NOTIFICATIONS_WINDOW_ID = "notifications";
export const NOTIFICATIONS_SURFACE_ID = "window:notifications";

/**
 * The Notifications app: the Android-notification list (previously a
 * dashboard page) in its own in-process window; selecting a notification
 * opens the detail view with its quick actions.
 */
export function createNotificationsAppWindow(options: InProcessAppOptions): InProcessWindow {
  // Newly posted notifications repaint the list while the window is open.
  let offNotificationPosted: (() => void) | null = null;
  const created = createInProcessWindow({
    appId: "notifications",
    windowId: NOTIFICATIONS_WINDOW_ID,
    title: "Notifications",
    iconLetter: "N",
    icon: "bell",
    closeable: true,
    menuItems: () => [{
      label: "Notification filter",
      onSelect: (ctx) => {
        ctx.stack.pop();
        ctx.stack.push(new NotificationFilterLayer());
      },
    }],
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(new NotificationsListLayer()),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      offNotificationPosted?.();
      options.onClosed();
    },
  });
  offNotificationPosted = onAndroidNotificationPosted(() => created.requestRender());
  return created;
}
