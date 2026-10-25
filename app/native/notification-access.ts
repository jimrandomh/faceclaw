import { Utils } from "@nativescript/core";

declare const com: any;

/**
 * Notification-listener access ("read notifications") checks. Faceclaw reads
 * the phone's active notifications through
 * FaceclawMediaNotificationListenerService to mirror them onto the glasses
 * (top-bar icons and the Notifications app). That service only connects once
 * the user grants notification access in system settings; until then it never
 * binds, so getActiveNotifications() returns nothing and the mirror is blank.
 *
 * The underlying check/launch live in FaceclawEvenAppDetector (which also uses
 * them to detect the stock Even app's notification-service conflict); these are
 * thin wrappers so the Notifications app can gate on the permission without
 * reaching through the Even-app-conflict API.
 */

/** True when the user has granted Faceclaw notification-listener access. */
export function isNotificationListenerEnabled(): boolean {
  if (!global.isAndroid) return true;
  const context = Utils.android.getApplicationContext();
  if (!context) return false;
  return Boolean(com.faceclaw.app.FaceclawEvenAppDetector.isNotificationAccessEnabled(context));
}

/** Open the system screen where the user grants Faceclaw notification access. */
export function requestNotificationListenerAccess(): void {
  if (!global.isAndroid) return;
  const context = Utils.android.getApplicationContext();
  if (!context) return;
  com.faceclaw.app.FaceclawEvenAppDetector.openNotificationAccessSettings(context);
}

/**
 * Whether Android has the listener connected, and if not, why not:
 * "connecting" is access granted but not (yet, or again) bound; "stuck" is
 * still unbound after the native watchdog's forced rebinds, which only the
 * user toggling notification access is sure to fix.
 */
export type NotificationListenerState = "connected" | "no-access" | "connecting" | "stuck";

export function notificationListenerState(): NotificationListenerState {
  if (!global.isAndroid) return "connected";
  const context = Utils.android.getApplicationContext();
  if (!context) return "no-access";
  return String(
    com.faceclaw.app.FaceclawMediaNotificationListenerService.getListenerState(context),
  ) as NotificationListenerState;
}

/**
 * Start the native watchdog that rebinds the listener when Android drops it
 * while access is granted (see FaceclawMediaNotificationListenerService
 * .watchListenerBinding). Called once at boot.
 */
export function watchNotificationListenerBinding(): void {
  if (!global.isAndroid) return;
  const context = Utils.android.getApplicationContext();
  if (!context) return;
  com.faceclaw.app.FaceclawMediaNotificationListenerService.watchListenerBinding(context);
}

export function notificationEmptyMessage(): string {
  switch (notificationListenerState()) {
    case "no-access":
      return "Grant permission on your phone to view notifications on the glasses.";
    case "connecting":
      return "Connecting to Android notifications...";
    case "stuck":
      return "Android stopped sending notifications to Faceclaw. Turn Faceclaw's notification access off and on again in phone settings.";
    case "connected":
      return "No current Android notifications.";
  }
}
