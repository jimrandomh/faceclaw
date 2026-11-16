import { NotificationsListLayer } from "../../ui/notifications";
import { NOTIFICATIONS_SETTINGS_SECTION } from "../../ui/dashboard/settings-menus";
import { onAndroidNotificationsChanged } from "../../native/notification-icons";
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
 * opens the detail view with its quick actions. `openSettings` opens a
 * Settings section (the menu's "Settings" goes to Notifications).
 */
export function createNotificationsAppWindow(
  options: InProcessAppOptions,
  openSettings: (section: string) => void,
): InProcessWindow {
  // Newly posted notifications repaint the list while the window is open.
  let offNotificationsChanged: (() => void) | null = null;
  const created = createInProcessWindow({
    appId: "notifications",
    windowId: NOTIFICATIONS_WINDOW_ID,
    title: "Notifications",
    iconLetter: "N",
    icon: "bell",
    closeable: true,
    menuItems: () => [{
      label: "Settings",
      onSelect: (ctx) => {
        ctx.stack.pop();
        openSettings(NOTIFICATIONS_SETTINGS_SECTION);
      },
    }],
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(new NotificationsListLayer()),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      offNotificationsChanged?.();
      options.onClosed();
    },
  });
  offNotificationsChanged = onAndroidNotificationsChanged(() => created.requestRender());
  return created;
}
