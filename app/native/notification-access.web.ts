export function isNotificationListenerEnabled(): boolean { return true; }
export function requestNotificationListenerAccess(): void {}
export function notificationEmptyMessage(): string { return "No notifications. Use “Send a notification” on this page."; }
export type NotificationListenerState = "connected" | "no-access" | "connecting" | "stuck";
export function notificationListenerState(): NotificationListenerState { return "connected"; }
export function watchNotificationListenerBinding(): void {}
