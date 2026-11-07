/** The demo's notifications (app/web/demo-data/notifications.ts), with the Pebble icons iOS uses. */
import type { GrayImage } from "../graphics/image";
import { pebbleIcon } from "../graphics/pebble-icons";
import { activeDemoNotifications, dismissDemoNotification, onDemoNotificationPosted, onDemoNotificationRemoved } from "../web/demo-data/notifications";
import { notificationAppIcon, notificationCategoryIcon } from "./notification-app-icons";
import { rememberNotificationSources } from "./notification-sources";
import type { AndroidNotification } from "./notification-types";

export type { AndroidNotification, AndroidNotificationAction } from "./notification-types";
export type NotificationIconsResult = { icons: GrayImage[]; keys: string[]; stale: boolean };
export type NotificationIconResult = { icon: GrayImage | null; stale: boolean };
export type NotificationImageResult = { image: GrayImage | null; stale: boolean };

export const ALL_NOTIFICATIONS = 0x7fffffff;

export function readActiveNotifications(maxNotifications = 50): AndroidNotification[] {
  const notifications = activeDemoNotifications(maxNotifications);
  rememberNotificationSources(notifications);
  return notifications;
}

export function invokeNotificationAction(key: string, _index: number): boolean {
  return dismissDemoNotification(key);
}

export const dismissNotification = dismissDemoNotification;
export const onAndroidNotificationPosted = onDemoNotificationPosted;
export const onAndroidNotificationRemoved = onDemoNotificationRemoved;

export function onAndroidNotificationsChanged(listener: () => void): () => void {
  const offPosted = onDemoNotificationPosted(listener);
  const offRemoved = onDemoNotificationRemoved(listener);
  return () => { offPosted(); offRemoved(); };
}

function notificationIcon(notification: AndroidNotification): GrayImage {
  return pebbleIcon(notificationAppIcon(notification.packageName, notification.appName) ?? notificationCategoryIcon(notification.category)).clone();
}

export function readActiveNotificationIcons(maxIcons: number, _allowStale: boolean): NotificationIconsResult {
  const sources = new Map<string, AndroidNotification>();
  for (const notification of activeDemoNotifications(ALL_NOTIFICATIONS)) {
    if (!sources.has(notification.packageName)) sources.set(notification.packageName, notification);
  }
  const shown = Array.from(sources.values()).slice(0, Math.max(0, maxIcons));
  return { icons: shown.map(notificationIcon), keys: shown.map((notification) => notification.key), stale: false };
}

export function readNotificationIconByKey(key: string, _allowStale: boolean): NotificationIconResult {
  const notification = activeDemoNotifications(ALL_NOTIFICATIONS).find((candidate) => candidate.key === key);
  return { icon: notification ? notificationIcon(notification) : null, stale: false };
}

export function readNotificationPicture(_notification: AndroidNotification, _maxWidth: number, _maxHeight: number, _allowStale: boolean): NotificationImageResult {
  return { image: null, stale: false };
}

export function readNotificationLargeIcon(_notification: AndroidNotification, _size: number, _allowStale: boolean): NotificationImageResult {
  return { image: null, stale: false };
}

export function readNotificationCustomView(_notification: AndroidNotification, _maxWidth: number, _maxHeight: number, _allowStale: boolean): NotificationImageResult {
  return { image: null, stale: false };
}
