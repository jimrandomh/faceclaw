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

export function notificationEmptyMessage(): string {
  return isNotificationListenerEnabled() ? "No current Android notifications."
    : "Grant permission on your phone to view notifications on the glasses.";
}
